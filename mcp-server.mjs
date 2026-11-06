#!/usr/bin/env node
// MCP surface — READ-ONLY by design.
// A remote MCP caller may inspect and plan, but must not modify this machine:
// apply and undo are deliberately absent. See SECURITY.md.
import readline from 'node:readline'
import { scan } from './lib/scan.mjs'
import { buildPlan } from './lib/apply.mjs'

const tools = [
  {
    name: 'optimizer_scan',
    description: 'Read-only inventory of AI tool skill roots, duplicates, broken references, MCP declarations, and tool versions. Never writes.',
    inputSchema: {
      type: 'object',
      properties: { includeProbes: { type: 'boolean' } },
      additionalProperties: false
    }
  },
  {
    name: 'optimizer_plan',
    description: 'Build a reviewable, hash-bound plan from a scan. Never modifies anything. Note: the MCP surface cannot apply a plan; apply/undo exist only on the local CLI and the DSH plugin.',
    inputSchema: {
      type: 'object',
      properties: {
        select: { type: 'array', items: { type: 'string' } },
        root: { type: 'array', items: { type: 'string' } }
      },
      additionalProperties: false
    }
  }
]

async function call(name, args = {}) {
  if (name === 'optimizer_scan') return scan({ probes: args.includeProbes ?? true })
  if (name === 'optimizer_plan') {
    const scanResult = await scan({ probes: false })
    const selected = (args.select ?? []).map((skillName, index) => (args.root?.[index] ? { name: skillName, root: args.root[index] } : skillName))
    return buildPlan(scanResult, { selections: selected })
  }
  throw Object.assign(new Error(`Unknown tool: ${name}`), { code: 'METHOD_NOT_FOUND' })
}

const send = value => process.stdout.write(`${JSON.stringify(value)}\n`)
const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })

for await (const line of lines) {
  if (!line.trim()) continue
  let request
  try { request = JSON.parse(line) } catch { continue }
  if (request.id === undefined) continue
  try {
    if (request.method === 'initialize') {
      send({ jsonrpc: '2.0', id: request.id, result: { protocolVersion: request.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'dsh-optimizer', version: '0.2.0' } } })
    } else if (request.method === 'tools/list') {
      send({ jsonrpc: '2.0', id: request.id, result: { tools } })
    } else if (request.method === 'tools/call') {
      const value = await call(request.params?.name, request.params?.arguments ?? {})
      send({ jsonrpc: '2.0', id: request.id, result: { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }], isError: false } })
    } else {
      send({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: `Unknown method: ${request.method}` } })
    }
  } catch (error) {
    send({ jsonrpc: '2.0', id: request.id, error: { code: -32000, message: error?.message ?? String(error) } })
  }
}
