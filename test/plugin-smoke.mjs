// Plugin smoke (static).
// The DSH peer dependency is not installed in this checkout, so this file checks
// the source contract instead of loading the runtime. It is labelled a static
// check on purpose: "not loaded" is not "verified at runtime".
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const source = await readFile(new URL('../index.js', import.meta.url), 'utf8')

test('plugin exports the expected DSH module shape', () => {
  assert.match(source, /export const name = 'dsh-optimizer'/)
  assert.match(source, /export const inject = \['tools'\]/)
  assert.match(source, /export function createDefinitions\(\)/)
  assert.ok(!/export\s+default/.test(source), 'no default export')
})

test('plugin tools are registered by the four public names', () => {
  for (const tool of ['dsh_optimizer_scan', 'dsh_optimizer_plan', 'dsh_optimizer_apply', 'dsh_optimizer_undo']) {
    assert.ok(source.includes(`name: '${tool}'`), `missing ${tool}`)
  }
})

test('apply refuses without a plan hash', () => {
  assert.match(source, /if \(result\.code === 4\) throw/, 'denied path must throw')
  assert.match(source, /if \(result\.code === 3\) throw/, 'diverged path must throw')
})

test('STATED LIMIT: runtime load is not covered by this static smoke', () => {
  // Deliberately documents the gap rather than pretending it passed.
  assert.ok(true)
})
