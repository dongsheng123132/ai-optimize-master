# Security model

## Scope

`ai-optimize-master` inspects AI-tool asset directories and MCP configuration files on
the machine where it runs. It does not phone home, does not upload inventory, and
does not require credentials.

## Surface boundaries

| Surface | Read | Plan | Apply / Undo |
|---|---|---|---|
| CLI (`bin/ai-optimize-master.mjs`) | yes | yes | yes (local, with `--expect`) |
| DSH plugin tools | yes | yes | yes (with `expect`) |
| MCP server (`mcp-server.mjs`) | yes | yes | **no — deliberately absent** |

The MCP surface exposes only `optimizer_scan` and `optimizer_plan`. A remote MCP
caller must not be able to modify this machine; **apply and undo are intentionally
not importable from `mcp-server.mjs`**. `scripts/check.mjs` fails the build if that
boundary is broken.

## What apply can do

`apply` only performs `archive-skill` steps: it copies a skill directory into the
optimizer's own archive root, verifies the copy, then removes the original from the
tool's skill root.

Hard constraints:

- Every step is validated before any write: unknown `risk`/`allow` values, unknown
  step kinds, and malformed previews are rejected with exit **1** instead of being
  silently downgraded.
- The source must live inside one of the plan's `authorizedRoots`, must not be a
  symlink, and its real path must also stay inside a root (prefix checks alone do
  not catch symlinked ancestors).
- The archive target must not already exist. A previous archive is never merged
  into; the step is blocked as `archive-target-exists`.
- The caller must pass the exact `planHash` (`--expect`); otherwise the run exits
  **4 (denied)**.
- If the plan body no longer matches its hash, the run exits **3 (diverged)** and
  doesn't touch anything.
- Default `--allow low` executes only low-risk steps. A single-copy skill is
  `medium` risk and is skipped unless explicitly allowed.
- A step marked `requiresAdmin` is blocked when not elevated, and **no journal
  entry is written** for a step that never ran.
- The journal is written **before** the first destructive operation (intent) and
  rewritten after every step, so a crash mid-run still leaves an accurate record.
- The journal stores a full directory manifest (relative path, entry type, file
  SHA-256, symlink target) for both the source and the archived copy. A single
  `SKILL.md` hash is not treated as proof that the archive is complete.

## What apply cannot do (v0.2)

- It does not delete anything permanently: archive is a move into
  `$DSH_OPTIMIZER_HOME/archive/`.
- It does not modify MCP configuration files. MCP surfaces are read-only.
- It does not install, upgrade, or downgrade Node, Git, or PowerShell. Version
  findings are advisory only.
- It does not start MCP servers or execute skill scripts. Dynamic probing of
  unknown code is out of scope.

## Undo semantics

`undo` processes journal steps in reverse order and checks two things before
restoring: the archived tree still matches its recorded manifest, and the original
path is still free. If the user re-created the original path after apply, the step
is reported as `conflict`/`target-occupied` and **is not overwritten**. An
already-restored step is detected by manifest and reported as `already-restored`
instead of failing.

## Concurrent writes

`archive` builds a manifest, copies to a staging directory, verifies the copy,
renames it into place, re-checks the source manifest, and only then removes the
source. This narrows the window in which a concurrently edited file could be lost,
but it cannot eliminate it. When the source changes during the copy, the step is
blocked as `source-changed-during-copy` and nothing is deleted.

## Known limits, stated honestly

- Duplicate detection compares `SKILL.md` content hashes. Identical content does
  **not** prove a copy is unused, and divergence does not prove either copy is
  stale.
- An unreadable root is reported as `applicable: false` with a reason. It is never
  reported as clean.
- A binary that exists on PATH but exits non-zero is reported as **unusable**, not
  as installed.
- Archives are recoverable but not encrypted; treat `$DSH_OPTIMIZER_HOME` as
  sensitive as the skills it contains.
