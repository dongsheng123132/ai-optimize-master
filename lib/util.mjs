// Shared primitives: canonical JSON, sha256, byte-safe file io, filesystem snapshots.
// Invariant: hashes over structured values MUST be key-order independent (see O10).
import { createHash } from 'node:crypto'
import { readFile, writeFile, readdir, stat, unlink, rename, mkdir } from 'node:fs/promises'
import { join, relative, dirname, resolve, sep } from 'node:path'
import { homedir } from 'node:os'

// Deterministic JSON: object keys sorted recursively, arrays keep order.
// Arrays are NOT sorted: step order and command arguments are semantic.
export function canonicalStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalStringify).join(',')}]`
  const keys = Object.keys(value).sort()
  return `{${keys.map(key => `${JSON.stringify(key)}:${canonicalStringify(value[key])}`).join(',')}}`
}

// Structured values go through canonicalStringify so the hash never depends on key insertion order.
export function sha256Hex(value) {
  const text = typeof value === 'string' ? value : canonicalStringify(value)
  return createHash('sha256').update(text).digest('hex')
}

export function home() {
  return process.env.DSH_OPTIMIZER_HOME || join(homedir(), '.dsh-optimizer')
}

export function expandHome(p) {
  if (!p) return p
  if (p === '~') return homedir()
  if (p.startsWith('~/') || p.startsWith('~\\')) return join(homedir(), p.slice(2))
  return p
}

export async function readBytesIfExists(file) {
  try {
    return await readFile(file)
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

export async function writeBytes(file, bytes) {
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, bytes)
}

export async function readTextIfExists(file) {
  const bytes = await readBytesIfExists(file)
  return bytes === null ? null : bytes.toString('utf8')
}

// Snapshot a tree as { relPath -> { size, mtimeMs, sha256 } }. Used by O1 (scan never writes).
export async function snapshotTree(root) {
  const entries = new Map()
  async function walk(dir) {
    let items
    try {
      items = await readdir(dir, { withFileTypes: true })
    } catch (error) {
      if (error?.code === 'ENOENT') return
      throw error
    }
    for (const item of items) {
      const absolute = join(dir, item.name)
      if (item.isDirectory()) {
        await walk(absolute)
      } else if (item.isFile()) {
        const info = await stat(absolute)
        const bytes = await readFile(absolute)
        entries.set(relative(root, absolute).replaceAll('\\', '/'), {
          size: info.size,
          mtimeMs: info.mtimeMs,
          sha256: createHash('sha256').update(bytes).digest('hex')
        })
      }
    }
  }
  await walk(root)
  return entries
}

export function snapshotEqual(a, b) {
  if (a.size !== b.size) return false
  for (const [key, value] of a) {
    const other = b.get(key)
    if (!other) return false
    if (value.size !== other.size || value.mtimeMs !== other.mtimeMs || value.sha256 !== other.sha256) return false
  }
  for (const key of b.keys()) {
    if (!a.has(key)) return false
  }
  return true
}

export async function sha256Of(file) {
  const bytes = await readBytesIfExists(file)
  if (bytes === null) return null
  return createHash('sha256').update(bytes).digest('hex')
}

export async function removeIfExists(file) {
  try {
    await unlink(file)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
}

export async function movePath(from, to) {
  await mkdir(dirname(to), { recursive: true })
  await rename(from, to)
}

// Guard: a write target must stay inside one of the declared roots.
export function isInside(root, target) {
  const r = resolve(root)
  const t = resolve(target)
  return t === r || t.startsWith(r + sep)
}

export function parseBool(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback
  if (typeof value === 'boolean') return value
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase())
}
