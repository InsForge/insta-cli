// Install the related agent skills into a linked project so the developer's coding agent has
// context for what InstaCloud provisions — the `insta` CLI itself plus the three services you build
// directly against (Neon Postgres, Tigris storage, Better Auth). Runs `npx skills add`
// (vercel-labs/skills) fully non-interactively. Best-effort: a failure (offline, npx missing, a
// repo moved) prints a manual fallback and never blocks or fails the host command — same contract
// as the observe-hook install.
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// Where `npx skills add` drops skills for the agents we pin below: Claude Code → .claude/skills/,
// Codex → .agents/skills/ (.github/skills/ is the third well-known dir). These are regenerable
// agent context, not the developer's source — keep them out of git.
const SKILL_DIRS = ['.claude/skills/', '.agents/skills/', '.github/skills/']

export type Runner = (cmd: string, args: string[], inherit?: boolean) => Promise<{ ok: boolean }>

const defaultRunner: Runner = (cmd, args, inherit = false) =>
  new Promise((resolve) => {
    const p = spawn(cmd, args, { stdio: inherit ? 'inherit' : 'ignore' })
    p.on('error', () => resolve({ ok: false })) // e.g. npx not on PATH
    p.on('close', (code) => resolve({ ok: code === 0 }))
  })

// `npx skills add` is non-interactive only when we remove every prompt: pin the target agents
// (-a claude-code -a codex) so it neither asks which agent nor fans out to every known agent dir;
// name the exact skills (-s …) so there's no skill picker; -y to skip the scope/confirm prompt;
// --copy to write real files (not symlinks into a transient npx cache).
const AGENT_FLAGS = ['-a', 'claude-code', '-a', 'codex', '-y', '--copy']
const SKILLS: Array<{ label: string; args: string[] }> = [
  { label: 'insta', args: ['skills', 'add', 'InsForge/insta-skills', '-s', 'insta', ...AGENT_FLAGS] },
  { label: 'neon-postgres', args: ['skills', 'add', 'neondatabase/agent-skills', '-s', 'neon-postgres', ...AGENT_FLAGS] },
  { label: 'tigris', args: ['skills', 'add', 'tigrisdata/skills',
    '-s', 'tigris-object-operations', '-s', 'file-storage', '-s', 'tigris-sdk-guide',
    '-s', 'tigris-security-access-control', '-s', 'tigris-image-optimization',
    '-s', 'tigris-s3-migration', '-s', 'tigris-static-assets', '-s', 'tigris-agent-kit',
    ...AGENT_FLAGS] },
  { label: 'better-auth', args: ['skills', 'add', 'better-auth/skills',
    '-s', 'better-auth-best-practices', '-s', 'email-and-password-best-practices',
    '-s', 'better-auth-security-best-practices', ...AGENT_FLAGS] },
]

type Deps = { cwd: string; run?: Runner; print?: (s: string) => void }

// Install all related skills. Production omits `run`/`print` → the real spawn + stdout; tests inject
// a fake runner and capture output. Continues past a per-skill failure so one bad repo doesn't skip
// the rest, and never throws.
export async function installSkills(deps: Deps): Promise<void> {
  const run = deps.run ?? defaultRunner
  const print = deps.print ?? ((s: string) => process.stdout.write(s + '\n'))
  try {
    print('  installing related agent skills (insta, neon-postgres, tigris, better-auth) via `npx skills add` …')
    for (const s of SKILLS) {
      const r = await run('npx', s.args, true) // streamed so the user sees download progress
      print(r.ok ? `  ${s.label} ✓` : `  ${s.label} failed — add manually: npx ${s.args.join(' ')}`)
    }
    const added = ensureGitignore(deps.cwd, SKILL_DIRS)
    if (added.length) print(`  .gitignore += ${added.join(', ')}`)
  } catch {
    /* best-effort convenience — never block the host command */
  }
}

// Append any missing entries to the project's ./.gitignore (creating it if absent). Idempotent:
// entries already present are left alone. Returns the entries it added.
export function ensureGitignore(cwd: string, entries: string[]): string[] {
  const p = join(cwd, '.gitignore')
  const existing = existsSync(p) ? readFileSync(p, 'utf8') : ''
  const have = new Set(existing.split('\n').map((l) => l.trim()))
  const missing = entries.filter((e) => !have.has(e))
  if (missing.length === 0) return []
  const prefix = existing && !existing.endsWith('\n') ? '\n' : ''
  const comment = '# InstaCloud: agent skills installed by `npx skills add` (regenerable, not source)'
  writeFileSync(p, existing + `${prefix}\n${comment}\n${missing.join('\n')}\n`)
  return missing
}
