// DSH plugin surface: three tools, all sharing one core.
// scan  — strictly read-only inventory.
// plan  — turns findings + explicit selections into a reviewable, hash-bound plan.
// apply — executes a low-risk, reversible archive; requires the exact plan hash.
import { defineTool } from '@deepseek-ai/dsh-tools'
import { scan } from './lib/scan.mjs'
import { buildPlan, applyPlan, undoJournal } from './lib/apply.mjs'
import { home, sha256Of } from './lib/util.mjs'
import { writeFile, mkdir, cp, rm } from 'node:fs/promises'
import { join, dirname } from 'node:path'

export const name = 'dsh-optimizer'
export const inject = ['tools']

const renderJson = (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }]

const journal = {
  async write(doc) {
    const root = join(home(), 'journal')
    await mkdir(root, { recursive: true })
    const file = join(root, `${doc.planHash}.json`)
    await writeFile(file, JSON.stringify(doc, null, 2), 'utf8')
    return file
  }
}

const archive = async step => {
  const { from, to } = step.preview
  await mkdir(dirname(to), { recursive: true })
  await cp(from, to, { recursive: true, force: true })
  await rm(from, { recursive: true, force: true })
  return {
    before: { path: from, hash: step.evidence?.skillMdHash ?? null },
    after: { path: to, hash: await sha256Of(join(to, 'SKILL.md')), hashTarget: join(to, 'SKILL.md') },
    summary: { from, to }
  }
}

export function createDefinitions() {
  return [
    defineTool({
      name: 'dsh_optimizer_scan',
      description: 'Read-only inventory of AI tool skill roots, duplicate/broken skill definitions, MCP declarations, and tool versions. Never writes to any inspected directory. A tool that exists on PATH but fails to run is reported as unusable, not as installed.',
      parameters: {
        includeProbes: { type: 'boolean', description: 'Run the allowlisted version probes (node/git/pwsh/claude/codex). Default true.' }
      },
      output: { schema: { type: 'json' }, render: renderJson },
      async execute(args = {}) {
        const result = await scan({ probes: args.includeProbes ?? true })
        return { ...result, readOnly: true }
      }
    }),
    defineTool({
      name: 'dsh_optimizer_plan',
      description: 'Build a reviewable plan from a scan. Selective: only explicitly selected skills become steps. Returns a planHash that apply requires. Does not modify anything.',
      parameters: {
        select: { type: 'array', description: 'Skill names to consider archiving.', items: { type: 'string' } },
        root: { type: 'array', description: 'Optional root id per selection, in the same order.', items: { type: 'string' } }
      },
      output: { schema: { type: 'json' }, render: renderJson },
      async execute(args = {}) {
        const scanResult = await scan({ probes: false })
        const selected = (args.select ?? []).map((skillName, index) => (args.root?.[index]
          ? { name: skillName, root: args.root[index] }
          : skillName))
        return buildPlan(scanResult, { selections: selected })
      }
    }),
    defineTool({
      name: 'dsh_optimizer_apply',
      description: 'Apply a previously planned archive step set. Requires the exact planHash via expect; without it the call is denied. Journals every change so undo can restore byte-identical content. Only low-risk steps by default.',
      parameters: {
        plan: { type: 'json', required: true, description: 'The plan object returned by dsh_optimizer_plan.' },
        expect: { type: 'string', required: true, description: 'The planHash being approved.' },
        allow: { type: 'string', description: 'Maximum risk to execute: low|medium|high. Default low.' }
      },
      output: { schema: { type: 'json' }, render: renderJson },
      async execute(args) {
        const result = await applyPlan(args.plan, {
          expect: args.expect,
          allow: args.allow ?? 'low',
          journal,
          archive,
          isAdmin: undefined
        })
        if (result.code === 4) throw Object.assign(new Error('denied: apply requires the exact plan hash'), { code: 'DENIED' })
        if (result.code === 3) throw Object.assign(new Error('diverged: plan hash does not match plan content'), { code: 'DIVERGED' })
        return result
      }
    }),
    defineTool({
      name: 'dsh_optimizer_undo',
      description: 'Undo an applied journal in reverse order. A step whose content changed after apply is reported as a conflict instead of being overwritten.',
      parameters: {
        journal: { type: 'json', required: true, description: 'The journal document returned by apply.' }
      },
      output: { schema: { type: 'json' }, render: renderJson },
      async execute(args) {
        return undoJournal(args.journal, {
          currentHash: sha256Of,
          restore: async step => {
            const { before, after } = step
            await cp(after.path, before.path, { recursive: true, force: true })
            await rm(after.path, { recursive: true, force: true })
          }
        })
      }
    })
  ]
}
