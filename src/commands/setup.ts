// `insta setup agent` — make this machine's coding agents InstaCloud-native in one step
// (the Railway `railway setup agent` pattern). Installs the `insta` skill USER-GLOBALLY for
// every agent the skills tool knows: the skill is pure product knowledge with brand-gated
// triggers — no project state in it (the project binding is carried by ./.insta/project.json
// at command time), so one machine-level copy is strictly better than per-project copies.
// Stack skills (tigris/better-auth) intentionally stay per-project: their presence in a
// project doubles as its stack manifest — that install happens on `project create|link`.
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import os from 'node:os'
import { ApiClient } from '../api.js'
import { resolveEnv } from '../config.js'
import { DEFAULT_ENV, ENVS, mcpServerName } from '../env.js'
import { info } from '../util.js'
import { installAgentConfigs } from './mcp.js'
import { detectChannel, type Channel } from './upgrade.js'

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

// ---- CLI self-install (makes `npx -y insta setup agent` a complete one-liner) ----

// Under npx the CLI runs from the npm cache and vanishes when the process exits — but the skill
// installed below tells every agent to run `insta …`, which then wouldn't exist. So when this
// process came from the npm channel and no DURABLE `insta` is on PATH, install ourselves
// globally first. The scan must ignore any PATH entry under a node_modules directory: npx
// prepends its cache's node_modules/.bin (where this very process's `insta` shim lives), while
// durable installs (npm -g bin, nvm/volta/fnm, the native binary's ~/.insta/bin) never sit
// under one.
// On POSIX a PATH hit only counts if it would actually run: a plain non-executable file (or a
// directory) named `insta` must not suppress the self-install. Mode bits, not access(X_OK) —
// access() answers "can THIS process exec it", which for root is always yes, so a root-run
// setup would wrongly treat a non-executable file as a durable install. On Windows execute
// permission is extension-driven, so existence of a regular file is the right check.
const isRunnableFile = (p: string, win: boolean): boolean => {
  try {
    const st = statSync(p)
    if (!st.isFile()) return false
    return win || (st.mode & 0o111) !== 0
  } catch { return false }
}

export function findDurableOnPath(
  bin: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const win = platform === 'win32'
  const dirs = (env.PATH ?? '').split(win ? ';' : ':')
  // npm on Windows writes insta.cmd/insta.ps1 plus an extensionless sh shim; PATHEXT covers the
  // former, the bare name the latter.
  const exts = win ? [...(env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';'), ''] : ['']
  for (const dir of dirs) {
    if (!dir || dir.includes('node_modules')) continue
    for (const ext of exts) if (isRunnableFile(join(dir, bin + ext), win)) return true
  }
  return false
}

/** The exact global-install invocation, pinned to THIS version so the one-liner installs what it
 *  ran. Re-enter the npm that spawned us (npm_execpath) rather than whatever `npm` is on PATH:
 *  under a version manager they can differ, and on Windows spawning `npm` without a shell fails
 *  while `node npm-cli.js` works everywhere. npx runs set npm_execpath to npx-cli.js — swap it
 *  for its sibling npm-cli.js. */
export function selfInstallCmd(
  version: string,
  npmExecpath = process.env.npm_execpath,
  execPath = process.execPath,
  platform: NodeJS.Platform = process.platform,
): { cmd: string; args: string[] } {
  const spec = `insta@${version}`
  // Re-enter ONLY an actual npm/npx CLI script: other launchers also set npm_execpath (yarn
  // classic → yarn.js), and `node yarn.js install -g` is not a valid invocation of anything.
  if (npmExecpath && /(^|[\\/])np[mx](-cli)?\.[cm]?js$/.test(npmExecpath)) {
    const npmCli = npmExecpath.replace(/npx(-cli)?(\.[cm]?js)$/, 'npm$1$2')
    return { cmd: execPath, args: [npmCli, 'install', '-g', spec] }
  }
  // No usable npm_execpath (bun, yarn, pnpm, none): use the npm that ships beside this node —
  // bare `npm` is npm.cmd on Windows, which spawn() refuses without a shell defaultRunner
  // never uses. Layouts: <nodedir>/node_modules/npm (Windows), <nodedir>/../lib/... (POSIX).
  const nodeDir = dirname(execPath)
  const besideNode = platform === 'win32'
    ? join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js')
    : join(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')
  if (existsSync(besideNode)) return { cmd: execPath, args: [besideNode, 'install', '-g', spec] }
  // Last resort (POSIX shims like nvm/volta resolve `npm` fine; on Windows this whole branch
  // is best-effort and falls through to the printed manual command on failure).
  return { cmd: 'npm', args: ['install', '-g', spec] }
}

const cliVersion = (): string => {
  try {
    return JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version as string
  } catch { return 'latest' }
}

/** Best-effort: a failed global install must not block the skill/MCP setup below — the npx run
 *  itself still completes the agent onboarding, and the manual fallback is one line. */
export async function ensureCliInstalled(
  run: Runner,
  channel: Channel = detectChannel(),
  onPath = findDurableOnPath('insta'),
  recheck: () => boolean = () => findDurableOnPath('insta'),
): Promise<void> {
  if (channel !== 'npm' || onPath) return
  info('installing the insta CLI globally (npm) …')
  const { cmd, args } = selfInstallCmd(cliVersion())
  const res = await run(cmd, args)
  if (res.ok) {
    // A clean `npm i -g` can still land in a bin dir that isn't on PATH (custom npm prefix) —
    // exactly the machines this path exists for. Only claim success after re-finding the shim.
    if (recheck()) {
      info('✓ insta CLI — installed globally (`insta` now works in any shell)')
    } else {
      info('✓ insta CLI — installed globally, but npm\'s global bin dir is not on PATH')
      info('    add it to PATH (POSIX: `$(npm prefix -g)/bin`; Windows: the dir `npm prefix -g` prints), then verify with `insta --version`')
    }
    return
  }
  info('  global CLI install failed — continuing with agent setup; install manually with:')
  info('    npm install -g insta')
  if (/EACCES|permission denied/i.test(res.output ?? '')) {
    info('    (permission error: the npm prefix is system-owned — use a Node version manager, or elevate that one command)')
  }
}

// ---- Windows-safe spawning for npm/npx ----
// On Windows `npm`/`npx` are .cmd shims, which spawn() without a shell refuses (Node docs:
// spawning .bat/.cmd needs a shell or cmd.exe). Rather than a shell (argument-quoting hazards),
// re-enter them as node scripts: the CLI script named by npm_execpath (swapped between
// npm-cli.js and npx-cli.js as needed), else the one shipped beside the running node, else the
// bare name (POSIX, where PATH shims resolve fine). Same strategy as `selfInstallCmd` below —
// this one is applied inside the default runner so every `run('npx', …)` call site benefits.
export function resolveSpawnable(
  cmd: string,
  args: string[],
  npmExecpath = process.env.npm_execpath,
  execPath = process.execPath,
  platform: NodeJS.Platform = process.platform,
): { cmd: string; args: string[] } {
  if (cmd !== 'npm' && cmd !== 'npx') {
    // Other CLIs we shell out to (claude) are ALSO .cmd shims on Windows when npm-installed.
    // Their implementation layout isn't ours to know, so route them through cmd.exe (the
    // documented way to run .cmd files). No manual quoting: libuv already wraps spaced args in
    // double quotes when building the child command line, and our args are simple constants /
    // URLs / tokens (no inner quotes, carets, or percent signs) — pre-quoting here would be
    // quoted AGAIN by libuv and reach the target with literal quote characters.
    if (platform === 'win32') return { cmd: 'cmd.exe', args: ['/d', '/s', '/c', cmd, ...args] }
    return { cmd, args }
  }
  if (npmExecpath && /(^|[\\/])np[mx](-cli)?\.[cm]?js$/.test(npmExecpath)) {
    const cli = npmExecpath.replace(/np[mx](-cli)?(\.[cm]?js)$/, `${cmd}$1$2`)
    if (existsSync(cli)) return { cmd: execPath, args: [cli, ...args] }
  }
  const nodeDir = dirname(execPath)
  const besideNode = platform === 'win32'
    ? join(nodeDir, 'node_modules', 'npm', 'bin', `${cmd}-cli.js`)
    : join(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', `${cmd}-cli.js`)
  if (existsSync(besideNode)) return { cmd: execPath, args: [besideNode, ...args] }
  return { cmd, args }
}

// Capture stdout+stderr silently (don't stream) so we can print our own clean summary.
// stdin is 'ignore', NOT 'inherit': under the canonical `curl … | sh` install, stdin is the
// piped install script itself — a child that inherits it (npx/skills reads for keypresses even
// with -y) consumes the rest of the script, so the shell never runs the trailing "Get started"
// guidance. Ignoring stdin keeps the installer's own output intact. (-y means no prompt anyway.)
const defaultRunner: Runner = (cmdIn, argsIn) =>
  new Promise((resolve) => {
    const { cmd, args } = resolveSpawnable(cmdIn, argsIn)
    const env: NodeJS.ProcessEnv = { ...process.env, AI_AGENT: process.env.AI_AGENT || 'insta', FORCE_COLOR: '0' }
    // When THIS process was launched by npx, npx exports its flags as npm_config_* env vars.
    // npm_config_package pins package resolution for every nested npm/npx child — the inner
    // `npx -y skills …` would then resolve `skills` against the insta package and degrade to
    // `sh: skills: command not found`. Scrub the resolution-pinning vars; keep prefix/registry
    // (deliberate user configuration).
    delete env.npm_config_package
    delete env.npm_config_call
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], env })
    let output = ''
    const grab = (chunk: Buffer) => { output += chunk.toString() }
    p.stdout?.on('data', grab)
    p.stderr?.on('data', grab)
    p.on('error', () => resolve({ ok: false, output }))
    p.on('close', (code) => resolve({ ok: code === 0, output }))
  })

// Leading -y is npx's OWN flag: on a machine where the `skills` package isn't already in the
// npx cache, non-TTY `npx skills …` refuses to auto-install and degrades to a shell lookup
// (`sh: skills: command not found`) — the trailing -y only answers the skills TOOL's prompt.
// -g = user-level (machine-global); -a '*' = every agent dir the skills tool supports
// (Claude Code, Codex, Cursor, OpenCode, Copilot, …); --copy = real files, not cache symlinks.
// `spec` is the skill source for the resolved environment (`owner/repo` or `owner/repo@ref`), so a
// staging install reads the staging skill text rather than what's published on main.
export const setupArgs = (spec: string): string[] =>
  ['-y', 'skills', 'add', spec, '-s', 'insta', '-a', '*', '-g', '-y', '--copy']

/** Production's args. Kept as a named export because it is the installed-base default and is
 *  asserted directly by tests; runtime goes through `setupArgs(resolveEnv().skills)`. */
export const SETUP_ARGS = setupArgs(ENVS[DEFAULT_ENV].skills)

// ---- remote MCP registration ----

// Prod's name/URL, kept as named exports because they are the installed-base defaults and are
// asserted directly by tests. Everything at runtime goes through `resolveMcpTarget()` instead, so
// a staging install registers staging's MCP server under its own name rather than reusing prod's.
export const MCP_SERVER_NAME = mcpServerName(DEFAULT_ENV)
export const DEFAULT_MCP_URL = ENVS[DEFAULT_ENV].mcp

/** The MCP server this machine should register, derived from the SAME resolved environment as the
 *  control-plane API. Returning name and url together is deliberate: they must never be chosen
 *  independently, or a staging machine ends up registering prod's URL under prod's name. */
export async function resolveMcpTarget(): Promise<{ name: string; url: string }> {
  const { env, mcpUrl } = await resolveEnv()
  return { name: mcpServerName(env ?? DEFAULT_ENV), url: mcpUrl }
}

// Headless fallback only (`--mcp-token`): the MCP config outlives the CLI's refreshable
// session, so a static-header registration needs a durable `insta_` API token — minted once,
// named after this machine. Returns null when not logged in (or the mint fails); the caller
// prints the login hint.
export type TokenMinter = () => Promise<string | null>
const defaultMinter: TokenMinter = async () => {
  try {
    const api = await ApiClient.load()
    if (!api.config.accessToken) return null
    const { token } = await api.request<{ token?: string }>('POST', '/tokens', { name: `mcp-${os.hostname()}` })
    return token ?? null
  } catch { return null }
}

// Register the insta-cloud remote MCP server with Claude Code (user scope, so it follows the
// machine like the skill install above). Default is OAuth: register with NO credential — the
// platform's Better Auth MCP authorization server is discovered via RFC 9728 and Claude runs
// the browser flow on first `/mcp` use, so no static token ever lands on disk. `--mcp-token`
// is the headless fallback (CI, no browser): mint a durable token into the header instead.
// Idempotent — an existing registration is left alone. Best-effort: the skill install is the
// primary outcome; agents without an MCP registry are covered by the skill alone.
export async function registerMcp(run: Runner = defaultRunner, mint: TokenMinter = defaultMinter, useToken = false): Promise<void> {
  const { name, url } = await resolveMcpTarget()
  if (!(await run('claude', ['--version'])).ok) return // no Claude Code on this machine
  if ((await run('claude', ['mcp', 'get', name])).ok) {
    info(`✓ MCP — ${name} already registered with Claude Code`)
    return
  }
  const args = ['mcp', 'add', '--transport', 'http', '--scope', 'user', name, url]
  if (useToken) {
    const token = await mint()
    if (!token) {
      info('  MCP not registered (--mcp-token needs a login) — run `insta login`, then `insta setup agent --mcp-token` again')
      return
    }
    args.push('--header', `Authorization: Bearer ${token}`)
  }
  const res = await run('claude', args)
  if (res.ok) {
    info(`✓ MCP — ${name} registered with Claude Code (\`claude mcp list\` to verify)`)
    if (!useToken) info('  first use: run `/mcp` in Claude Code and authorize in the browser (headless machines: `insta setup agent --mcp-token`)')
  } else {
    info(`  MCP registration failed — add manually:\n    claude mcp add --transport http ${name} ${url}`)
  }
}

export async function setupAgent(
  opts: { yes?: boolean; mcpToken?: boolean },
  run: Runner = defaultRunner,
  mint?: TokenMinter,
  installConfigs: (agent?: string) => Promise<string[]> = installAgentConfigs,
  ensure: (run: Runner) => Promise<void> = (r) => ensureCliInstalled(r),
): Promise<void> {
  if (!opts.yes && !process.stdout.isTTY) {
    info('non-interactive shell — assuming -y')
  }
  // BEFORE the skill install: the skill tells agents to run `insta …`, so a durable CLI must
  // exist by the time it lands.
  await ensure(run)
  // One resolve for the whole step, so the skills and the MCP registration below cannot disagree
  // about which environment this machine belongs to.
  const { env, skills } = await resolveEnv()
  const args = setupArgs(skills)
  info(env && env !== DEFAULT_ENV
    ? `setting up coding-agent skills (${env}) …`
    : 'setting up coding-agent skills …')
  const res = await run('npx', args)
  if (!res.ok) {
    info('  skill install failed — install manually with:')
    info(`    npx ${args.map((a) => (a === '*' ? '"*"' : a)).join(' ')}`)
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
  await registerMcp(run, mint, !!opts.mcpToken)
  const others = await installConfigs()
  if (others.length) info(`✓ MCP — also configured for ${others.join(', ')} (restart those tools to pick it up)`)
}
