// Evolve = read-only improvement proposals + change detection (v0.3).
//
// What this module will NOT do (std review, 2026-11-06):
//  - delete a dangling reference automatically (a missing file may be generated later)
//  - rewrite SKILL.md with a model (behaviour gain is unverifiable, privacy/prompt-injection risk)
//  - convert identical copies into symlinks (changes path resolution and installer behaviour)
//
// It produces evidence + a diff, and leaves execution to the existing hash-bound
// plan/apply path, which the caller must still approve.
import { readTextIfExists } from './util.mjs'

const REF_LINE = /^.*`((?:scripts|references|examples|assets|templates|docs)\/[^`\s)]+)`.*$/gm
const WIN_PATH = /([A-Za-z]:\\[^\s`'"）)]+)/g

function lineOf(text, index) {
  return text.slice(0, index).split('\n').length
}

/**
 * Build proposals from a scan result.
 * Every proposal carries: skill, root, kind, evidence, suggestion, diff, and
 * `apply: 'manual'` — there is no auto-apply path for these in v0.3.
 */
export async function propose(scanResult) {
  const proposals = []
  for (const root of scanResult.roots ?? []) {
    for (const skill of root.skills ?? []) {
      if (!skill.hasSkillMd) continue
      const file = skill.dir.endsWith('SKILL.md') ? skill.dir : `${skill.dir}/SKILL.md`
      const text = await readTextIfExists(file)
      if (text === null) continue

      // 1) Dangling local references: report, never delete.
      for (const broken of skill.brokenReferences ?? []) {
        const re = new RegExp(`^.*\`${escapeRe(broken)}\`.*$`, 'm')
        const match = re.exec(text)
        proposals.push({
          id: `proposal:broken-reference:${root.id}:${skill.name}:${broken}`,
          skill: skill.name,
          root: root.id,
          kind: 'broken-reference',
          risk: 'medium',
          apply: 'manual',
          evidence: { missing: broken, line: match ? lineOf(text, match.index) : null, file },
          suggestion: 'Either restore the referenced file or remove the instruction that points at it. Confirm which one is true for this skill before editing.',
          diff: match ? `- ${match[0].trim()}\n+ (remove only if the referenced file is not generated at runtime)` : null,
          note: 'A missing file only proves it cannot be resolved now; it does not prove the instruction is wrong.'
        })
      }

      // 2) Windows-only absolute paths on a POSIX host: propose portable form.
      if (process.platform !== 'win32') {
        const seen = new Set()
        for (const match of text.matchAll(WIN_PATH)) {
          const raw = match[1]
          if (seen.has(raw)) continue
          seen.add(raw)
          proposals.push({
            id: `proposal:platform-path:${root.id}:${skill.name}:${hashish(raw)}`,
            skill: skill.name,
            root: root.id,
            kind: 'platform-path',
            risk: 'low',
            apply: 'manual',
            evidence: { path: raw, line: lineOf(text, match.index) },
            suggestion: 'Replace the hard-coded Windows path with an environment-driven path. Note that `$HOME`/`~` are not expanded identically by every agent, so verify the target interpreter before editing.',
            diff: `- ${raw}\n+ <portable path or environment variable, verified against the consuming agent>`
          })
        }
      }
    }
  }

  // 3) Duplicate groups: report only. Content equality does not authorise merging.
  for (const duplicate of scanResult.duplicates ?? []) {
    proposals.push({
      id: `proposal:duplicate:${duplicate.name}`,
      skill: duplicate.name,
      root: null,
      kind: 'duplicate',
      risk: 'medium',
      apply: 'manual',
      evidence: { classification: duplicate.classification, copies: duplicate.copies.map(c => ({ root: c.root, dir: c.dir })) },
      suggestion: duplicate.classification === 'identical-copies'
        ? 'Pick one copy to own future edits, or move to a canonical source with links. Byte equality today does not promise equal upgrades later.'
        : 'The copies already diverge. Diff them and decide which one is authoritative before touching either.',
      diff: null
    })
  }

  return {
    schema: 'ai-optimize-master/evolve/v0.3',
    platform: scanResult.platform,
    generatedAt: new Date().toISOString(),
    readOnly: true,
    counts: proposals.reduce((acc, p) => { acc[p.kind] = (acc[p.kind] ?? 0) + 1; return acc }, {}),
    proposals
  }
}

/** Compare two scan results and report what appeared / disappeared. */
export function compareScans(baseline, current) {
  const key = finding => finding.id
  const before = new Map((baseline.findings ?? []).map(f => [key(f), f]))
  const after = new Map((current.findings ?? []).map(f => [key(f), f]))
  const added = [...after.keys()].filter(id => !before.has(id))
  const resolved = [...before.keys()].filter(id => !after.has(id))
  const skillCount = result => (result.roots ?? []).reduce((n, r) => n + (r.skillCount ?? 0), 0)
  return {
    schema: 'ai-optimize-master/change/v0.3',
    baselineAt: baseline.scannedAt ?? null,
    currentAt: current.scannedAt ?? null,
    skillCountBefore: skillCount(baseline),
    skillCountAfter: skillCount(current),
    added: added.map(id => after.get(id)).map(f => ({ id: f.id, title: f.title, severity: f.severity })),
    resolved: resolved.map(id => before.get(id)).map(f => ({ id: f.id, title: f.title, severity: f.severity }))
  }
}

function escapeRe(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function hashish(value) {
  let hash = 0
  for (const char of value) hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  return hash.toString(16)
}
