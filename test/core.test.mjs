// Core contract tests. Each test is labelled with the requirement id it defends.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scan } from '../lib/scan.mjs'
import { buildPlan, applyPlan, undoJournal, verifyPlanHash } from '../lib/apply.mjs'
import { snapshotTree, snapshotEqual, sha256Hex, sha256Of, canonicalStringify } from '../lib/util.mjs'
import { buildManifest, manifestsEqual } from '../lib/manifest.mjs'

async function sandbox() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-optimizer-test-'))
  return { root, cleanup: () => rm(root, { recursive: true, force: true }) }
}

async function makeSkill(root, name, body, extra = {}) {
  const dir = join(root, name)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'SKILL.md'), body, 'utf8')
  for (const [file, content] of Object.entries(extra)) {
    await mkdir(join(dir, file.split('/').slice(0, -1).join('/')), { recursive: true })
    await writeFile(join(dir, file), content, 'utf8')
  }
  return dir
}

// O1: scan never writes — compare a full tree snapshot before and after.
test('O1 scan is read-only', async () => {
  const box = await sandbox()
  try {
    const rootA = join(box.root, 'skills-a')
    const rootB = join(box.root, 'skills-b')
    await makeSkill(rootA, 'alpha', '# alpha\nsee `scripts/run.mjs`\n')
    await makeSkill(rootB, 'alpha', '# alpha\nsee `scripts/run.mjs`\n')
    const before = await snapshotTree(box.root)
    await scan({
      roots: [{ id: 'a', label: 'A', dir: rootA }, { id: 'b', label: 'B', dir: rootB }],
      mcpConfigs: [],
      probes: false
    })
    const after = await snapshotTree(box.root)
    assert.ok(snapshotEqual(before, after), 'scan must not modify a single byte')
  } finally {
    await box.cleanup()
  }
})

// O2: an unreadable root is reported as not-applicable with a reason, and is
// never silently treated as "clean".
test('O2 not-run is not pass', async () => {
  const box = await sandbox()
  try {
    const result = await scan({
      roots: [{ id: 'missing', label: 'Missing', dir: join(box.root, 'does-not-exist') }],
      mcpConfigs: [],
      probes: false
    })
    const finding = result.findings.find(f => f.id === 'skill-root.unreadable:missing')
    assert.ok(finding, 'unreadable root must produce a finding')
    assert.equal(finding.applicable, false)
    assert.equal(finding.severity, 'info')
    assert.ok(finding.notApplicableReason, 'must explain why it did not run')
  } finally {
    await box.cleanup()
  }
})

// O3: a binary that exists but fails must not be reported as usable.
test('O3 existence is not usability', async () => {
  const box = await sandbox()
  try {
    const result = await scan({
      roots: [],
      mcpConfigs: [],
      probes: true,
      // A real executable that always exits non-zero: present, but not working.
      probesList: [{ id: 'broken-tool', command: process.execPath, args: ['-e', 'process.exit(7)'] }]
    })
    const finding = result.findings.find(f => f.id === 'tool.unusable:broken-tool')
    assert.ok(finding, 'a failing binary must produce an unusable finding')
    assert.equal(finding.current.found, true)
    assert.equal(finding.current.usable, false)
    assert.equal(finding.severity, 'medium')
    assert.match(finding.verified.evidence, /exit-7/)
    const text = JSON.stringify(result)
    assert.ok(!/broken-tool.*works|installed and usable/i.test(text), 'must not claim usability')
  } finally {
    await box.cleanup()
  }
})

// O4: apply without --expect is denied and changes nothing.
test('O4 apply without expect is denied', async () => {
  const box = await sandbox()
  try {
    const root = join(box.root, 'skills')
    const dir = await makeSkill(root, 'alpha', '# alpha\n')
    const scanResult = await scan({ roots: [{ id: 'a', label: 'A', dir: root }], mcpConfigs: [], probes: false })
    const plan = buildPlan(scanResult, { home: join(box.root, 'opt'), selections: ['alpha'] })
    const before = await snapshotTree(box.root)
    const result = await applyPlan(plan, {
      expect: null,
      journal: { write: async () => {} },
      archive: async () => { throw new Error('must not be called') }
    })
    assert.equal(result.code, 4)
    assert.equal(result.reason, 'missing-expected-plan-hash')
    assert.ok((await snapshotTree(box.root)).size === before.size)
    assert.ok(await readFile(join(dir, 'SKILL.md'), 'utf8'))
  } finally {
    await box.cleanup()
  }
})

// O5: a plan whose content no longer matches its hash is refused.
test('O5 stale plan hash is refused', async () => {
  const box = await sandbox()
  try {
    const root = join(box.root, 'skills')
    await makeSkill(root, 'alpha', '# alpha\n')
    const scanResult = await scan({ roots: [{ id: 'a', label: 'A', dir: root }], mcpConfigs: [], probes: false })
    const plan = buildPlan(scanResult, { home: join(box.root, 'opt'), selections: ['alpha'] })
    const tampered = JSON.parse(JSON.stringify(plan))
    tampered.steps[0].preview.to = join(box.root, 'elsewhere', 'alpha')
    const result = await applyPlan(tampered, {
      expect: plan.planHash,
      journal: { write: async () => {} },
      archive: async () => { throw new Error('must not be called') }
    })
    assert.equal(result.code, 3)
    assert.equal(result.reason, 'plan-diverged')
  } finally {
    await box.cleanup()
  }
})

// O6: journal is complete (with full manifests) and undo restores byte-identical content.
test('O6 journal + byte-exact undo', async () => {
  const box = await sandbox()
  try {
    const root = join(box.root, 'skills')
    const dir = await makeSkill(root, 'alpha', '# alpha v1\n', { 'scripts/run.mjs': 'console.log(1)\n' })
    const original = await buildManifest(dir)
    const scanResult = await scan({ roots: [{ id: 'a', label: 'A', dir: root }], mcpConfigs: [], probes: false })
    const plan = buildPlan(scanResult, { home: join(box.root, 'opt'), selections: [{ name: 'alpha', root: 'a' }] })
    const journalFile = join(box.root, 'journal.json')
    const journal = {
      async write(doc) { await writeFile(journalFile, JSON.stringify(doc), 'utf8'); return journalFile }
    }
    const applied = await applyPlan(plan, { expect: plan.planHash, allow: 'medium', journal })
    assert.equal(applied.code, 0, JSON.stringify(applied.results))
    assert.equal(applied.journal.steps.length, 1)
    const step = applied.journal.steps[0]
    assert.ok(step.before.manifest.entries.length >= 2, 'manifest covers every file, not just SKILL.md')
    assert.ok(step.after.digest, 'archive carries a manifest digest')
    assert.ok(!(await sha256Of(join(dir, 'SKILL.md'))), 'source removed after verified copy')

    const undo = await undoJournal(applied.journal, { journal })
    assert.equal(undo.code, 0)
    assert.equal(undo.results[0].status, 'restored')
    assert.ok(manifestsEqual(original, await buildManifest(dir)), 'restored tree must match the pre-apply manifest')
  } finally {
    await box.cleanup()
  }
})

// O7: an admin-only step is blocked and leaves no applied step in the journal.
test('O7 admin step never runs silently', async () => {
  const box = await sandbox()
  try {
    const root = join(box.root, 'skills')
    const dir = await makeSkill(root, 'alpha', '# alpha\n')
    const scanResult = await scan({ roots: [{ id: 'a', label: 'A', dir: root }], mcpConfigs: [], probes: false })
    const plan = buildPlan(scanResult, { home: join(box.root, 'opt'), selections: ['alpha'] })
    plan.steps[0].requiresAdmin = true
    const { planHash, ...rest } = plan
    plan.planHash = sha256Hex(rest)
    const writes = []
    const result = await applyPlan(plan, {
      expect: plan.planHash,
      allow: 'high',
      isAdmin: false,
      journal: { write: async doc => { writes.push(JSON.parse(JSON.stringify(doc))) } }
    })
    assert.equal(result.results[0].status, 'blocked')
    assert.equal(result.results[0].blocked, 'requires-admin')
    for (const doc of writes) assert.equal(doc.steps.length, 0, 'no applied step may be journaled')
    assert.ok(await readFile(join(dir, 'SKILL.md'), 'utf8'), 'blocked step must not move the source')
  } finally {
    await box.cleanup()
  }
})

// O9: any token estimate carries an estimator label.
test('O9 estimates are labelled', async () => {
  const box = await sandbox()
  try {
    const root = join(box.root, 'skills')
    await makeSkill(root, 'alpha', '# alpha\nsome body text\n')
    const result = await scan({ roots: [{ id: 'a', label: 'A', dir: root }], mcpConfigs: [], probes: false })
    assert.equal(result.roots[0].contextEstimate.estimator, 'bytes/4')
    assert.match(result.roots[0].contextEstimate.note, /Estimate/)
  } finally {
    await box.cleanup()
  }
})

// O10: plan hashing is key-order independent, value sensitive.
test('O10 planHash ignores key order but not values', async () => {
  const box = await sandbox()
  try {
    const root = join(box.root, 'skills')
    await makeSkill(root, 'alpha', '# alpha\n')
    const scanResult = await scan({ roots: [{ id: 'a', label: 'A', dir: root }], mcpConfigs: [], probes: false })
    const plan = buildPlan(scanResult, { home: join(box.root, 'opt'), selections: ['alpha'] })
    const { planHash, ...body } = plan
    // Same semantics, keys inserted in reverse order.
    const reordered = Object.fromEntries(Object.entries(body).reverse())
    assert.equal(sha256Hex(reordered), plan.planHash, 'same semantics, different key order => same hash')

    const changed = JSON.parse(JSON.stringify(reordered))
    changed.steps[0].preview.to = changed.steps[0].preview.to + '-x'
    assert.notEqual(sha256Hex(changed), plan.planHash, 'a value change must change the hash')
    assert.equal(canonicalStringify({ b: 1, a: 2 }), canonicalStringify({ a: 2, b: 1 }))
  } finally {
    await box.cleanup()
  }
})

// Extra: duplicate classification must separate identical from diverged content.
test('duplicates: identical vs diverged', async () => {
  const box = await sandbox()
  try {
    const rootA = join(box.root, 'a')
    const rootB = join(box.root, 'b')
    await makeSkill(rootA, 'same', '# same\n')
    await makeSkill(rootB, 'same', '# same\n')
    await makeSkill(rootA, 'diff', '# one\n')
    await makeSkill(rootB, 'diff', '# two\n')
    const result = await scan({
      roots: [{ id: 'a', label: 'A', dir: rootA }, { id: 'b', label: 'B', dir: rootB }],
      mcpConfigs: [],
      probes: false
    })
    const byName = Object.fromEntries(result.duplicates.map(d => [d.name, d.classification]))
    assert.equal(byName.same, 'identical-copies')
    assert.equal(byName.diff, 'diverged-copies')
  } finally {
    await box.cleanup()
  }
})

// Extra: undo refuses when the original path was re-created after apply.
test('undo reports conflict instead of clobbering', async () => {
  const box = await sandbox()
  try {
    const original = join(box.root, 'orig')
    const archived = join(box.root, 'arch')
    await makeSkill(box.root, 'orig', '# v1\n')
    await makeSkill(box.root, 'arch', '# v1\n')
    const before = await buildManifest(original)
    const after = await buildManifest(archived)
    // Simulate a user re-creating the original directory after apply.
    await writeFile(join(original, 'SKILL.md'), '# edited by user\n', 'utf8')
    const journalDoc = {
      planHash: 'x',
      steps: [{ id: 's1', kind: 'archive-skill', before: { path: original, manifest: before, digest: 'd1' }, after: { path: archived, manifest: after, digest: 'd2' } }]
    }
    const result = await undoJournal(journalDoc, {})
    assert.equal(result.code, 3)
    assert.equal(result.results[0].status, 'conflict')
    assert.equal(result.results[0].code, 'target-occupied')
    assert.equal(await readFile(join(original, 'SKILL.md'), 'utf8'), '# edited by user\n')
  } finally {
    await box.cleanup()
  }
})

// Extra: verifyPlanHash detects tampering.
test('verifyPlanHash detects tampering', async () => {
  const box = await sandbox()
  try {
    const root = join(box.root, 'skills')
    await makeSkill(root, 'alpha', '# alpha\n')
    const scanResult = await scan({ roots: [{ id: 'a', label: 'A', dir: root }], mcpConfigs: [], probes: false })
    const plan = buildPlan(scanResult, { home: join(box.root, 'opt'), selections: ['alpha'] })
    assert.equal(verifyPlanHash(plan), true)
    plan.steps[0].risk = 'high'
    assert.equal(verifyPlanHash(plan), false)
  } finally {
    await box.cleanup()
  }
})

// ——— Fixes required by the v0.2 code review ———

// Unknown risk/allow must be rejected, never silently treated as "low".
test('review: invalid allow value is rejected before any write', async () => {
  const box = await sandbox()
  try {
    const root = join(box.root, 'skills')
    await makeSkill(root, 'alpha', '# alpha\n')
    const scanResult = await scan({ roots: [{ id: 'a', label: 'A', dir: root }], mcpConfigs: [], probes: false })
    const plan = buildPlan(scanResult, { home: join(box.root, 'opt'), selections: ['alpha'] })
    const result = await applyPlan(plan, {
      expect: plan.planHash,
      allow: 'LOWWRITTEN',
      journal: { write: async () => { throw new Error('must not journal') } }
    })
    assert.equal(result.code, 1)
    assert.equal(result.reason, 'invalid-allow-value')
  } finally {
    await box.cleanup()
  }
})

test('review: an unvalidated risk value is rejected by plan validation', async () => {
  const box = await sandbox()
  try {
    const root = join(box.root, 'skills')
    await makeSkill(root, 'alpha', '# alpha\n')
    const scanResult = await scan({ roots: [{ id: 'a', label: 'A', dir: root }], mcpConfigs: [], probes: false })
    const plan = buildPlan(scanResult, { home: join(box.root, 'opt'), selections: ['alpha'] })
    plan.steps[0].risk = 'trivial'
    const { planHash, ...rest } = plan
    plan.planHash = sha256Hex(rest)
    const result = await applyPlan(plan, { expect: plan.planHash, allow: 'high', journal: { write: async () => {} } })
    assert.equal(result.code, 1)
    assert.ok(result.problems.includes('steps[0]:bad-risk'))
  } finally {
    await box.cleanup()
  }
})

test('review: an existing archive target is never merged into', async () => {
  const box = await sandbox()
  try {
    const root = join(box.root, 'skills')
    await makeSkill(root, 'alpha', '# alpha\n')
    const scanResult = await scan({ roots: [{ id: 'a', label: 'A', dir: root }], mcpConfigs: [], probes: false })
    const plan = buildPlan(scanResult, { home: join(box.root, 'opt'), selections: ['alpha'] })
    await makeSkill(join(box.root, 'opt', 'archive'), 'a__alpha', '# previous archive\n')
    const result = await applyPlan(plan, { expect: plan.planHash, allow: 'high', journal: { write: async () => {} } })
    assert.equal(result.results[0].status, 'blocked')
    assert.equal(result.results[0].blocked, 'archive-target-exists')
    assert.ok(await readFile(join(root, 'alpha', 'SKILL.md'), 'utf8'), 'source must stay put')
    assert.equal(await readFile(join(box.root, 'opt', 'archive', 'a__alpha', 'SKILL.md'), 'utf8'), '# previous archive\n')
  } finally {
    await box.cleanup()
  }
})

test('review: a symlinked skill is refused instead of followed', async () => {
  const box = await sandbox()
  try {
    const outside = join(box.root, 'outside')
    await makeSkill(outside, 'real', '# outside\n')
    const root = join(box.root, 'skills')
    await mkdir(root, { recursive: true })
    await symlink(join(outside, 'real'), join(root, 'linked'), 'dir')
    const scanResult = await scan({ roots: [{ id: 'a', label: 'A', dir: root }], mcpConfigs: [], probes: false })
    const plan = buildPlan(scanResult, { home: join(box.root, 'opt'), selections: ['linked'] })
    assert.equal(plan.steps.length, 0, 'symlinked skills must not become steps')
  } finally {
    await box.cleanup()
  }
})

test('review: a step outside the authorized roots is blocked at apply time', async () => {
  const box = await sandbox()
  try {
    const root = join(box.root, 'skills')
    await makeSkill(root, 'alpha', '# alpha\n')
    const scanResult = await scan({ roots: [{ id: 'a', label: 'A', dir: root }], mcpConfigs: [], probes: false })
    const plan = buildPlan(scanResult, { home: join(box.root, 'opt'), selections: ['alpha'] })
    // Model-supplied plan field tampering: point the source outside authorizedRoots.
    plan.authorizedRoots = [{ id: 'a', dir: join(box.root, 'somewhere-else') }]
    const { planHash, ...rest } = plan
    plan.planHash = sha256Hex(rest)
    const result = await applyPlan(plan, { expect: plan.planHash, allow: 'high', journal: { write: async () => {} } })
    assert.equal(result.results[0].blocked, 'source-outside-authorized-roots')
    assert.ok(await readFile(join(root, 'alpha', 'SKILL.md'), 'utf8'))
  } finally {
    await box.cleanup()
  }
})

test('review: a tampered archive is detected before restore', async () => {
  const box = await sandbox()
  try {
    const original = join(box.root, 'orig')
    const archived = join(box.root, 'arch')
    await makeSkill(box.root, 'orig', '# v1\n')
    await makeSkill(box.root, 'arch', '# v1\n')
    const before = await buildManifest(original)
    const after = await buildManifest(archived)
    // Someone modified the archive after apply.
    await writeFile(join(archived, 'SKILL.md'), '# tampered\n', 'utf8')
    const journalDoc = { planHash: 'x', steps: [{ id: 's1', kind: 'archive-skill', before: { path: original, manifest: before, digest: 'd1' }, after: { path: archived, manifest: after, digest: 'd2' } }] }
    const result = await undoJournal(journalDoc, {})
    assert.equal(result.results[0].code, 'archive-integrity-failed')
    assert.equal(result.code, 3)
  } finally {
    await box.cleanup()
  }
})

test('review: partial failure still leaves prior steps journaled', async () => {
  const box = await sandbox()
  try {
    const root = join(box.root, 'skills')
    await makeSkill(root, 'alpha', '# alpha\n')
    await makeSkill(root, 'beta', '# beta\n')
    const scanResult = await scan({ roots: [{ id: 'a', label: 'A', dir: root }], mcpConfigs: [], probes: false })
    const plan = buildPlan(scanResult, { home: join(box.root, 'opt'), selections: ['alpha', 'beta'] })
    // Pre-create the archive target of the second step so it fails.
    const second = plan.steps.find(s => s.id.endsWith(':beta'))
    await makeSkill(join(box.root, 'opt', 'archive'), 'a__beta', '# occupied\n')
    const writes = []
    const result = await applyPlan(plan, {
      expect: plan.planHash,
      allow: 'high',
      journal: { write: async doc => { writes.push(JSON.parse(JSON.stringify(doc))) } }
    })
    const statuses = Object.fromEntries(result.results.map(r => [r.id.split(':').pop(), r.status + (r.blocked ? `:${r.blocked}` : '')]))
    assert.equal(statuses.alpha, 'applied')
    assert.equal(statuses.beta, 'blocked:archive-target-exists')
    assert.ok(writes.some(doc => doc.steps.length === 1), 'the applied step must be journaled before the failure')
  } finally {
    await box.cleanup()
  }
})
