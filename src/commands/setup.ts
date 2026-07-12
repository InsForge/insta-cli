// `insta setup agent` — make this machine's coding agents InstaCloud-native in one step
// (the Railway `railway setup agent` pattern). Installs the `insta` skill USER-GLOBALLY for
// every agent the skills tool knows: the skill is pure product knowledge with brand-gated
// triggers — no project state in it (the project binding is carried by ./.insta/project.json
// at command time), so one machine-level copy is strictly better than per-project copies.
// Stack skills (neon/tigris/better-auth) intentionally stay per-project: their presence in a
// project doubles as its stack manifest — that install happens on `project create|link`.
import { spawn } from 'node:child_process'
import { info } from '../util.js'

export type Runner = (cmd: string, args: string[]) => Promise<{ ok: boolean }>

const defaultRunner: Runner = (cmd, args) =>
  new Promise((resolve) => {
    const env = { ...process.env, AI_AGENT: process.env.AI_AGENT || 'insta' }
    const p = spawn(cmd, args, { stdio: 'inherit', env })
    p.on('error', () => resolve({ ok: false }))
    p.on('close', (code) => resolve({ ok: code === 0 }))
  })

// -g = user-level (machine-global); -a '*' = every agent dir the skills tool supports
// (Claude Code, Codex, Cursor, OpenCode, Copilot, …); --copy = real files, not cache symlinks.
export const SETUP_ARGS = ['skills', 'add', 'InsForge/insta-skills', '-s', 'insta', '-a', '*', '-g', '-y', '--copy']

export async function setupAgent(opts: { yes?: boolean }, run: Runner = defaultRunner): Promise<void> {
  if (!opts.yes && !process.stdout.isTTY) {
    info('non-interactive shell — assuming -y')
  }
  info('installing the insta skill (user-global, all agents) …')
  const res = await run('npx', SETUP_ARGS)
  if (!res.ok) {
    info('  skill install failed — install manually with:')
    info('    npx skills add InsForge/insta-skills -s insta -a "*" -g -y --copy')
    process.exitCode = 1
    return
  }
  info('done — agents on this machine now know InstaCloud.')
  info('next: `insta login --oauth github` (cloud) or run instad locally (insta-oss), then `insta project create <name>`.')
}
