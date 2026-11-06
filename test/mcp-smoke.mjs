// MCP smoke: the server must start, list exactly two read-only tools, and be
// incapable of applying anything.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'

const SERVER = new URL('../mcp-server.mjs', import.meta.url).pathname

function start() {
  const child = spawn(process.execPath, [SERVER], { stdio: ['pipe', 'pipe', 'pipe'] })
  let buffer = ''
  const waiting = new Map()
  child.stdout.on('data', chunk => {
    buffer += chunk
    let index
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index)
      buffer = buffer.slice(index + 1)
      if (!line.trim()) continue
      try {
        const message = JSON.parse(line)
        const resolve = waiting.get(message.id)
        if (resolve) { waiting.delete(message.id); resolve(message) }
      } catch { /* ignore non-JSON noise */ }
    }
  })
  let nextId = 1
  return {
    request(method, params) {
      const id = nextId++
      return new Promise(resolve => {
        waiting.set(id, resolve)
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
        setTimeout(() => { if (waiting.delete(id)) resolve({ error: { message: 'timeout' } }) }, 8000)
      })
    },
    stop() { child.kill('SIGKILL') }
  }
}

test('MCP exposes scan/plan only, never apply', async () => {
  const server = start()
  try {
    const init = await server.request('initialize', { protocolVersion: '2025-06-18' })
    assert.equal(init.result?.serverInfo?.name, 'ai-optimize-master')
    const list = await server.request('tools/list', {})
    const names = list.result.tools.map(t => t.name).sort()
    assert.deepEqual(names, ['optimizer_plan', 'optimizer_scan'])
    assert.ok(!names.some(n => /apply|undo/.test(n)), 'apply/undo must not be reachable over MCP')
    const unknown = await server.request('tools/call', { name: 'optimizer_apply', arguments: {} })
    assert.ok(unknown.error, 'calling apply over MCP must fail')
  } finally {
    server.stop()
  }
})
