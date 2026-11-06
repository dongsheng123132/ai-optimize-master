# dsh-optimizer · know where every skill came from, review the change, restore the config

> For people who run Claude Code, Codex, Cursor, DSH, OpenClaw and Hermes side by side:
> how many copies of that skill do you have? Which ones point at files that no longer
> exist? How many places declare MCP servers?
>
> This version does one thing: **establish the facts, then clean up reversibly.**

MIT licensed · no account · no network calls.

## What it is

One governance core with three surfaces:

| Step | What it does | Writes to your disk? |
|---|---|---|
| `scan` | Inventories each AI tool's skill roots, duplicate definitions, dangling references, MCP declarations, tool versions | **Never** |
| `plan` | Turns your explicit selections into a reviewable plan with a `planHash` | No |
| `apply` | Executes low-risk archive steps only; requires the exact hash; journals each step | Move only, reversible |
| `undo` | Restores from the journal in reverse order | Refuses to clobber later edits |

## Three real scenarios

1. **A Windows workstation with 14 AI tools × 28 skills each** (≈392 copies). `scan`
   separates "same name, same content" from "same name, different content" and never
   merges those into one conclusion.
2. **A skill tells the agent to open `scripts/run.mjs`, but the file is gone.** `scan`
   reports `skills.broken-references` with the exact missing paths.
3. **Cleanup broke a tool.** `undo` restores from the journal; if you edited the file
   after apply, it reports a conflict instead of overwriting.

## First run (three commands)

```bash
npx dsh-optimizer scan                                            # read-only
npx dsh-optimizer plan --select <skill> --out plan.json           # no mutation
npx dsh-optimizer apply --plan plan.json --expect <planHash>      # requires the hash
```

As a DSH plugin, the tools are `dsh_optimizer_scan|plan|apply|undo`. The MCP surface
(`node mcp-server.mjs`, stdio) exposes **only** `optimizer_scan` and `optimizer_plan`.

## What it proves

Verification is `npm test`, not prose. 23 contract tests:

| Id | Defends against |
|---|---|
| O1 | "Just checking" mutating the machine |
| O2 | An unreadable root being reported as clean |
| O3 | A binary on PATH that crashes being reported as installed |
| O4 | Apply without reading the plan (exit 4) |
| O5 | A plan changed after review (exit 3) |
| O6 | Journal completeness and byte-exact undo |
| O7 | Admin steps silently skipped yet journaled |
| O8 | Tests polluting the real machine |
| O9 | `bytes/4` presented as a measured token count |
| O10 | Plan hashes drifting with object key order |

```bash
npm test        # 16 tests
npm run check   # structure, read-only scan, MCP write surface absent
```

## Before you start

- **Does it delete?** No. `apply` moves directories into `$DSH_OPTIMIZER_HOME/archive/`.
- **Does it edit MCP config?** No. MCP is read-only in v0.2.
- **Does it upgrade Node or PowerShell?** No. Versions are advisory.
- **Can I delete duplicates immediately?** Identical content only proves duplicate
  definition, not that a copy is unused. Single-copy skills are `medium` risk and are
  not executed by default.
- **Cross-platform?** Yes. Extra Windows roots are declared through the
  `DSH_OPTIMIZER_ROOTS` environment variable; no drive letters are guessed.
- **Cost?** MIT, offline, no credentials.

## Evidence

- Source: this repository, `main`
- Verification: `npm test` (16) and `npm run check`
- Boundaries: [`SECURITY.md`](SECURITY.md)
- Last reviewed: 2026-11-06

## Recognised skill roots

22 known locations are probed by default (DSH / agents / Claude / Codex / Cursor / OpenClaw / U-King / Hermes / OpenCode / Pi / Gemini / Qwen / Trae / Windsurf / Qoder / CodeBuddy / CommandCode / Grok / iFlow / Lingma / ZCode / the agents canonical source). Missing directories are skipped, never created and never reported as errors. Extra shared trees (e.g. a Windows workstation) are added with `DSH_OPTIMIZER_ROOTS`.

## Support matrix

| Capability | Windows | macOS | Linux |
|---|---|---|---|
| Skill inventory / duplicates / broken refs | ✅ | ✅ | ✅ |
| Read-only MCP declaration inventory | ✅ | ✅ | ✅ |
| Tool version probes (node/git/pwsh/claude/codex) | ✅ | ✅ | ✅ |
| Reversible archive | ✅ | ✅ | ✅ |
| Version upgrades / MCP uninstall | ❌ advisory only | ❌ advisory only | ❌ advisory only |
| Starting MCP servers / executing skill scripts | ❌ out of scope | ❌ out of scope | ❌ out of scope |
