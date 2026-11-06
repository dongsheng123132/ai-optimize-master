// Turn scan findings into an ordered, reviewable plan.
// A plan never mutates anything. Every step carries a preview, a risk level and
// whether it can be undone. The whole plan hashes to a single planHash; apply
// refuses to run without the caller echoing that hash back.
import { sha256Hex, isInside, expandHome } from './util.mjs'
import { resolve } from 'node:path'

const RISK_ORDER = { low: 0, medium: 1, high: 2 }

/**
 * Supported step kinds in v0.2:
 *  - archive-skill: move a whole skill directory under the optimizer's archive root.
 * Only skills that (a) exist inside a declared skill root, (b) have a SKILL.md,
 * and (c) were explicitly selected by the caller are eligible. Everything else
 * stays read-only.
 */
export function buildPlan(scanResult, options = {}) {
  const {
    home = resolve(expandHome('~/.dsh-optimizer')),
    selections = [],
    includeFindings = true
  } = options

  const archiveRoot = resolve(home, 'archive')
  const steps = []
  const skipped = []

  const byName = new Map()
  for (const root of scanResult.roots ?? []) {
    for (const skill of root.skills ?? []) {
      const list = byName.get(skill.name) ?? []
      list.push({ root: root.id, rootDir: root.dir, ...skill })
      byName.set(skill.name, list)
    }
  }

  const duplicateInfo = new Map((scanResult.duplicates ?? []).map(d => [d.name, d]))

  for (const selection of selections) {
    const name = typeof selection === 'string' ? selection : selection?.name
    const wantedRoot = typeof selection === 'string' ? null : selection?.root
    const copies = byName.get(name) ?? []
    if (!copies.length) {
      skipped.push({ name, reason: 'no-such-skill' })
      continue
    }
    const chosen = wantedRoot ? copies.filter(c => c.root === wantedRoot) : copies
    if (chosen.length !== 1) {
      // Ambiguous or missing root: refuse rather than guess which copy to archive.
      skipped.push({ name, reason: chosen.length ? 'ambiguous-root' : 'root-has-no-copy', candidates: chosen.map(c => c.root) })
      continue
    }
    const target = chosen[0]
    if (!target.hasSkillMd) {
      skipped.push({ name, reason: 'no-skill-md' })
      continue
    }
    const dir = resolve(target.dir)
    if (!isInside(resolve(target.rootDir), dir)) {
      skipped.push({ name, reason: 'outside-skill-root' })
      continue
    }
    const duplicate = duplicateInfo.get(name)
    const risk = duplicate?.classification === 'identical-copies' ? 'low' : 'medium'
    const from = dir
    const to = resolve(archiveRoot, `${target.root}__${name}`)
    steps.push({
      id: `archive-skill:${target.root}:${name}`,
      kind: 'archive-skill',
      title: `Archive skill ${name} from ${target.root}`,
      preview: { from, to },
      risk,
      requiresAdmin: false,
      reversible: true,
      evidence: {
        skillMdHash: target.skillMdHash,
        duplicates: duplicate ? duplicate.classification : 'single-copy',
        brokenReferences: target.brokenReferences ?? []
      },
      rationale: duplicate
        ? 'Duplicate skill definition across tool roots; archive keeps a recoverable copy.'
        : 'Explicitly selected single-copy skill. Archiving is reversible, but review why it was selected.'
    })
  }

  // Deterministic order: risk first, then step id. Arrays keep this order by design.
  steps.sort((a, b) => (RISK_ORDER[a.risk] - RISK_ORDER[b.risk]) || a.id.localeCompare(b.id))

  const findings = includeFindings ? (scanResult.findings ?? []) : []
  const plan = {
    schema: 'dsh-optimizer/plan/v0.2',
    platform: scanResult.platform,
    archiveRoot,
    createdAt: new Date().toISOString(),
    steps,
    skipped,
    findingIds: findings.map(f => f.id)
  }
  plan.planHash = sha256Hex(plan)
  return plan
}

export function verifyPlanHash(plan) {
  const { planHash, ...rest } = plan
  return sha256Hex(rest) === planHash
}

/**
 * Apply a plan with journal + byte-exact undo.
 * Contracts (see README):
 *  - missing expect            -> exit 4 (denied)
 *  - planHash mismatch         -> exit 3 (diverged)
 *  - step above allowed risk   -> skipped, reported
 *  - requiresAdmin off-admin   -> blocked, no journal entry
 */
export async function applyPlan(plan, options) {
  const {
    expect,
    allow = 'low',
    journal,
    archive,
    verifyStep = null
  } = options

  if (!expect) {
    return { ok: false, code: 4, reason: 'missing-expected-plan-hash', journal: null }
  }
  if (!verifyPlanHash(plan) || plan.planHash !== expect) {
    return { ok: false, code: 3, reason: 'plan-diverged', journal: null }
  }

  const maxRisk = RISK_ORDER[allow] ?? 0
  const journalDoc = {
    schema: 'dsh-optimizer/journal/v0.2',
    planHash: plan.planHash,
    createdAt: new Date().toISOString(),
    steps: []
  }

  const results = []
  for (const step of plan.steps) {
    const risk = RISK_ORDER[step.risk] ?? 2
    if (risk > maxRisk) {
      results.push({ id: step.id, status: 'skipped', blocked: 'risk-not-allowed', risk: step.risk })
      continue
    }
    if (step.requiresAdmin && !options.isAdmin) {
      // O7: no journal entry when the step was never performed.
      results.push({ id: step.id, status: 'blocked', blocked: 'requires-admin' })
      continue
    }
    if (typeof verifyStep === 'function') {
      const check = await verifyStep(step)
      if (!check?.ok) {
        results.push({ id: step.id, status: 'blocked', blocked: check?.reason ?? 'verification-failed' })
        continue
      }
    }
    const executed = await archive(step)
    journalDoc.steps.push({
      id: step.id,
      kind: step.kind,
      before: executed.before,
      after: executed.after
    })
    results.push({ id: step.id, status: 'applied', ...executed.summary })
  }

  journalDoc.results = results
  await journal.write(journalDoc)
  const failures = results.filter(r => r.status !== 'applied' && r.status !== 'skipped')
  return {
    ok: failures.length === 0,
    code: failures.length === 0 ? 0 : 1,
    journal: journalDoc,
    results
  }
}

/**
 * Undo an applied journal in reverse order.
 * Undo must not clobber edits made after apply (review finding): if the current
 * content no longer matches what we wrote, the step becomes a conflict.
 */
export async function undoJournal(journalDoc, options) {
  const { restore, currentHash } = options
  const results = []
  for (const step of [...journalDoc.steps].reverse()) {
    const now = await currentHash(step.after.hashTarget ?? step.after.path)
    if (now !== step.after.hash) {
      results.push({ id: step.id, status: 'conflict', reason: 'content-changed-since-apply' })
      continue
    }
    await restore(step)
    results.push({ id: step.id, status: 'restored' })
  }
  const conflicts = results.filter(r => r.status === 'conflict')
  return { ok: conflicts.length === 0, code: conflicts.length === 0 ? 0 : 3, results }
}
