// evolve contract: proposals only, never edits, always labelled manual.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scan } from '../lib/scan.mjs'
import { propose, compareScans } from '../lib/evolve.mjs'
import { snapshotTree, snapshotEqual } from '../lib/util.mjs'

async function sandbox() {
  const root = await mkdtemp(join(tmpdir(), 'ai-optimize-master-evolve-'))
  return { root, cleanup: () => rm(root, { recursive: true, force: true }) }
}

async function makeSkill(root, name, body) {
  const dir = join(root, name)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'SKILL.md'), body, 'utf8')
  return dir
}

test('evolve: proposes, never edits the inspected tree', async () => {
  const box = await sandbox()
  try {
    const root = join(box.root, 'skills')
    await makeSkill(root, 'alpha', '# alpha\nread `scripts/missing.mjs` now\n')
    const scanResult = await scan({ roots: [{ id: 'a', label: 'A', dir: root }], mcpConfigs: [], probes: false })
    const before = await snapshotTree(box.root)
    const report = await propose(scanResult)
    assert.equal(report.readOnly, true)
    assert.ok(report.proposals.length >= 1)
    for (const proposal of report.proposals) assert.equal(proposal.apply, 'manual', 'no proposal may auto-apply')
    assert.ok(snapshotEqual(before, await snapshotTree(box.root)), 'evolve must not write')
  } finally {
    await box.cleanup()
  }
})

test('evolve: a dangling reference becomes evidence + diff, not a deletion order', async () => {
  const box = await sandbox()
  try {
    const root = join(box.root, 'skills')
    await makeSkill(root, 'alpha', '# alpha\nline one\nread `scripts/missing.mjs` now\nline three\n')
    const scanResult = await scan({ roots: [{ id: 'a', label: 'A', dir: root }], mcpConfigs: [], probes: false })
    const report = await propose(scanResult)
    const proposal = report.proposals.find(p => p.kind === 'broken-reference')
    assert.ok(proposal, 'broken reference must be proposed')
    assert.match(proposal.evidence.missing, /scripts\/missing\.mjs/)
    assert.equal(proposal.evidence.line, 3)
    assert.match(proposal.suggestion, /restore .* or remove/i)
    assert.match(proposal.note, /does not prove/i)
    assert.equal(proposal.apply, 'manual')
  } finally {
    await box.cleanup()
  }
})

test('evolve: hard-coded Windows paths are proposed as review items', async () => {
  const box = await sandbox()
  try {
    const root = join(box.root, 'skills')
    await makeSkill(root, 'beta', '# beta\nrun C:\\Windows\\System32\\cmd.exe /c dir\n')
    const scanResult = await scan({ roots: [{ id: 'a', label: 'A', dir: root }], mcpConfigs: [], probes: false })
    const report = await propose(scanResult)
    const proposal = report.proposals.find(p => p.kind === 'platform-path')
    if (process.platform === 'win32') {
      assert.equal(proposal, undefined)
    } else {
      assert.ok(proposal, 'posix host must flag Windows absolute paths')
      assert.match(proposal.suggestion, /environment-driven/i)
      assert.match(proposal.suggestion, /not expanded identically/i)
    }
  } finally {
    await box.cleanup()
  }
})

test('evolve: identical copies are reported, never auto-merged', async () => {
  const box = await sandbox()
  try {
    const a = join(box.root, 'a')
    const b = join(box.root, 'b')
    await makeSkill(a, 'same', '# same\n')
    await makeSkill(b, 'same', '# same\n')
    const scanResult = await scan({
      roots: [{ id: 'a', label: 'A', dir: a }, { id: 'b', label: 'B', dir: b }],
      mcpConfigs: [],
      probes: false
    })
    const report = await propose(scanResult)
    const proposal = report.proposals.find(p => p.kind === 'duplicate')
    assert.ok(proposal)
    assert.equal(proposal.apply, 'manual')
    assert.match(proposal.suggestion, /byte equality/i)
  } finally {
    await box.cleanup()
  }
})

test('change detection: new and resolved findings are separated', async () => {
  const box = await sandbox()
  try {
    const root = join(box.root, 'skills')
    await makeSkill(root, 'alpha', '# alpha\n')
    const baseline = await scan({ roots: [{ id: 'a', label: 'A', dir: root }], mcpConfigs: [], probes: false })
    await makeSkill(root, 'beta', '# beta\nread `scripts/gone.mjs`\n')
    const current = await scan({ roots: [{ id: 'a', label: 'A', dir: root }], mcpConfigs: [], probes: false })
    const changes = compareScans(baseline, current)
    assert.ok(changes.added.some(f => f.id === 'skills.broken-references'), 'new broken ref must show as added')
    assert.equal(changes.skillCountAfter, changes.skillCountBefore + 1)
  } finally {
    await box.cleanup()
  }
})

test('CLI evolve --json is machine readable and writes nothing by default', async () => {
  const box = await sandbox()
  try {
    const root = join(box.root, 'skills')
    await makeSkill(root, 'alpha', '# alpha\nread `scripts/missing.mjs`\n')
    const { spawn } = await import('node:child_process')
    const before = await snapshotTree(box.root)
    const result = await new Promise(resolve => {
      const child = spawn(process.execPath, [new URL('../bin/dsh-optimizer.mjs', import.meta.url).pathname, 'evolve', '--json'], {
        env: { ...process.env, DSH_OPTIMIZER_ROOTS: root, DSH_OPTIMIZER_HOME: join(box.root, 'home') }
      })
      let out = ''
      let err = ''
      child.stdout.on('data', d => { out += d })
      child.stderr.on('data', d => { err += d })
      child.on('close', code => resolve({ code, out, err }))
    })
    assert.equal(result.code, 0, result.err)
    const report = JSON.parse(result.out)
    assert.equal(report.readOnly, true)
    assert.ok(report.proposals.some(p => p.kind === 'broken-reference'))
    assert.ok(snapshotEqual(before, await snapshotTree(box.root)), 'evolve must not create files')
  } finally {
    await box.cleanup()
  }
})
