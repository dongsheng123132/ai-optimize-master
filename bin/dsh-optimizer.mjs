#!/usr/bin/env node
// CLI entry. Exit codes are part of the contract:
//   0 success | 1 usage/runtime failure | 3 diverged | 4 denied
import { readFile, writeFile, mkdir, cp, rename, rm } from 'node:fs/promises'
import { join, resolve, dirname } from 'node:path'
import { scan } from '../lib/scan.mjs'
import { buildPlan, applyPlan, undoJournal } from '../lib/apply.mjs'
import { home, sha256Of, sha256Hex, expandHome, parseBool, isInside } from '../lib/util.mjs'

function usage() {
  return `dsh-optimizer v0.2.0 — inventory and reversible cleanup for AI tool assets

Usage:
  dsh-optimizer scan  [--json] [--roots a:b] [--no-probes]
  dsh-optimizer plan  [--select name]... [--root id]... [--in FILE] [--out FILE] [--json]
  dsh-optimizer apply --plan FILE --expect HASH [--allow low|medium|high] [--json]
  dsh-optimizer undo  --journal FILE [--json]

Exit codes: 0 ok · 1 usage/runtime error · 3 diverged · 4 denied

Safety:
  - scan is strictly read-only.
  - plan never mutates anything.
  - apply requires --expect with the exact plan hash and journals every change.
  - Only skills that live inside a declared skill root can be archived.
`
}

function parseArgs(argv) {
  const args = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]
    if (!token.startsWith('--')) { args._.push(token); continue }
    const key = token.slice(2)
    const next = argv[i + 1]
    if (next === undefined || next.startsWith('--')) { args[key] = true; continue }
    if (args[key] === undefined) args[key] = next
    else (Array.isArray(args[key]) ? args[key] : (args[key] = [args[key]])).push(next)
    i++
  }
  return args
}

function toList(value) {
  if (value === undefined) return []
  return Array.isArray(value) ? value : [value]
}

async function readJson(file) {
  return JSON.parse(await readFile(expandHome(file), 'utf8'))
}

async function ensureDir(dir) {
  await mkdir(dir, { recursive: true })
}

function journalWriter(root) {
  return {
    async write(doc) {
      await ensureDir(root)
      const file = join(root, `${doc.planHash}.json`)
      await writeFile(file, JSON.stringify(doc, null, 2), 'utf8')
      return file
    }
  }
}

// Archive = move the whole skill directory into the optimizer's own archive root.
// Before-images are captured as content hashes plus a byte copy, so undo is exact.
function archiveStep(archiveRoot) {
  return async step => {
    const { from, to } = step.preview
    await ensureDir(dirname(to))
    await cp(from, to, { recursive: true, errorOnExist: false, force: false })
    const skillMd = join(to, 'SKILL.md')
    const beforeHash = step.evidence?.skillMdHash ?? null
    await rm(from, { recursive: true, force: true })
    return {
      before: { path: from, hash: beforeHash },
      after: { path: to, hash: await sha256Of(skillMd), hashTarget: skillMd },
      summary: { from, to }
    }
  }
}

async function cmdScan(args) {
  const roots = toList(args.roots).flatMap(v => String(v).split(process.platform === 'win32' ? ';' : ':'))
    .filter(Boolean)
    .map(dir => ({ id: `extra:${dir.split(/[\\/]/).pop()}`, label: `Extra root ${dir}`, dir }))
  const result = await scan({
    roots: roots.length ? [...(await import('../lib/scan.mjs')).defaultRoots(), ...roots] : undefined,
    probes: !args['no-probes']
  })
  if (args.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  else process.stdout.write(renderScan(result))
  return 0
}

function renderScan(result) {
  const lines = []
  lines.push(`AI tool inventory (${result.platform}) — read-only`)
  lines.push('')
  for (const root of result.roots) {
    if (!root.applicable) { lines.push(`  ${root.label}: ${root.notApplicableReason}`); continue }
    lines.push(`  ${root.label.padEnd(28)} ${String(root.skillCount).padStart(3)} skills  ${root.dir}`)
  }
  const counts = result.findings.reduce((acc, f) => { acc[f.severity] = (acc[f.severity] ?? 0) + 1; return acc }, {})
  lines.push('')
  lines.push(`Findings: ${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(' · ') || 'none'}`)
  for (const f of result.findings.filter(f => f.severity !== 'info')) lines.push(`  [${f.severity}] ${f.title}`)
  lines.push('')
  lines.push(`Duplicates: ${result.duplicates.length} (identical ${result.duplicates.filter(d => d.classification === 'identical-copies').length})`)
  lines.push(`MCP declarations: ${result.mcp.map(m => `${m.id}=${m.servers.length}`).join(' ') || 'none'}`)
  return `${lines.join('\n')}\n`
}

async function cmdPlan(args) {
  const scanResult = args.in ? await readJson(args.in) : await scan({ probes: false })
  const names = toList(args.select)
  const roots = toList(args.root)
  const selections = names.map((name, index) => roots[index] ? { name, root: roots[index] } : name)
  const plan = buildPlan(scanResult, { selections, home: home() })
  const archiveRoot = plan.archiveRoot
  if (args.out) {
    await ensureDir(dirname(resolve(expandHome(args.out))))
    await writeFile(expandHome(args.out), JSON.stringify(plan, null, 2), 'utf8')
  }
  if (args.json) process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`)
  else {
    const lines = [`Plan ${plan.planHash}`, `Archive root: ${archiveRoot}`, `Steps: ${plan.steps.length}`]
    for (const step of plan.steps) lines.push(`  [${step.risk}] ${step.id}  ${step.preview.from} -> ${step.preview.to}`)
    for (const skip of plan.skipped) lines.push(`  skipped ${skip.name}: ${skip.reason}`)
    lines.push('', 'Apply with:', `  dsh-optimizer apply --plan <file> --expect ${plan.planHash}`)
    process.stdout.write(`${lines.join('\n')}\n`)
  }
  return 0
}

async function cmdApply(args) {
  if (!args.plan) { process.stderr.write('apply requires --plan\n'); return 1 }
  const plan = await readJson(args.plan)
  const journalRoot = join(home(), 'journal')
  const result = await applyPlan(plan, {
    expect: typeof args.expect === 'string' ? args.expect : null,
    allow: typeof args.allow === 'string' ? args.allow : 'low',
    journal: journalWriter(journalRoot),
    archive: archiveStep(plan.archiveRoot ?? join(home(), 'archive')),
    isAdmin: process.platform !== 'win32' ? typeof process.getuid === 'function' && process.getuid() === 0 : undefined
  })
  if (args.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  else {
    for (const step of result.results ?? []) process.stdout.write(`${step.status.padEnd(8)} ${step.id}${step.blocked ? ` (${step.blocked})` : ''}\n`)
    if (result.reason) process.stderr.write(`${result.reason}\n`)
  }
  return result.code
}

async function cmdUndo(args) {
  if (!args.journal) { process.stderr.write('undo requires --journal\n'); return 1 }
  const doc = await readJson(args.journal)
  const result = await undoJournal(doc, {
    currentHash: sha256Of,
    restore: async step => {
      const { before, after } = step
      await cp(after.path, before.path, { recursive: true, force: true })
      await rm(after.path, { recursive: true, force: true })
    }
  })
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  return result.code
}

const commands = { scan: cmdScan, plan: cmdPlan, apply: cmdApply, undo: cmdUndo }

async function main() {
  const argv = process.argv.slice(2)
  const command = argv[0]
  if (!command || command === '--help' || command === '-h' || command === 'help') {
    process.stdout.write(usage())
    return 0
  }
  const handler = commands[command]
  if (!handler) { process.stderr.write(`unknown command: ${command}\n\n${usage()}`); return 1 }
  try {
    return await handler(parseArgs(argv.slice(1)))
  } catch (error) {
    process.stderr.write(`dsh-optimizer ${command} failed: ${error?.message ?? error}\n`)
    return 1
  }
}

process.exitCode = await main()
