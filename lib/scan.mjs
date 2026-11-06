// Read-only inventory of AI-tool assets: skill roots, skill duplication, broken
// local references, MCP configuration surfaces, and tool versions.
// Invariant (O1): this module never writes. It only reads files and runs the
// small set of version probes named in PROBES.
import { readdir, stat } from 'node:fs/promises'
import { join, basename } from 'node:path'
import { homedir } from 'node:os'
import { readTextIfExists, sha256Hex, expandHome } from './util.mjs'

// Version probes are an allowlist, not a shell: we only ever spawn these names.
// A binary that exists but fails to run must NOT be reported as usable (O3).
const PROBES = [
  { id: 'node', command: 'node', args: ['--version'] },
  { id: 'git', command: 'git', args: ['--version'] },
  { id: 'pwsh', command: process.platform === 'win32' ? 'pwsh' : 'pwsh', args: ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major'] },
  { id: 'claude', command: 'claude', args: ['--version'] },
  { id: 'codex', command: 'codex', args: ['--version'] }
]

// Known skill roots. Order matters only for reporting; nothing is prioritised.
export function defaultRoots(platform = process.platform) {
  const home = homedir()
  const roots = [
    { id: 'dsh', label: 'DeepSeek Harness', dir: join(home, '.dsh', 'skills') },
    { id: 'agents', label: 'Agent Skills (cross-tool)', dir: join(home, '.agents', 'skills') },
    { id: 'claude', label: 'Claude Code', dir: join(home, '.claude', 'skills') },
    { id: 'codex', label: 'Codex CLI', dir: join(home, '.codex', 'skills') },
    { id: 'openclaw', label: 'OpenClaw / ClawX', dir: join(home, '.openclaw', 'skills') },
    { id: 'cursor', label: 'Cursor', dir: join(home, '.cursor', 'skills') },
    { id: 'uking', label: 'U-King', dir: join(home, '.uking', 'skills') }
  ]
  // Optional extra roots (e.g. a shared workstation tree on Windows) come from
  // DSH_OPTIMIZER_ROOTS as a path-delimited list; we never guess drive letters.
  for (const extra of (process.env.DSH_OPTIMIZER_ROOTS ?? '').split(process.platform === 'win32' ? ';' : ':').filter(Boolean)) {
    roots.push({ id: `extra:${basename(extra)}`, label: `Extra root ${extra}`, dir: expandHome(extra) })
  }
  return roots
}

export function defaultMcpConfigs(platform = process.platform) {
  const home = homedir()
  return [
    { id: 'claude', label: 'Claude Code', file: join(home, '.claude.json') },
    { id: 'codex', label: 'Codex CLI', file: join(home, '.codex', 'config.toml') },
    { id: 'cursor', label: 'Cursor', file: join(home, '.cursor', 'mcp.json') }
  ]
}

async function listSkillDirs(rootDir) {
  let items
  try {
    items = await readdir(rootDir, { withFileTypes: true })
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'EACCES' || error?.code === 'EPERM') return { skills: [], error: error.code }
    throw error
  }
  const skills = []
  for (const item of items) {
    if (!item.isDirectory()) continue
    const dir = join(rootDir, item.name)
    const skillMd = join(dir, 'SKILL.md')
    const text = await readTextIfExists(skillMd)
    if (text === null) {
      skills.push({ name: item.name, dir, hasSkillMd: false, skillMdHash: null, bytes: 0 })
      continue
    }
    skills.push({ name: item.name, dir, hasSkillMd: true, skillMdHash: sha256Hex(text), bytes: Buffer.byteLength(text) })
  }
  return { skills }
}

// Relative local references such as `scripts/foo.mjs` or `references/bar.md`
// that the skill body tells an agent to open.
const REF_RE = /`((?:scripts|references|examples|assets|templates|docs)\/[^`\s)]+)`/g

async function checkReferences(dir, text) {
  const broken = []
  const seen = new Set()
  for (const match of text.matchAll(REF_RE)) {
    const ref = match[1]
    if (seen.has(ref)) continue
    seen.add(ref)
    if (ref.includes('*') || ref.includes('<') || ref.endsWith('/')) continue
    try {
      await stat(join(dir, ref))
    } catch {
      broken.push(ref)
    }
  }
  return broken
}

// A skill that hardcodes Windows-only absolute paths while being read on POSIX
// is a portability smell, never an automatic deletion (it may target a remote host).
function platformHints(text, platform) {
  const hints = []
  if (/[A-Za-z]:\\\\|\\bC:\\\\Users\\\\|\\bD:\\\\/.test(text)) hints.push('windows-absolute-paths')
  if (platform !== 'win32' && hints.length) hints.push('read-on-non-windows')
  return hints
}

async function probeTools(probes = PROBES) {
  const { spawn } = await import('node:child_process')
  const results = []
  for (const probe of probes) {
    const result = await new Promise(resolve => {
      let settled = false
      const done = value => { if (!settled) { settled = true; resolve(value) } }
      try {
        const child = spawn(probe.command, probe.args, { stdio: ['ignore', 'pipe', 'pipe'] })
        let out = ''
        let err = ''
        child.stdout.on('data', d => { out += d })
        child.stderr.on('data', d => { err += d })
        child.on('error', error => done({ id: probe.id, found: false, ran: false, reason: error.code === 'ENOENT' ? 'not-on-path' : String(error.code ?? error.message) }))
        child.on('close', code => {
          const text = (out || err).trim()
          if (code === 0 && text) done({ id: probe.id, found: true, ran: true, version: text.split(/\r?\n/)[0].slice(0, 80) })
          else done({ id: probe.id, found: true, ran: false, reason: code === 0 ? 'empty-output' : `exit-${code}` })
        })
        setTimeout(() => { try { child.kill('SIGKILL') } catch {} ; done({ id: probe.id, found: true, ran: false, reason: 'timeout' }) }, 5000)
      } catch (error) {
        done({ id: probe.id, found: false, ran: false, reason: String(error.message) })
      }
    })
    results.push(result)
  }
  return results
}

function parseMcpSurface(id, text) {
  if (text === null) return { id, present: false, servers: [], parsable: false }
  if (id === 'codex') {
    // TOML: count [mcp_servers.<name>] tables without a TOML dependency.
    const servers = [...text.matchAll(/^\[mcp_servers\.([^\]]+)\]/gm)].map(m => m[1].replace(/^["']|["']$/g, ''))
    return { id, present: true, servers: [...new Set(servers)], parsable: true, format: 'toml' }
  }
  try {
    const json = JSON.parse(text)
    const servers = Object.keys(json?.mcpServers ?? {})
    return { id, present: true, servers, parsable: true, format: 'json' }
  } catch {
    return { id, present: true, servers: [], parsable: false, format: 'json' }
  }
}

export async function scan(options = {}) {
  const platform = options.platform ?? process.platform
  const roots = options.roots ?? defaultRoots(platform)
  const mcpConfigs = options.mcpConfigs ?? defaultMcpConfigs(platform)
  const includeProbes = options.probes !== false

  const inventories = []
  const bySkillName = new Map()

  for (const root of roots) {
    const { skills, error } = await listSkillDirs(root.dir)
    const rootResult = {
      id: root.id,
      label: root.label,
      dir: root.dir,
      applicable: error === undefined,
      notApplicableReason: error ? `unreadable: ${error}` : null,
      skillCount: skills.length,
      skills: []
    }
    for (const skill of skills) {
      const record = {
        name: skill.name,
        dir: skill.dir,
        hasSkillMd: skill.hasSkillMd,
        skillMdHash: skill.skillMdHash,
        bytes: skill.bytes,
        brokenReferences: [],
        platformHints: []
      }
      if (skill.hasSkillMd) {
        const text = await readTextIfExists(join(skill.dir, 'SKILL.md'))
        record.brokenReferences = await checkReferences(skill.dir, text)
        record.platformHints = platformHints(text, platform)
      }
      rootResult.skills.push(record)
      const list = bySkillName.get(skill.name) ?? []
      list.push({ root: root.id, rootLabel: root.label, ...record })
      bySkillName.set(skill.name, list)
    }
    // Context weight is what the agent pays every session. The estimate is
    // explicitly labelled: bytes/4 is a heuristic, never a measured token count (O9).
    rootResult.contextBytes = rootResult.skills.reduce((n, s) => n + (s.bytes ?? 0), 0)
    rootResult.contextEstimate = {
      value: Math.round(rootResult.contextBytes / 4),
      estimator: 'bytes/4',
      note: 'Estimate, not a measured tokenizer count.'
    }
    inventories.push(rootResult)
  }

  // Duplicate analysis distinguishes "same name" from "same content".
  const duplicates = []
  for (const [name, copies] of bySkillName) {
    if (copies.length < 2) continue
    const hashes = new Set(copies.map(c => c.skillMdHash).filter(Boolean))
    const identical = hashes.size === 1 && copies.every(c => c.hasSkillMd)
    duplicates.push({
      name,
      copies: copies.map(c => ({ root: c.root, rootLabel: c.rootLabel, dir: c.dir, skillMdHash: c.skillMdHash })),
      classification: identical ? 'identical-copies' : 'diverged-copies',
      note: identical
        ? 'Same SKILL.md content in several tool roots. Duplicate definition only; it does not prove any copy is unused.'
        : 'Same skill name but different SKILL.md content. Divergence must be reviewed before any cleanup.'
    })
  }

  const mcp = []
  for (const config of mcpConfigs) {
    const text = await readTextIfExists(config.file)
    mcp.push({ ...parseMcpSurface(config.id, text), label: config.label, file: config.file })
  }

  const tools = includeProbes ? await probeTools(options.probesList ?? PROBES) : []

  const findings = buildFindings({ inventories, duplicates, mcp, tools, platform })

  return {
    schema: 'dsh-optimizer/scan/v0.2',
    platform,
    scannedAt: new Date().toISOString(),
    readOnly: true,
    roots: inventories,
    duplicates,
    mcp,
    tools,
    findings
  }
}

function finding(id, title, severity, platform, extra = {}) {
  return {
    id,
    title,
    severity,
    platform,
    applicable: extra.applicable ?? true,
    notApplicableReason: extra.notApplicableReason ?? null,
    verified: extra.verified ?? { method: 'read-file', evidence: '' },
    current: extra.current ?? null,
    recommended: extra.recommended ?? null,
    remediation: extra.remediation ?? null
  }
}

function buildFindings({ inventories, duplicates, mcp, tools, platform }) {
  const findings = []

  // Unreadable roots must say so; "could not read" is never "clean" (O2).
  for (const root of inventories) {
    if (!root.applicable) {
      findings.push(finding(
        `skill-root.unreadable:${root.id}`,
        `Skill root ${root.label} cannot be read`,
        'info',
        platform,
        {
          applicable: false,
          notApplicableReason: root.notApplicableReason,
          verified: { method: 'read-file', evidence: root.notApplicableReason },
          current: root.dir
        }
      ))
    }
  }

  const identical = duplicates.filter(d => d.classification === 'identical-copies')
  if (identical.length) {
    findings.push(finding(
      'skills.identical-duplicates',
      `${identical.length} skill name(s) exist as byte-identical copies in several tool roots`,
      'info',
      platform,
      {
        verified: { method: 'read-file', evidence: `${identical.length} groups share one SKILL.md hash` },
        current: identical.map(d => ({ name: d.name, copies: d.copies.length })),
        recommended: 'Review the owning tool for each copy before archiving. Identical content does not prove a copy is unused.',
        remediation: null
      }
    ))
  }

  const diverged = duplicates.filter(d => d.classification === 'diverged-copies')
  if (diverged.length) {
    findings.push(finding(
      'skills.diverged-duplicates',
      `${diverged.length} skill name(s) exist with different content across roots`,
      'medium',
      platform,
      {
        verified: { method: 'read-file', evidence: `${diverged.length} groups have more than one SKILL.md hash` },
        current: diverged.map(d => ({ name: d.name, hashes: new Set(d.copies.map(c => c.skillMdHash)).size })),
        recommended: 'Decide a single source of truth per skill; do not archive until the divergent copy is reviewed.'
      }
    ))
  }

  const broken = []
  for (const root of inventories) {
    for (const skill of root.skills) {
      if (skill.brokenReferences.length) broken.push({ root: root.id, name: skill.name, missing: skill.brokenReferences })
    }
  }
  if (broken.length) {
    findings.push(finding(
      'skills.broken-references',
      `${broken.length} skill(s) reference local files that do not exist`,
      'medium',
      platform,
      {
        verified: { method: 'read-file', evidence: `${broken.length} skill(s) with at least one missing relative reference` },
        current: broken,
        recommended: 'Repair the path or remove the dangling instruction. A skill that points at missing files misleads the agent.'
      }
    ))
  }

  const missingSkillMd = []
  for (const root of inventories) {
    for (const skill of root.skills) {
      if (!skill.hasSkillMd) missingSkillMd.push({ root: root.id, name: skill.name, dir: skill.dir })
    }
  }
  if (missingSkillMd.length) {
    findings.push(finding(
      'skills.no-skill-md',
      `${missingSkillMd.length} directory/directories under a skill root have no SKILL.md`,
      'info',
      platform,
      {
        verified: { method: 'read-file', evidence: 'directory present, SKILL.md absent' },
        current: missingSkillMd,
        recommended: 'These are not discoverable as skills. Investigate before removing: another tool may use the directory.'
      }
    ))
  }

  const mcpTotal = mcp.reduce((n, m) => n + m.servers.length, 0)
  findings.push(finding(
    'mcp.surface',
    `MCP declarations found: ${mcpTotal} server entry/entries across ${mcp.filter(m => m.present).length} config file(s)`,
    'info',
    platform,
    {
      verified: { method: 'read-file', evidence: 'parsed MCP config surfaces without executing any server' },
      current: mcp.map(m => ({ id: m.id, present: m.present, parsable: m.parsable, servers: m.servers })),
      recommended: 'MCP surfaces are read-only in this version. Starting a server or removing one is out of scope; a timeout never proves a server is dead.',
      remediation: null
    }
  ))

  for (const tool of tools) {
    if (!tool.found) {
      findings.push(finding(
        `tool.missing:${tool.id}`,
        `${tool.id} is not on PATH`,
        'info',
        platform,
        {
          applicable: false,
          notApplicableReason: tool.reason,
          verified: { method: 'ran', evidence: `spawn failed: ${tool.reason}` },
          current: null
        }
      ))
    } else if (!tool.ran) {
      // O3: presence on PATH is not proof that the tool works.
      findings.push(finding(
        `tool.unusable:${tool.id}`,
        `${tool.id} exists on PATH but did not run successfully`,
        'medium',
        platform,
        {
          verified: { method: 'ran', evidence: `spawned ${tool.id}; ${tool.reason}` },
          current: { found: true, usable: false },
          recommended: 'Investigate the failing executable. A file that exists is not an installed, working tool.'
        }
      ))
    } else {
      findings.push(finding(
        `tool.version:${tool.id}`,
        `${tool.id} reports a version`,
        'info',
        platform,
        {
          verified: { method: 'ran', evidence: tool.version },
          current: { found: true, usable: true, version: tool.version }
        }
      ))
    }
  }

  return findings
}

export { PROBES }
