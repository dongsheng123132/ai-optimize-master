// Directory-level integrity: a single SKILL.md hash cannot prove an archive is
// complete. A manifest covers every entry: relative path, type, file hash, and
// symlink target.
import { lstat, readdir, readFile, readlink } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { createHash } from 'node:crypto'

export async function buildManifest(root) {
  const entries = []
  async function walk(dir) {
    let items
    try {
      items = await readdir(dir, { withFileTypes: true })
    } catch (error) {
      if (error?.code === 'ENOENT') return
      throw error
    }
    for (const item of items.sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = join(dir, item.name)
      const rel = relative(root, absolute).replaceAll('\\', '/')
      const info = await lstat(absolute)
      if (info.isSymbolicLink()) {
        entries.push({ path: rel, type: 'symlink', target: await readlink(absolute) })
      } else if (info.isDirectory()) {
        entries.push({ path: rel, type: 'dir' })
        await walk(absolute)
      } else if (info.isFile()) {
        const bytes = await readFile(absolute)
        entries.push({ path: rel, type: 'file', sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length })
      } else {
        entries.push({ path: rel, type: 'other' })
      }
    }
  }
  await walk(root)
  return { root, entries }
}

export function manifestDigest(manifest) {
  return createHash('sha256').update(JSON.stringify(manifest.entries)).digest('hex')
}

export function manifestsEqual(a, b) {
  return manifestDigest(a) === manifestDigest(b)
}

// Verify that a tree still matches a manifest. Any added, removed, or modified
// entry makes the verification fail; "looks fine" is not a verification.
export async function verifyManifest(root, manifest) {
  const current = await buildManifest(root)
  if (manifestsEqual(current, manifest)) return { ok: true, digest: manifestDigest(current) }
  const expectedPaths = new Set(manifest.entries.map(e => e.path))
  const actualPaths = new Set(current.entries.map(e => e.path))
  const missing = [...expectedPaths].filter(p => !actualPaths.has(p))
  const extra = [...actualPaths].filter(p => !expectedPaths.has(p))
  const changed = []
  for (const entry of manifest.entries) {
    const other = current.entries.find(e => e.path === entry.path)
    if (!other) continue
    if (other.type !== entry.type || other.sha256 !== entry.sha256 || other.target !== entry.target) changed.push(entry.path)
  }
  return { ok: false, digest: manifestDigest(current), missing, extra, changed }
}
