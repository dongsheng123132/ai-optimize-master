// O8: sandbox isolation + CLI contract.
// With DSH_OPTIMIZER_HOME pointed at a disposable directory, a full plan→apply
// cycle must touch nothing outside it. Files elsewhere under the fake HOME are
// compared byte-for-byte before and after.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { scan } from '../lib/scan.mjs'
import { snapshotTree, snapshotEqual, sha256Of } from '../lib/util.mjs'

const CLI = new URL('../bin/dsh-optimizer.mjs', import.meta.url).pathname

function run(args, env) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [CLI, ...args], { env: { ...process.env, ...env } })
    let out = ''
    let err = ''
    child.stdout.on('data', d => { out += d })
    child.stderr.on('data', d => { err += d })
    child.on('close', code => resolve({ code, out, err }))
  })
}

async function writeSkill(dir, name, body) {
  const skill = join(dir, name)
  await mkdir(skill, { recursive: true })
  await writeFile(join(skill, 'SKILL.md'), body, 'utf8')
}

test('O8 sandbox isolation across a full plan/apply cycle', async () => {
  const box = await mkdtemp(join(tmpdir(), 'dsh-optimizer-iso-'))
  try {
    const fakeHome = join(box, 'home')
    const skillRoot = join(fakeHome, 'tool-a', 'skills')
    const sandboxHome = join(box, 'optimizer-home')
    await mkdir(sandboxHome, { recursive: true })
    await writeSkill(skillRoot, 'alpha', '# alpha\n')
    await writeSkill(skillRoot, 'keep', '# keep\n')
    // A file outside any skill root that must never change.
    await writeFile(join(fakeHome, '.npmrc'), 'fund=false\n', 'utf8')
    await writeSkill(join(fakeHome, 'tool-b', 'skills'), 'alpha', '# alpha\n')

    const roots = [
      { id: 'a', label: 'A', dir: skillRoot },
      { id: 'b', label: 'B', dir: join(fakeHome, 'tool-b', 'skills') }
    ]
    const scanResult = await scan({ roots, mcpConfigs: [], probes: false })
    const scanFile = join(box, 'scan.json')
    const planFile = join(box, 'plan.json')
    await writeFile(scanFile, JSON.stringify(scanResult), 'utf8')

    const env = { DSH_OPTIMIZER_HOME: sandboxHome, HOME: fakeHome }

    const planned = await run(['plan', '--in', scanFile, '--select', 'alpha', '--root', 'a', '--out', planFile], env)
    assert.equal(planned.code, 0, planned.err)

    const plan = JSON.parse(await readFile(planFile, 'utf8'))
    assert.ok(plan.planHash, 'plan must carry a hash')
    assert.ok(plan.archiveRoot.startsWith(sandboxHome), 'archive root must live inside the optimizer home')

    const before = await snapshotTree(fakeHome)
    const npmrcBefore = await sha256Of(join(fakeHome, '.npmrc'))
    const keepBefore = await sha256Of(join(skillRoot, 'keep', 'SKILL.md'))

    const applied = await run(['apply', '--plan', planFile, '--expect', plan.planHash, '--allow', 'high', '--json'], env)
    assert.equal(applied.code, 0, applied.err)
    const result = JSON.parse(applied.out)
    assert.equal(result.code, 0)
    assert.ok(result.results.some(r => r.status === 'applied'))

    // The archived copy exists inside the sandbox home, not in the fake HOME.
    assert.equal(await sha256Of(join(sandboxHome, 'archive', 'a__alpha', 'SKILL.md')), await sha256Of(join(fakeHome, 'tool-b', 'skills', 'alpha', 'SKILL.md')))
    assert.equal(await sha256Of(join(fakeHome, '.npmrc')), npmrcBefore, '.npmrc must not change')
    assert.equal(await sha256Of(join(skillRoot, 'keep', 'SKILL.md')), keepBefore, 'untouched skill must not change')
    assert.ok(!(await snapshotEqual(before, await snapshotTree(fakeHome))), 'only the selected skill directory may disappear')

    // Journal is written inside the optimizer home, and undo restores the content.
    const journalFile = join(sandboxHome, 'journal', `${plan.planHash}.json`)
    const journal = JSON.parse(await readFile(journalFile, 'utf8'))
    assert.equal(journal.steps.length, 1)
    const undone = await run(['undo', '--journal', journalFile], env)
    assert.equal(undone.code, 0, undone.err)
    assert.equal(await sha256Of(join(skillRoot, 'alpha', 'SKILL.md')), await sha256Of(join(fakeHome, 'tool-b', 'skills', 'alpha', 'SKILL.md')))
  } finally {
    await rm(box, { recursive: true, force: true })
  }
})

test('CLI: apply without --expect exits 4', async () => {
  const box = await mkdtemp(join(tmpdir(), 'dsh-optimizer-cli-'))
  try {
    const planFile = join(box, 'plan.json')
    await writeFile(planFile, JSON.stringify({ schema: 'dsh-optimizer/plan/v0.2', steps: [], skipped: [], findingIds: [], planHash: 'deadbeef' }), 'utf8')
    const result = await run(['apply', '--plan', planFile, '--json'], { DSH_OPTIMIZER_HOME: join(box, 'home') })
    assert.equal(result.code, 4)
  } finally {
    await rm(box, { recursive: true, force: true })
  }
})

test('CLI: tampered plan exits 3', async () => {
  const box = await mkdtemp(join(tmpdir(), 'dsh-optimizer-cli-'))
  try {
    const planFile = join(box, 'plan.json')
    await writeFile(planFile, JSON.stringify({ schema: 'dsh-optimizer/plan/v0.2', steps: [{ id: 'x', kind: 'archive-skill', risk: 'low', requiresAdmin: false, preview: { from: '/tmp/a', to: '/tmp/b' } }], skipped: [], findingIds: [], planHash: 'not-the-real-hash' }), 'utf8')
    const result = await run(['apply', '--plan', planFile, '--expect', 'not-the-real-hash', '--json'], { DSH_OPTIMIZER_HOME: join(box, 'home') })
    assert.equal(result.code, 3)
  } finally {
    await rm(box, { recursive: true, force: true })
  }
})

test('CLI: scan --json is machine readable and read-only', async () => {
  const box = await mkdtemp(join(tmpdir(), 'dsh-optimizer-cli-'))
  try {
    const skillRoot = join(box, 'skills')
    await writeSkill(skillRoot, 'alpha', '# alpha\n`scripts/missing.mjs`\n')
    const before = await snapshotTree(box)
    const result = await run(['scan', '--json'], { DSH_OPTIMIZER_ROOTS: skillRoot, DSH_OPTIMIZER_HOME: join(box, 'home') })
    assert.equal(result.code, 0, result.err)
    const parsed = JSON.parse(result.out)
    assert.equal(parsed.readOnly, true)
    assert.ok(Array.isArray(parsed.findings))
    assert.ok(snapshotEqual(before, await snapshotTree(box)))
  } finally {
    await rm(box, { recursive: true, force: true })
  }
})
