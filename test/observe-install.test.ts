// The Claude Code hooks schema executes `command` as ONE shell string ($CLAUDE_PROJECT_DIR is an
// env var the shell expands). The installer used to emit command:'node' + an args array with a
// ${CLAUDE_PROJECT_DIR} template — nothing expands it, so node threw MODULE_NOT_FOUND after EVERY
// tool call in every linked project. Found live (user report, 2026-07-12).
import { test, expect } from 'vitest'
import { mkdtempSync, readFileSync, mkdirSync, writeFileSync, realpathSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installObserve } from '../src/observe/install.js'

const posixTest = process.platform === 'win32' ? test.skip : test

// The install materializes ./.insta/observe (this CLI version's hook, regenerated on every link)
// and the hook appends ./.insta/audit.jsonl (this machine's findings: partial fingerprints +
// redacted context). Neither is project source; both used to be left for the user to discover in
// `git status` (user report, 2026-09-04). ./.insta/project.json is the team binding and must NOT
// be caught by these entries.
test('install gitignores the machine-local .insta state but not project.json, idempotently', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'obs-proj-'))
  writeFileSync(join(cwd, '.gitignore'), 'node_modules\n')
  const first = installObserve({ cwd, assetDir: fakeAssets() })
  expect(first.ignored).toEqual(['.insta/observe/', '.insta/audit.jsonl'])
  const gi = readFileSync(join(cwd, '.gitignore'), 'utf8')
  expect(gi).toMatch(/^node_modules$/m) // existing content preserved
  expect(gi).toMatch(/^\.insta\/observe\/$/m)
  expect(gi).toMatch(/^\.insta\/audit\.jsonl$/m)
  expect(gi).not.toMatch(/^\.insta\/?$/m) // never the whole dir: project.json stays committable
  expect(installObserve({ cwd, assetDir: fakeAssets() }).ignored).toEqual([]) // re-link adds nothing
})

// Codex has no $CLAUDE_PROJECT_DIR, so the installer used to bake the absolute project path into
// .codex/hooks.json — a file teams commit — which shipped /Users/<author>/… to every clone and
// failed there after every tool call. The replacement must ALSO survive two things a first cut
// got wrong (review of #178): a monorepo where the insta project root is below the git root
// (`git rev-parse --show-toplevel` finds the wrong dir → hook silently dead), and Windows, where
// Codex hands `command` verbatim to cmd.exe unless a `commandWindows` override exists (POSIX
// `[ ! -f … ]` → parse error after every tool call). So: one shell-neutral `node -e` that climbs
// from the session cwd. These tests run the command through the platform shell (`shell: true` →
// sh on POSIX, cmd.exe on Windows), so the Windows CI job exercises the real thing.
const codexCommand = (cwd: string): string =>
  JSON.parse(readFileSync(join(cwd, '.codex', 'hooks.json'), 'utf8')).hooks.PostToolUse.at(-1).hooks[0].command
const runHook = (cmd: string, cwd: string, input = '{}') => spawnSync(cmd, { cwd, shell: true, input })

test('codex hook entry is shell-neutral: no absolute path, no POSIX syntax, nothing sh or cmd.exe rewrites', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'obs-proj-'))
  installObserve({ cwd, assetDir: fakeAssets() })
  const cmd = codexCommand(cwd)
  expect(cmd).not.toContain(cwd)
  expect(cmd).toMatch(/^node -e "[^"]+"$/) // one double-quoted script, no inner quotes
  expect(cmd).not.toMatch(/[$`%!]/) // $ and ` expand in sh; % and ! in cmd.exe
  expect(cmd).not.toContain('[ ') // no test(1)
  expect(cmd).toContain('.insta/observe/hook.js') // keeps the legacy-entry marker isInstaHook keys on
})

test('codex hook climbs to the insta root from a nested monorepo project and passes stdin through', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'obs-mono-')))
  expect(spawnSync('git', ['init', '-q'], { cwd: root }).status).toBe(0) // git root ≠ project root
  const project = join(root, 'apps', 'api')
  mkdirSync(project, { recursive: true })
  installObserve({ cwd: project, assetDir: fakeAssets() })
  writeFileSync(join(project, '.insta', 'observe', 'hook.js'),
    "process.stdin.on('data', (d) => process.stdout.write('got:' + d))")
  const cmd = codexCommand(project)
  // from the project dir, and from a subdirectory of it (the session cwd is wherever Codex runs)
  const sub = join(project, 'src', 'routes')
  mkdirSync(sub, { recursive: true })
  for (const dir of [project, sub]) {
    const r = runHook(cmd, dir, '{"tool_name":"Bash"}')
    expect(r.status).toBe(0)
    expect(r.stdout.toString()).toBe('got:{"tool_name":"Bash"}')
  }
  // from the git root itself there is no .insta above → silent no-op, not an error
  const atRoot = runHook(cmd, root)
  expect(atRoot.status).toBe(0)
  expect(atRoot.stdout.toString() + atRoot.stderr.toString()).toBe('')
})

test('codex hook is a silent no-op on a fresh clone with no ./.insta anywhere above', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'obs-proj-'))
  installObserve({ cwd, assetDir: fakeAssets() })
  const bare = mkdtempSync(join(tmpdir(), 'obs-clone-'))
  const r = runHook(codexCommand(cwd), bare)
  expect(r.status).toBe(0)
  expect(r.stdout.toString() + r.stderr.toString()).toBe('')
})

// A .gitignore entry does nothing for a path git already tracks — and the repos that most need
// these entries are the ones where audit.jsonl was committed before the CLI ignored it. The
// install reports those so the command can print the `git rm --cached` hint.
posixTest('install reports LOCAL_PATHS entries git already tracks', () => {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'obs-proj-')))
  const git = (...args: string[]) => spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd })
  expect(git('init', '-q').status).toBe(0)
  mkdirSync(join(cwd, '.insta'), { recursive: true })
  writeFileSync(join(cwd, '.insta', 'audit.jsonl'), '{}\n')
  expect(git('add', '-f', '.insta/audit.jsonl').status).toBe(0) // -f: immune to a global excludes file
  expect(git('commit', '-q', '-m', 'oops').status).toBe(0)
  const r = installObserve({ cwd, assetDir: fakeAssets() })
  expect(r.tracked).toEqual(['.insta/audit.jsonl']) // observe/ is untracked → not reported
  const fresh = installObserve({ cwd: mkdtempSync(join(tmpdir(), 'obs-nogit-')), assetDir: fakeAssets() })
  expect(fresh.tracked).toEqual([]) // not a repo → nothing to report, no error
})

function fakeAssets(): string {
  const d = mkdtempSync(join(tmpdir(), 'obs-assets-'))
  writeFileSync(join(d, 'hook.js'), '// hook')
  writeFileSync(join(d, 'scanner.js'), '// scanner')
  return d
}

test('claude hook entry is a single shell-string command with $CLAUDE_PROJECT_DIR (no args array)', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'obs-proj-'))
  mkdirSync(join(cwd, '.claude'), { recursive: true })
  installObserve({ cwd, assetDir: fakeAssets() })
  const settings = JSON.parse(readFileSync(join(cwd, '.claude', 'settings.json'), 'utf8'))
  const hook = settings.hooks.PostToolUse.at(-1).hooks[0]
  expect(hook.args).toBeUndefined()
  expect(hook.command).toBe(
    '[ ! -f "$CLAUDE_PROJECT_DIR/.insta/observe/hook.js" ] || node "$CLAUDE_PROJECT_DIR/.insta/observe/hook.js"')
})

// .claude/settings.json is often committed while ./.insta stays local-only, so a fresh clone
// (cloud code session, teammate checkout) has the hook registered but no hook.js — the command
// must no-op there, not spam MODULE_NOT_FOUND after every tool call. Found live (2026-07-15).
posixTest('hook command exits 0 when .insta/observe/hook.js is absent, runs it when present', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'obs-proj-'))
  mkdirSync(join(cwd, '.claude'), { recursive: true })
  installObserve({ cwd, assetDir: fakeAssets() })
  const settings = JSON.parse(readFileSync(join(cwd, '.claude', 'settings.json'), 'utf8'))
  const cmd = settings.hooks.PostToolUse.at(-1).hooks[0].command
  const run = (projectDir: string) =>
    spawnSync('sh', ['-c', cmd], { env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir } })
  const bare = mkdtempSync(join(tmpdir(), 'obs-clone-')) // fresh clone: no .insta at all
  expect(run(bare).status).toBe(0)
  expect(run(bare).stderr.toString()).toBe('')
  writeFileSync(join(cwd, '.insta', 'observe', 'hook.js'), 'process.stdout.write("ran")')
  expect(run(cwd).stdout.toString()).toBe('ran')
})

test('re-install replaces a broken legacy args-array entry instead of stacking', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'obs-proj-'))
  mkdirSync(join(cwd, '.claude'), { recursive: true })
  writeFileSync(join(cwd, '.claude', 'settings.json'), JSON.stringify({
    hooks: { PostToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'node',
      args: ['${CLAUDE_PROJECT_DIR}/.insta/observe/hook.js'], _insta: 'insta-observe' }] }] },
  }))
  installObserve({ cwd, assetDir: fakeAssets() })
  const settings = JSON.parse(readFileSync(join(cwd, '.claude', 'settings.json'), 'utf8'))
  const all = settings.hooks.PostToolUse.flatMap((g: any) => g.hooks)
  expect(all).toHaveLength(1)
  expect(all[0].args).toBeUndefined()
})
