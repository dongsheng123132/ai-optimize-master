// Turn scan findings into an ordered, reviewable plan; apply it under a
// hash-bound, journaled, reversible transaction.
import { resolve, sep, dirname } from 'node:path'
import { sha256Hex, isInside, expandHome, realpathOrNull } from './util.mjs'
import { archiveSkillDirectory, restoreSkillDirectory, pathState } from './archive.mjs'

const RISK_ORDER = { low: 0, medium: 1, high: 2 }
const VALID_RISK = new Set(Object.keys(RISK_ORDER))
const VALID_KINDS = new Set(['archive-skill'])

/**
 * Supported step kinds in v0.2:
 *  - archive-skill: move a whole skill directory under the optimizer's archive root.
 * Only skills that (a) exist inside a declared skill root, (b) have a SKILL.md,
 * and (c) were explicitly selected by the caller are eligible.
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
  const authorizedRoots = []
  for (const root of scanResult.roots ?? []) {
    authorizedRoots.push({ id: root.id, dir: resolve(root.dir) })
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
    steps.push({
      id: `archive-skill:${target.root}:${name}`,
      kind: 'archive-skill',
      title: `Archive skill ${name} from ${target.root}`,
      preview: { from: dir, to: resolve(archiveRoot, `${target.root}__${name}`) },
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

  steps.sort((a, b) => (RISK_ORDER[a.risk] - RISK_ORDER[b.risk]) || a.id.localeCompare(b.id))

  const findings = includeFindings ? (scanResult.findings ?? []) : []
  const plan = {
    schema: 'dsh-optimizer/plan/v0.2',
    platform: scanResult.platform,
    archiveRoot,
    authorizedRoots,
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
 * Structural validation. Unknown values are rejected, never treated as "low":
 * `RISK_ORDER[undefined] > 0` is false, so an unvalidated risk would slip through.
 */
export function validatePlan(plan) {
  const problems = []
  if (!plan || typeof plan !== 'object') return { ok: false, problems: ['plan-not-object'] }
  if (plan.schema !== 'dsh-optimizer/plan/v0.2') problems.push('bad-schema')
  if (typeof plan.planHash !== 'string' || !/^[0-9a-f]{64}$/.test(plan.planHash)) problems.push('bad-plan-hash')
  if (typeof plan.archiveRoot !== 'string' || !plan.archiveRoot) problems.push('missing-archive-root')
  if (!Array.isArray(plan.authorizedRoots) || !plan.authorizedRoots.length) problems.push('missing-authorized-roots')
  if (!Array.isArray(plan.steps)) problems.push('steps-not-array')
  for (const [index, step] of (plan.steps ?? []).entries()) {
    const where = `steps[${index}]`
    if (!step || typeof step !== 'object') { problems.push(`${where}:not-object`); continue }
    if (typeof step.id !== 'string' || !step.id) problems.push(`${where}:bad-id`)
    if (!VALID_KINDS.has(step.kind)) problems.push(`${where}:bad-kind`)
    if (!VALID_RISK.has(step.risk)) problems.push(`${where}:bad-risk`)
    if (typeof step.requiresAdmin !== 'boolean') problems.push(`${where}:bad-requires-admin`)
    if (!step.preview || typeof step.preview.from !== 'string' || typeof step.preview.to !== 'string') problems.push(`${where}:bad-preview`)
  }
  return { ok: problems.length === 0, problems }
}

async function authorizeStep(step, plan) {
  const from = resolve(step.preview.from)
  const to = resolve(step.preview.to)
  const archiveRoot = resolve(plan.archiveRoot)

  if (!isInside(archiveRoot, to)) return { ok: false, reason: 'archive-target-outside-root' }
  if (from === to) return { ok: false, reason: 'source-equals-target' }
  if (isInside(from, archiveRoot)) return { ok: false, reason: 'archive-inside-source' }

  const roots = plan.authorizedRoots.map(r => resolve(r.dir))
  if (!roots.some(root => isInside(root, from))) return { ok: false, reason: 'source-outside-authorized-roots' }

  // Symlinked ancestors can escape a prefix check; compare real paths when the
  // path already exists.
  const realFrom = await realpathOrNull(from)
  const realRoots = []
  for (const root of roots) realRoots.push(await realpathOrNull(root))
  if (realFrom && !realRoots.filter(Boolean).some(root => isInside(root, realFrom))) {
    return { ok: false, reason: 'source-realpath-outside-authorized-roots' }
  }
  const state = await pathState(from)
  if (state.symlink) return { ok: false, reason: 'source-is-symlink' }
  if (!state.exists) return { ok: false, reason: 'source-missing' }
  if (!state.directory) return { ok: false, reason: 'source-not-directory' }
  if ((await pathState(to)).exists) return { ok: false, reason: 'archive-target-exists' }
  return { ok: true }
}

/**
 * Apply a plan with a staged, journaled transaction.
 *  - missing expect        -> code 4 (denied)
 *  - planHash mismatch     -> code 3 (diverged)
 *  - invalid plan/shape    -> code 1 (usage) before any write
 *  - unknown risk/allow    -> rejected, never silently downgraded
 *  - intent is persisted before the first destructive operation
 *  - the journal is rewritten after every step, so a crash still leaves a record
 */
export async function applyPlan(plan, options) {
  const { expect, allow = 'low', journal, isAdmin = false } = options

  if (!expect) return { ok: false, code: 4, reason: 'missing-expected-plan-hash', journal: null }
  if (!VALID_RISK.has(allow)) return { ok: false, code: 1, reason: 'invalid-allow-value', journal: null }

  const validated = validatePlan(plan)
  if (!validated.ok) return { ok: false, code: 1, reason: 'invalid-plan', problems: validated.problems, journal: null }
  if (!verifyPlanHash(plan) || plan.planHash !== expect) return { ok: false, code: 3, reason: 'plan-diverged', journal: null }

  const maxRisk = RISK_ORDER[allow]
  const journalDoc = {
    schema: 'dsh-optimizer/journal/v0.2',
    planHash: plan.planHash,
    createdAt: new Date().toISOString(),
    archiveRoot: plan.archiveRoot,
    steps: [],
    results: []
  }

  // Persist intent before touching disk: a crash mid-run must be explainable.
  journalDoc.phase = 'intent'
  await journal.write(journalDoc)
  journalDoc.phase = 'running'

  for (const step of plan.steps) {
    const risk = RISK_ORDER[step.risk] ?? Infinity
    if (risk > maxRisk) {
      journalDoc.results.push({ id: step.id, status: 'skipped', blocked: 'risk-not-allowed', risk: step.risk })
      continue
    }
    if (step.requiresAdmin && !isAdmin) {
      journalDoc.results.push({ id: step.id, status: 'blocked', blocked: 'requires-admin' })
      continue
    }
    const authorization = await authorizeStep(step, plan)
    if (!authorization.ok) {
      journalDoc.results.push({ id: step.id, status: 'blocked', blocked: authorization.reason })
      continue
    }
    const outcome = await archiveSkillDirectory(step, plan.archiveRoot)
    if (outcome.code !== 'ok') {
      journalDoc.results.push({ id: step.id, status: 'blocked', blocked: outcome.code })
      await journal.write(journalDoc)
      continue
    }
    journalDoc.steps.push({
      id: step.id,
      kind: step.kind,
      before: outcome.before,
      after: outcome.after
    })
    journalDoc.results.push({ id: step.id, status: 'applied', from: step.preview.from, to: step.preview.to })
    // Rewrite after each step: a partial run is still recoverable.
    await journal.write(journalDoc)
  }

  journalDoc.phase = 'done'
  await journal.write(journalDoc)
  const failures = journalDoc.results.filter(r => r.status === 'blocked')
  return {
    ok: failures.length === 0,
    code: failures.length === 0 ? 0 : 1,
    journal: journalDoc,
    results: journalDoc.results
  }
}

/**
 * Undo an applied journal in reverse order.
 * Refuses to overwrite a target that was re-created after apply, verifies the
 * archived tree before restoring, and treats an already-restored step as done.
 */
export async function undoJournal(journalDoc, options = {}) {
  const { journal } = options
  const results = []
  const steps = [...(journalDoc.steps ?? [])].reverse()
  for (const step of steps) {
    const outcome = await restoreSkillDirectory(step)
    results.push({ id: step.id, status: outcome.code === 'ok' ? 'restored' : (outcome.code === 'already-restored' ? 'already-restored' : 'conflict'), code: outcome.code, detail: outcome.detail })
    if (journal) {
      journalDoc.results = [...(journalDoc.results ?? []), ...results]
      journalDoc.phase = 'undoing'
      await journal.write(journalDoc)
      journalDoc.results = journalDoc.results.slice(0, -(results.length))
    }
  }
  if (journal) {
    journalDoc.results = [...(journalDoc.results ?? []), ...results]
    journalDoc.phase = 'undone'
    await journal.write(journalDoc)
  }
  const conflicts = results.filter(r => r.status === 'conflict')
  return { ok: conflicts.length === 0, code: conflicts.length === 0 ? 0 : 3, results }
}

export { RISK_ORDER }
