// Install the observe hook into a project's agent harness (Claude Code / Codex) and materialize
// the standalone hook + scanner into ./.insta/observe. Ported from firth (.firth -> .insta).
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const MARKER = 'insta-observe'
const DEFAULT_ASSET_DIR = dirname(fileURLToPath(import.meta.url)) // built: cli/dist/observe

function cliVersion(): string {
  try { return JSON.parse(readFileSync(join(DEFAULT_ASSET_DIR, '..', '..', 'package.json'), 'utf8')).version ?? '0.0.0' }
  catch { return '0.0.0' }
}

function isInstaHook(h: { _insta?: string; command?: string; args?: string[] }): boolean {
  if (h._insta === MARKER) return true
  const blob = `${h.command ?? ''} ${(h.args ?? []).join(' ')}`
  return blob.includes('observe/hook.') // matches .insta/observe/hook.js; trailing dot avoids matching user paths
}

type Group = { matcher?: string; hooks?: Array<Record<string, unknown>> }

function upsert(root: any, entry: Group): void {
  root.hooks ??= {}
  const post: Group[] = Array.isArray(root.hooks.PostToolUse) ? root.hooks.PostToolUse : []
  for (const g of post) g.hooks = (g.hooks ?? []).filter((h) => !isInstaHook(h))
  const pruned = post.filter((g) => (g.hooks ?? []).length > 0)
  pruned.push(entry)
  root.hooks.PostToolUse = pruned
}

function registerHarness(filePath: string, entry: Group): void {
  const root = existsSync(filePath) ? JSON.parse(readFileSync(filePath, 'utf8')) : {}
  upsert(root, entry)
  mkdirSync(dirname(filePath), { recursive: true })
  writeFileSync(filePath, JSON.stringify(root, null, 2) + '\n')
}

function unregisterHarness(filePath: string): void {
  if (!existsSync(filePath)) return
  const root = JSON.parse(readFileSync(filePath, 'utf8'))
  const post: Group[] | undefined = root?.hooks?.PostToolUse
  if (!Array.isArray(post)) return
  for (const g of post) g.hooks = (g.hooks ?? []).filter((h) => !isInstaHook(h))
  root.hooks.PostToolUse = post.filter((g) => (g.hooks ?? []).length > 0)
  writeFileSync(filePath, JSON.stringify(root, null, 2) + '\n')
}

function materialize(cwd: string, assetDir: string): void {
  const dest = join(cwd, '.insta', 'observe')
  mkdirSync(dest, { recursive: true })
  copyFileSync(join(assetDir, 'hook.js'), join(dest, 'hook.js'))     // throws if assets missing (e.g. not built)
  copyFileSync(join(assetDir, 'scanner.js'), join(dest, 'scanner.js'))
  writeFileSync(join(dest, 'package.json'), JSON.stringify({ type: 'module' }, null, 2) + '\n') // run .js as ESM
  writeFileSync(join(dest, 'VERSION'), cliVersion() + '\n')
}

function claudeEntry(): Group {
  // Claude Code executes `command` as ONE shell string with $CLAUDE_PROJECT_DIR in the env —
  // there is no `args` field in its hooks schema, so a ${…} template in args reaches node
  // verbatim and throws MODULE_NOT_FOUND after every tool call.
  // .claude/settings.json is often committed while ./.insta stays local-only, so a fresh
  // clone (cloud session, teammate) gets the hook without the script — no-op there.
  const hook = '"$CLAUDE_PROJECT_DIR/.insta/observe/hook.js"'
  return { matcher: '*', hooks: [{ type: 'command',
    command: `[ ! -f ${hook} ] || node ${hook}`, timeout: 15, _insta: MARKER }] }
}
function codexEntry(cwd: string): Group {
  const abs = join(cwd, '.insta', 'observe', 'hook.js') // Codex doesn't expand ${CLAUDE_PROJECT_DIR}; use an absolute path
  return { matcher: '*', hooks: [{ type: 'command', command: `node ${JSON.stringify(abs)}`, timeout: 15, _insta: MARKER }] }
}

export function installObserve(opts: { cwd: string; assetDir?: string }): { claude: boolean; codex: boolean } {
  materialize(opts.cwd, opts.assetDir ?? DEFAULT_ASSET_DIR) // hook required → let a missing asset throw to the caller
  let claude = false
  let codex = false
  try { registerHarness(join(opts.cwd, '.claude', 'settings.json'), claudeEntry()); claude = true } catch { /* skip malformed */ }
  try { registerHarness(join(opts.cwd, '.codex', 'hooks.json'), codexEntry(opts.cwd)); codex = true } catch { /* skip malformed */ }
  return { claude, codex }
}

export function uninstallObserve(cwd: string): void {
  try { unregisterHarness(join(cwd, '.claude', 'settings.json')) } catch { /* skip */ }
  try { unregisterHarness(join(cwd, '.codex', 'hooks.json')) } catch { /* skip */ }
}
