// `insta setup agent` — make this machine's coding agents InstaCloud-native in one step
// (the Railway `railway setup agent` pattern). Installs the `insta` skill USER-GLOBALLY for
// every agent the skills tool knows: the skill is pure product knowledge with brand-gated
// triggers — no project state in it (the project binding is carried by ./.insta/project.json
// at command time), so one machine-level copy is strictly better than per-project copies.
// Stack skills (neon/tigris/better-auth) intentionally stay per-project: their presence in a
// project doubles as its stack manifest — that install happens on `project create|link`.
import { spawn } from 'node:child_process'
import { info } from '../util.js'

// The `skills` tool we shell out to prints a clack UI: a frame-by-frame clone spinner, an
// "Installing to all N agents" banner, a full N-line install-path box, and a third-party
// "Security Risk Assessment" that flags our OWN first-party skill as "Critical Risk". Streamed
// verbatim during onboarding that reads as noisy and alarming — the opposite of Railway's two
// clean ✓ lines. So we CAPTURE its output and print our own one-line summary instead. This
// classifier decides which captured lines are worth showing if the install FAILS (surface the
// real error; drop the expected no-global-support noise).
export function classifyInstallLine(line: string): 'keep' | 'skip' {
  if (/does not support global skill installation/.test(line)) return 'skip'
  if (/Failed to install \d+/.test(line)) return 'skip'
  return 'keep'
}

// Map a skill-install target directory to a human agent name. `-a '*'` installs to every agent
// dir the tool knows (~70+); we name the well-known ones (Railway-style) and roll the long tail
// into "+N more" rather than dumping every path. Order = display priority.
const AGENT_NAMES: Array<[RegExp, string]> = [
  [/\.agents\b/, 'Universal (.agents)'],
  [/\.claude\b/, 'Claude Code'],
  [/\.codex\b/, 'OpenAI Codex'],
  [/\.cursor\b/, 'Cursor'],
  [/opencode\b/, 'OpenCode'],
  [/copilot\b/, 'GitHub Copilot'],
  [/\.gemini\b/, 'Gemini CLI'],
  [/windsurf\b/, 'Windsurf'],
  [/\.factory\b/, 'Factory Droid'],
  [/goose\b/, 'Goose'],
  [/aider\b/, 'Aider'],
  [/\.continue\b/, 'Continue'],
  [/\.roo\b/, 'Roo'],
  [/kilocode\b/, 'Kilo Code'],
  [/\.qwen\b/, 'Qwen'],
]

// Pull install-target paths out of the skills tool's summary lines ("→ ~/.claude/skills/insta")
// and resolve the well-known ones to names. Returns the total install count + named agents.
export function parseInstalledAgents(output: string): { count: number; names: string[] } {
  const paths = new Set<string>()
  for (const line of output.split('\n')) {
    const plain = line.replace(/\x1b\[[0-9;]*m/g, '')
    // The tool boxes each line ("│    → ~/.claude/skills/insta   │"), so don't anchor to EOL.
    const m = plain.match(/→\s*(\S+)\/skills\/[A-Za-z0-9_-]+/)
    if (m && m[1]) paths.add(m[1])
  }
  const names: string[] = []
  for (const [re, name] of AGENT_NAMES) {
    if ([...paths].some((p) => re.test(p))) names.push(name)
  }
  return { count: paths.size, names }
}

// The Railway-style one-liner: a few named agents, the rest as "+N more".
export function summarizeInstall(output: string): string {
  const { count, names } = parseInstalledAgents(output)
  if (count === 0) return '✓ insta skill installed for your coding agents'
  const shown = names.slice(0, 6)
  const more = count - shown.length
  const list = shown.length
    ? shown.join(', ') + (more > 0 ? `, +${more} more` : '')
    : `${count} agent${count === 1 ? '' : 's'}`
  return `✓ Agent skills — ${list}`
}

export type Runner = (cmd: string, args: string[]) => Promise<{ ok: boolean; output?: string }>

// Capture stdout+stderr silently (don't stream) so we can print our own clean summary. We keep
// the child's stdin inherited in case the tool ever needs a TTY, but with -y it shouldn't.
const defaultRunner: Runner = (cmd, args) =>
  new Promise((resolve) => {
    const env = { ...process.env, AI_AGENT: process.env.AI_AGENT || 'insta', FORCE_COLOR: '0' }
    const p = spawn(cmd, args, { stdio: ['inherit', 'pipe', 'pipe'], env })
    let output = ''
    const grab = (chunk: Buffer) => { output += chunk.toString() }
    p.stdout?.on('data', grab)
    p.stderr?.on('data', grab)
    p.on('error', () => resolve({ ok: false, output }))
    p.on('close', (code) => resolve({ ok: code === 0, output }))
  })

// -g = user-level (machine-global); -a '*' = every agent dir the skills tool supports
// (Claude Code, Codex, Cursor, OpenCode, Copilot, …); --copy = real files, not cache symlinks.
export const SETUP_ARGS = ['skills', 'add', 'InsForge/insta-skills', '-s', 'insta', '-a', '*', '-g', '-y', '--copy']

export async function setupAgent(opts: { yes?: boolean }, run: Runner = defaultRunner): Promise<void> {
  if (!opts.yes && !process.stdout.isTTY) {
    info('non-interactive shell — assuming -y')
  }
  info('setting up coding-agent skills … (~20s)')
  const res = await run('npx', SETUP_ARGS)
  if (!res.ok) {
    info('  skill install failed — install manually with:')
    info('    npx skills add InsForge/insta-skills -s insta -a "*" -g -y --copy')
    // Surface the REAL error: the captured tail, minus the expected no-global-support noise.
    const tail = (res.output ?? '')
      .split('\n')
      .map((l) => l.replace(/\x1b\[[0-9;]*m/g, '').trimEnd())
      .filter((l) => l.trim() && classifyInstallLine(l) === 'keep')
      .slice(-6)
    for (const l of tail) info('    ' + l)
    process.exitCode = 1
    return
  }
  info(summarizeInstall(res.output ?? ''))
  info('  every coding agent on this machine now knows InstaCloud (review skills before use — they run with full permissions).')
}
