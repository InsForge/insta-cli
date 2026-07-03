import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { installSkills, ensureGitignore } from '../src/ensure-skills.js'

function fakeRun() {
  const calls: Array<{ cmd: string; args: string[] }> = []
  const run = async (cmd: string, args: string[]) => { calls.push({ cmd, args }); return { ok: true } }
  return { calls, run }
}

test('installSkills adds insta + the three service skills, non-interactively, and gitignores them', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'insta-'))
  const out: string[] = []
  const { calls, run } = fakeRun()
  await installSkills({ cwd: dir, run, print: (s) => out.push(s) })

  expect(calls.map((c) => c.cmd)).toEqual(['npx', 'npx', 'npx', 'npx'])
  expect(calls.map((c) => c.args.join(' '))).toEqual([
    'skills add InsForge/insta-skills -s insta -a claude-code -a codex -y --copy',
    'skills add neondatabase/agent-skills -s neon-postgres -a claude-code -a codex -y --copy',
    'skills add tigrisdata/skills -s tigris-object-operations -s file-storage -s tigris-sdk-guide -s tigris-security-access-control -s tigris-image-optimization -s tigris-s3-migration -s tigris-static-assets -s tigris-agent-kit -a claude-code -a codex -y --copy',
    'skills add better-auth/skills -s better-auth-best-practices -s email-and-password-best-practices -s better-auth-security-best-practices -a claude-code -a codex -y --copy',
  ])
  // every invocation is non-interactive: agents pinned + skip-prompt flags present
  for (const c of calls) {
    expect(c.args).toContain('-y')
    expect(c.args).toContain('--copy')
    expect(c.args.join(' ')).toMatch(/-a claude-code/)
    expect(c.args.join(' ')).toMatch(/-a codex/)
  }
  expect(out.join('\n')).toMatch(/insta ✓/)
  // the installed (regenerable) skill dirs are gitignored
  const gi = readFileSync(join(dir, '.gitignore'), 'utf8')
  expect(gi).toMatch(/\.claude\/skills\//)
  expect(gi).toMatch(/\.agents\/skills\//)
  expect(gi).toMatch(/\.github\/skills\//)
})

test('a failed skill add still continues to the rest and reports the failure', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'insta-'))
  const out: string[] = []
  const run = async (_cmd: string, args: string[]) => ({ ok: !args.includes('tigrisdata/skills') })
  await installSkills({ cwd: dir, run, print: (s) => out.push(s) })
  expect(out.join('\n')).toMatch(/tigris failed — add manually: npx skills add tigrisdata\/skills/)
  expect(out.join('\n')).toMatch(/better-auth ✓/) // reached the skill after the failure
})

test('ensureGitignore appends missing entries idempotently, preserving existing content', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'insta-'))
  writeFileSync(join(dir, '.gitignore'), 'node_modules\n.env\n')
  const added1 = ensureGitignore(dir, ['.claude/skills/', '.env']) // .env already present
  expect(added1).toEqual(['.claude/skills/'])
  const gi = readFileSync(join(dir, '.gitignore'), 'utf8')
  expect(gi).toMatch(/^node_modules$/m)
  expect((gi.match(/^\.env$/gm) || []).length).toBe(1) // not duplicated
  expect(ensureGitignore(dir, ['.claude/skills/', '.env'])).toEqual([]) // re-run adds nothing
})
