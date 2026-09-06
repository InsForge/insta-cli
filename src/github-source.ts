// Fetch a template manifest out of a GitHub repository, on this machine, with the user's own git
// credentials. Parsing, ref resolution and the shallow clone live here; the deploy path stays in
// commands/template.ts. See docs/superpowers/specs/2026-09-04-template-deploy-github-url-design.md.
import { spawn as nodeSpawn } from 'node:child_process'
import { MANIFEST_FILE } from './template-manifest.js'
import { resolveSpawnable } from './spawn.js'

export type GitHubTarget = { owner: string; repo: string; refAndPath: string }

const GITHUB_HOST = /^(?:https?:\/\/)?(?:www\.)?github\.com\//i
// Checked FIRST: `./x` and `../x` would otherwise read as a dotted host followed by a slash.
const LOCAL_PREFIX = /^[.~/\\]/
// A scheme, an scp-style address, or a dotted first segment: all of these are addresses, not paths.
const URL_SHAPED = /^[a-z][a-z0-9+.-]*:\/\/|^[^/\\]+@[^/\\]+:|^[^/\\]*\.[^/\\]*\//i
const SEGMENT = /^[A-Za-z0-9_.-]+$/

export function unsupportedSourceMessage(target: string): string {
  return `unsupported template source: ${target}. Use a registry code, a local directory, or https://github.com/<owner>/<repo>[/tree/<ref>[/<dir>]]`
}

// Percent-decode first, so %2e%2e and %2f cannot smuggle a traversal past the segment check.
function decodedSegments(parts: string[], target: string): string[] {
  return parts.map((raw) => {
    let seg: string
    try { seg = decodeURIComponent(raw) } catch { throw new Error(unsupportedSourceMessage(target)) }
    if (!seg || seg === '.' || seg === '..' || /[/\\\0]/.test(seg)) throw new Error(unsupportedSourceMessage(target))
    return seg
  })
}

/** Parse a github.com URL into owner, repo and the still-unsplit ref+path tail.
 *  null = not URL-shaped, so the caller's local-directory and registry modes still get a look.
 *  A URL-shaped target that is not a github.com repository URL throws (spec 4.1). */
export function parseGitHubTemplateUrl(target: string): GitHubTarget | null {
  if (!GITHUB_HOST.test(target)) {
    // A path is never an address, whatever dots it carries: `./x` must reach local mode, not throw.
    if (!LOCAL_PREFIX.test(target) && URL_SHAPED.test(target)) throw new Error(unsupportedSourceMessage(target))
    return null
  }
  const rest = target.replace(GITHUB_HOST, '').replace(/\/+$/, '')
  const parts = rest.split('/')
  const owner = parts[0] ?? ''
  const repo = (parts[1] ?? '').replace(/\.git$/i, '')
  if (!SEGMENT.test(owner) || !SEGMENT.test(repo)) throw new Error(unsupportedSourceMessage(target))

  const kind = parts[2]
  if (kind === undefined) return { owner, repo, refAndPath: '' }
  if (kind !== 'tree' && kind !== 'blob') throw new Error(unsupportedSourceMessage(target))

  let tail = decodedSegments(parts.slice(3), target)
  if (!tail.length) throw new Error(unsupportedSourceMessage(target))
  if (kind === 'blob') {
    // A file link is read as its directory, and only for the manifest itself.
    if (tail[tail.length - 1] !== MANIFEST_FILE) throw new Error(unsupportedSourceMessage(target))
    tail = tail.slice(0, -1)
    if (!tail.length) throw new Error(unsupportedSourceMessage(target))
  }
  return { owner, repo, refAndPath: tail.join('/') }
}

export const LS_REMOTE_TIMEOUT_MS = 30_000
export const CLONE_TIMEOUT_MS = 120_000

export type GitResult = { code: number; stdout: string; stderr: string; timedOut: boolean }
export type GitRunner = (args: string[], opts: { timeoutMs: number }) => Promise<GitResult>
export type SpawnFn = typeof nodeSpawn

export function gitMissingMessage(): string {
  return `git is required to deploy a template from a GitHub URL. Install git, or clone the repository yourself and run: insta template deploy ./<dir>`
}

// git asks for nothing: no terminal credential prompt, no SSH host-key or passphrase prompt (an
// insteadOf rewrite can send the clone over SSH). The environment stops it asking; only the
// timeout stops it waiting.
const NON_INTERACTIVE_ENV = {
  GIT_TERMINAL_PROMPT: '0',
  GIT_SSH_COMMAND: 'ssh -o BatchMode=yes',
  GCM_INTERACTIVE: 'never',
}

// git spawns helpers (ssh, a credential manager) that inherit its pipes, so a timeout has to take
// the whole group. Windows has no process groups; taskkill /T walks the tree instead.
function killTree(child: ReturnType<SpawnFn>): void {
  try {
    if (process.platform === 'win32' && child.pid) {
      // spawn reports a missing binary ASYNCHRONOUSLY: without this listener an absent taskkill
      // becomes an uncaught ENOENT that kills the CLI, and try/catch never sees it.
      nodeSpawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
        .on('error', () => { /* best effort; the SIGKILL below still runs */ })
    } else if (child.pid) {
      process.kill(-child.pid, 'SIGKILL') // negative pid addresses the group
    }
  } catch { /* already gone */ }
  try { child.kill('SIGKILL') } catch { /* already gone */ }
}

// A settled promise does not let the CLI exit. Node keeps its event loop alive for an open pipe,
// and a grandchild that escaped the kill still holds the write end. Releasing our read ends and
// unref-ing the child is what actually lets the process end.
function releaseChild(child: ReturnType<SpawnFn>): void {
  try { child.stdout?.destroy() } catch { /* already closed */ }
  try { child.stderr?.destroy() } catch { /* already closed */ }
  try { child.unref() } catch { /* already gone */ }
}

/** spawnFn is injected so the timeout path is testable without a network (spec FAQ 7.15). */
export function makeGitRunner(spawnFn: SpawnFn = nodeSpawn): GitRunner {
  return (args, opts) =>
    new Promise((resolve) => {
      const { cmd, args: spawnArgs } = resolveSpawnable('git', args)
      const child = spawnFn(cmd, spawnArgs, {
        env: { ...process.env, ...NON_INTERACTIVE_ENV },
        stdio: ['ignore', 'pipe', 'pipe'],
        // Own process group on POSIX, so killTree can reach git's helpers.
        detached: process.platform !== 'win32',
      })
      let stdout = ''
      let stderr = ''
      let settled = false
      const finish = (r: GitResult) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(r)
      }
      const timer = setTimeout(() => {
        killTree(child)
        // Then let go of the pipes. Killing can miss a grandchild that changed process group, and
        // its inherited write end would keep BOTH 'close' and the CLI's event loop waiting
        // (measured: promise settled at 203ms, process exited at 20094ms).
        releaseChild(child)
        // Settle NOW. 'close' waits for every inherited pipe; waiting would void the bound.
        finish({ code: -1, stdout, stderr, timedOut: true })
      }, opts.timeoutMs)

      child.stdout?.on('data', (b) => { stdout += b.toString() })
      child.stderr?.on('data', (b) => { stderr += b.toString() })
      child.on('error', (err) => finish({ code: -1, stdout, stderr: `${stderr}${err.message}`, timedOut: false }))
      child.on('close', (code) => finish({ code: code ?? -1, stdout, stderr, timedOut: false }))
    })
}

export const defaultGitRunner: GitRunner = makeGitRunner()
