// Core contract tests. Each test is labelled with the requirement id it defends.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scan } from '../lib/scan.mjs'
import { buildPlan, applyPlan, undoJournal, verifyPlanHash } from '../lib/apply.mjs'
import { snapshotTree, snapshotEqual, sha256Hex, sha256Of, canonicalStringify } from '../lib/util.mjs'

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

// O6: journal is complete and undo restores byte-identical content.
test('O6 journal + byte-exact undo', async () => {
  const box = await sandbox()
  try {
    const root = join(box.root, 'skills')
    const dir = await makeSkill(root, 'alpha', '# alpha v1\n', { 'scripts/run.mjs': 'console.log(1)\n' })
    const originalSkillMd = await sha256Of(join(dir, 'SKILL.md'))
    const scanResult = await scan({ roots: [{ id: 'a', label: 'A', dir: root }], mcpConfigs: [], probes: false })
    const plan = buildPlan(scanResult, { home: join(box.root, 'opt'), selections: [{ name: 'alpha', root: 'a' }] })
    const archiveRoot = plan.archiveRoot
    const journal = {
      async write(doc) { await writeFile(join(box.root, 'journal.json'), JSON.stringify(doc), 'utf8'); return join(box.root, 'journal.json') }
    }
    const archive = async step => {
      const { from, to } = step.preview
      await mkdir(to, { recursive: true })
      await writeFile(join(to, 'SKILL.md'), await readFile(join(from, 'SKILL.md')))
      await rm(from, { recursive: true, force: true })
      return {
        before: { path: from, hash: step.evidence.skillMdHash },
        after: { path: to, hash: await sha256Of(join(to, 'SKILL.md')), hashTarget: join(to, 'SKILL.md') },
        summary: { from, to }
      }
    }
    const applied = await applyPlan(plan, { expect: plan.planHash, allow: 'medium', journal, archive })
    assert.equal(applied.code, 0)
    assert.equal(applied.journal.steps.length, 1)
    assert.ok(applied.journal.steps[0].before.hash)
    assert.ok(applied.journal.steps[0].after.hash)

    const undo = await undoJournal(applied.journal, {
      currentHash: sha256Of,
      restore: async step => {
        await mkdir(step.before.path, { recursive: true })
        await writeFile(join(step.before.path, 'SKILL.md'), await readFile(join(step.after.path, 'SKILL.md')))
        await rm(step.after.path, { recursive: true, force: true })
      }
    })
    assert.equal(undo.code, 0)
    assert.equal(await sha256Of(join(dir, 'SKILL.md')), originalSkillMd)
  } finally {
    await box.cleanup()
  }
})

// O7: an admin-only step is blocked without a journal entry.
test('O7 admin step never runs silently', async () => {
  const box = await sandbox()
  try {
    const root = join(box.root, 'skills')
    await makeSkill(root, 'alpha', '# alpha\n')
    const scanResult = await scan({ roots: [{ id: 'a', label: 'A', dir: root }], mcpConfigs: [], probes: false })
    const plan = buildPlan(scanResult, { home: join(box.root, 'opt'), selections: ['alpha'] })
    plan.steps[0].requiresAdmin = true
    // Re-hash because we changed the plan body on purpose.
    const { planHash, ...rest } = plan
    plan.planHash = sha256Hex(rest)
    const journalDocs = []
    const result = await applyPlan(plan, {
      expect: plan.planHash,
      allow: 'high',
      isAdmin: false,
      journal: { write: async doc => { journalDocs.push(doc) } },
      archive: async () => { throw new Error('must not archive') }
    })
    assert.equal(result.results[0].status, 'blocked')
    assert.equal(result.results[0].blocked, 'requires-admin')
    assert.equal(journalDocs[0].steps.length, 0, 'no journal entry for a step that never ran')
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
    const reordered = { steps: plan.steps, findingIds: plan.findingIds, skipped: plan.skipped, platform: plan.platform, schema: plan.schema }
    reordered.createdAt = plan.createdAt
    reordered.archiveRoot = plan.archiveRoot
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

// Extra: undo refuses to overwrite a file the user edited after apply.
test('undo reports conflict instead of clobbering', async () => {
  const box = await sandbox()
  try {
    const journalDoc = {
      planHash: 'x',
      steps: [{ id: 's1', before: { path: join(box.root, 'orig', 'SKILL.md'), hash: 'old' }, after: { path: join(box.root, 'arch', 'SKILL.md'), hash: 'new' } }]
    }
    await mkdir(join(box.root, 'arch'), { recursive: true })
    await writeFile(join(box.root, 'arch', 'SKILL.md'), '# edited by user\n', 'utf8')
    let restored = false
    const result = await undoJournal(journalDoc, {
      currentHash: async () => 'something-else',
      restore: async () => { restored = true }
    })
    assert.equal(result.code, 3)
    assert.equal(result.results[0].status, 'conflict')
    assert.equal(restored, false)
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
