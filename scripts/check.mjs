import { readFile } from 'node:fs/promises'

const required = [
  'package.json', '.codex-plugin/plugin.json', '.mcp.json', 'mcp-server.mjs',
  'index.js', 'lib/apply.mjs', 'lib/scan.mjs', 'lib/util.mjs', 'cordis.patch.yml',
  'README.md', 'README.zh-CN.md', 'SECURITY.md', 'bin/dsh-optimizer.mjs'
]
const files = Object.fromEntries(await Promise.all(required.map(async file => [file, await readFile(new URL(`../${file}`, import.meta.url), 'utf8')])))
const pkg = JSON.parse(files['package.json'])
const plugin = JSON.parse(files['.codex-plugin/plugin.json'])
const mcp = JSON.parse(files['.mcp.json'])

if (pkg.dsh?.bundle?.patch !== './cordis.patch.yml') throw new Error('missing DSH bundle patch')
if (pkg.name !== plugin.name || pkg.version !== plugin.version || plugin.mcpServers !== './.mcp.json') throw new Error('package/plugin identity or MCP path mismatch')
if (!mcp.mcpServers?.['dsh-optimizer']) throw new Error('MCP declaration missing')
if (['preinstall', 'install', 'postinstall', 'prepare'].some(name => pkg.scripts?.[name])) throw new Error('install lifecycle scripts are forbidden')
if (!files['cordis.patch.yml'].includes('name: dsh-optimizer')) throw new Error('bundle does not mount dsh-optimizer')

for (const tool of ['dsh_optimizer_scan', 'dsh_optimizer_plan', 'dsh_optimizer_apply', 'dsh_optimizer_undo']) {
  if (!files['index.js'].includes(`name: '${tool}'`)) throw new Error(`missing tool ${tool}`)
}
if (/export\s+default\b/.test(files['index.js'])) throw new Error('namespace DSH plugins must not default-export')

// The MCP surface must stay read-only: no apply/undo reachable from a remote caller.
if (/applyPlan|undoJournal/.test(files['mcp-server.mjs'])) throw new Error('MCP surface must not import apply/undo')
const mcpTools = [...files['mcp-server.mjs'].matchAll(/name: '([a-z_]+)'/g)].map(m => m[1])
if (mcpTools.length !== 2) throw new Error(`MCP must expose exactly 2 read-only tools, found: ${mcpTools.join(', ')}`)
if (!files['SECURITY.md'].includes('apply')) throw new Error('SECURITY.md must state the MCP apply boundary')

// The hash helper must not fall back to JSON.stringify for structured values (O10).
if (/typeof value === 'string' \? value : JSON\.stringify\(value\)/.test(files['lib/util.mjs'])) throw new Error('sha256Hex must use canonicalStringify for structured values')
if (!files['lib/util.mjs'].includes('canonicalStringify(value)')) throw new Error('canonicalStringify missing')

// Scan must remain read-only: no write imports in the scanner.
for (const forbidden of ['writeFile', 'mkdir', 'rm(']) {
  if (files['lib/scan.mjs'].includes(forbidden)) throw new Error(`scan must not import ${forbidden}`)
}

console.log(JSON.stringify({
  ok: true,
  name: pkg.name,
  version: pkg.version,
  bundle: pkg.dsh.bundle.patch,
  dshTools: 4,
  mcpTools,
  mcpWriteSurface: false,
  installScripts: 0,
  namespaceLoaderSafe: true
}))
