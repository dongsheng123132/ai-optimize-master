// Archive + restore primitives. Shared by the CLI, the DSH plugin and tests so a
// fix lands in every surface at once.
import { cp, lstat, mkdir, rename, rm, readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { buildManifest, verifyManifest, manifestDigest } from './manifest.mjs'

export async function pathState(p) {
  try {
    const info = await lstat(p)
    return { exists: true, symlink: info.isSymbolicLink(), directory: info.isDirectory() }
  } catch (error) {
    if (error?.code === 'ENOENT') return { exists: false, symlink: false, directory: false }
    throw error
  }
}

// Move a skill directory into the archive root, with exclusive creation and a
// verified copy before the original is touched.
//
// Contract:
//  - the archive target must not already exist (never merge into a previous archive)
//  - the source must not be a symlink (we do not follow links out of the root)
//  - the copy is verified against a full manifest before the source is removed
//  - if verification fails, the partial archive is removed and the source is kept
export async function archiveSkillDirectory(step, archiveRoot) {
  const from = step.preview.from
  const to = step.preview.to
  if (!to.startsWith(archiveRoot)) return { code: 'outside-archive-root' }

  const state = await pathState(from)
  if (!state.exists) return { code: 'source-missing' }
  if (state.symlink) return { code: 'source-is-symlink' }
  if (!state.directory) return { code: 'source-not-directory' }
  if ((await pathState(to)).exists) return { code: 'archive-target-exists' }

  const sourceManifest = await buildManifest(from)
  await mkdir(dirname(to), { recursive: true })
  const staging = `${to}.partial-${process.pid}-${Date.now()}`
  await mkdir(staging, { recursive: true })
  try {
    await cp(from, staging, { recursive: true, force: false, errorOnExist: true })
    const copied = await buildManifest(staging)
    if (!sameEntries(sourceManifest, copied)) {
      await rm(staging, { recursive: true, force: true })
      return { code: 'copy-verification-failed' }
    }
    await rename(staging, to)
    // Re-check the source right before removal: this narrows (but cannot fully
    // eliminate) a concurrent-write window. See SECURITY.md "concurrent writes".
    const current = await buildManifest(from)
    if (!sameEntries(sourceManifest, current)) {
      await rm(to, { recursive: true, force: true })
      return { code: 'source-changed-during-copy' }
    }
    await rm(from, { recursive: true, force: true })
    const archived = await buildManifest(to)
    return {
      code: 'ok',
      before: { path: from, manifest: sourceManifest, digest: manifestDigest(sourceManifest) },
      after: { path: to, manifest: archived, digest: manifestDigest(archived) }
    }
  } catch (error) {
    await rm(staging, { recursive: true, force: true }).catch(() => {})
    throw error
  }
}

// Restore one journaled step. Refuses to overwrite anything that appeared at the
// original path after apply, and verifies the archived tree before restoring.
export async function restoreSkillDirectory(step) {
  const target = step.before.path
  const archivePath = step.after.path

  const archiveState = await pathState(archivePath)
  if (!archiveState.exists) {
    // Idempotency: if the original is back with the expected content, this step
    // was already undone; otherwise the archive is gone and we cannot restore.
    const targetState = await pathState(target)
    if (targetState.exists && targetState.directory) {
      const check = await verifyManifest(target, step.before.manifest)
      if (check.ok) return { code: 'already-restored' }
    }
    return { code: 'archive-missing' }
  }

  const archiveCheck = await verifyManifest(archivePath, step.after.manifest)
  if (!archiveCheck.ok) return { code: 'archive-integrity-failed', detail: archiveCheck }

  const targetState = await pathState(target)
  if (targetState.exists) return { code: 'target-occupied', detail: targetState }

  await mkdir(dirname(target), { recursive: true })
  const staging = `${target}.restore-${process.pid}-${Date.now()}`
  try {
    await cp(archivePath, staging, { recursive: true, force: false })
    const check = await verifyManifest(staging, step.before.manifest)
    if (!check.ok) {
      await rm(staging, { recursive: true, force: true })
      return { code: 'restore-verification-failed', detail: check }
    }
    await rename(staging, target)
  } catch (error) {
    await rm(staging, { recursive: true, force: true }).catch(() => {})
    throw error
  }
  const finalCheck = await verifyManifest(target, step.before.manifest)
  if (!finalCheck.ok) return { code: 'restore-verification-failed', detail: finalCheck }
  await removeEmptyParents(archivePath)
  await rm(archivePath, { recursive: true, force: true })
  return { code: 'ok' }
}

async function removeEmptyParents(path) {
  let dir = dirname(path)
  for (let i = 0; i < 4; i++) {
    try {
      const items = await readdir(dir)
      if (items.length) return
      await rm(dir, { recursive: false, force: true })
      dir = dirname(dir)
    } catch {
      return
    }
  }
}

function sameEntries(a, b) {
  return JSON.stringify(a.entries) === JSON.stringify(b.entries)
}

