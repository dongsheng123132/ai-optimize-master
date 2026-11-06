# Security model

## Scope

`dsh-optimizer` inspects AI-tool asset directories and MCP configuration files on
the machine where it runs. It does not phone home, does not upload inventory, and
does not require credentials.

## Surface boundaries

| Surface | Read | Plan | Apply / Undo |
|---|---|---|---|
| CLI (`bin/dsh-optimizer.mjs`) | yes | yes | yes (local, with `--expect`) |
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

- The target must live inside one of the declared skill roots. Paths outside are
  refused at plan time (`outside-skill-root`).
- The caller must pass the exact `planHash` (`--expect`); otherwise the run exits
  **4 (denied)**.
- If the plan body no longer matches its hash, the run exits **3 (diverged)** and
  doesn't touch anything.
- Default `--allow low` executes only low-risk steps. A single-copy skill is
  `medium` risk and is skipped unless explicitly allowed.
- A step marked `requiresAdmin` is blocked when not elevated, and **no journal
  entry is written** for a step that never ran.
- Every executed step is journaled in `$DSH_OPTIMIZER_HOME/journal/<planHash>.json`.

## What apply cannot do (v0.2)

- It does not delete anything permanently: archive is a move into
  `$DSH_OPTIMIZER_HOME/archive/`.
- It does not modify MCP configuration files. MCP surfaces are read-only.
- It does not install, upgrade, or downgrade Node, Git, or PowerShell. Version
  findings are advisory only.
- It does not start MCP servers or execute skill scripts. Dynamic probing of
  unknown code is out of scope.

## Undo semantics

`undo` processes journal steps in reverse order. If a file changed after apply,
the step is reported as `conflict` and **is not overwritten**. Restoring a stale
backup over newer user edits is treated as data loss, not as a successful undo.

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
