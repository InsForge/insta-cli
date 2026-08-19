import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test, expect, vi } from 'vitest'
import { ensureCliInstalled, findDurableOnPath, resolveSpawnable, selfInstallCmd, setupAgent, SETUP_ARGS } from '../src/commands/setup.js'

const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version as string

test('findDurableOnPath finds a real global shim and ignores npx cache entries', () => {
  const globalBin = mkdtempSync(join(tmpdir(), 'insta-bin-'))
  const npxBin = join(mkdtempSync(join(tmpdir(), 'insta-npx-')), 'node_modules', '.bin')
  mkdirSync(npxBin, { recursive: true })
  writeFileSync(join(npxBin, 'insta'), '#!/bin/sh\n', { mode: 0o755 })

  // Only the npx cache shim exists — the durable scan must NOT count it.
  expect(findDurableOnPath('insta', { PATH: `${npxBin}:${globalBin}` }, 'linux')).toBe(false)
  // An executable shim in a real bin dir does count.
  writeFileSync(join(globalBin, 'insta'), '#!/bin/sh\n', { mode: 0o755 })
  expect(findDurableOnPath('insta', { PATH: `${npxBin}:${globalBin}` }, 'linux')).toBe(true)
})

test('findDurableOnPath rejects POSIX PATH hits that could not actually run', () => {
  const bin = mkdtempSync(join(tmpdir(), 'insta-noexec-'))
  writeFileSync(join(bin, 'insta'), 'not a program\n', { mode: 0o644 }) // no exec bit
  expect(findDurableOnPath('insta', { PATH: bin }, 'linux')).toBe(false)
  const bin2 = mkdtempSync(join(tmpdir(), 'insta-dir-'))
  mkdirSync(join(bin2, 'insta')) // a DIRECTORY named insta
  expect(findDurableOnPath('insta', { PATH: bin2 }, 'linux')).toBe(false)
})

test('findDurableOnPath resolves Windows shims via PATHEXT (insta.cmd) and the extensionless sh shim', () => {
  const bin = mkdtempSync(join(tmpdir(), 'insta-win-'))
  writeFileSync(join(bin, 'insta.CMD'), '@echo off\n')
  const env = { PATH: bin, PATHEXT: '.COM;.EXE;.BAT;.CMD' }
  expect(findDurableOnPath('insta', env, 'win32')).toBe(true)
  // npm also writes an extensionless sh shim — found even without a PATHEXT match.
  const bin2 = mkdtempSync(join(tmpdir(), 'insta-win2-'))
  writeFileSync(join(bin2, 'insta'), '#!/bin/sh\n')
  expect(findDurableOnPath('insta', { PATH: bin2, PATHEXT: '.COM;.EXE' }, 'win32')).toBe(true)
})

test('selfInstallCmd re-enters the spawning npm and pins the running version', () => {
  const { cmd, args } = selfInstallCmd('1.2.3', '/nvm/v20/lib/node_modules/npm/bin/npx-cli.js', '/nvm/v20/bin/node')
  expect(cmd).toBe('/nvm/v20/bin/node')
  expect(args).toEqual(['/nvm/v20/lib/node_modules/npm/bin/npm-cli.js', 'install', '-g', 'insta@1.2.3'])
})

test('selfInstallCmd never re-enters a non-npm launcher (yarn.js, pnpm.cjs, bun, none)', () => {
  const fallback = { cmd: 'npm', args: ['install', '-g', 'insta@1.2.3'] }
  const fakeNode = '/fake/prefix/bin/node' // no npm beside it → bare-npm last resort
  expect(selfInstallCmd('1.2.3', '', fakeNode, 'linux')).toEqual(fallback)
  expect(selfInstallCmd('1.2.3', '/fake/tools/bun', '/fake/tools/bun', 'linux')).toEqual(fallback)
  // yarn classic sets npm_execpath to yarn.js — `node yarn.js install -g` is not a valid
  // invocation of anything, so it must NOT be re-entered.
  expect(selfInstallCmd('1.2.3', '/usr/lib/yarn/bin/yarn.js', fakeNode, 'linux')).toEqual(fallback)
  expect(selfInstallCmd('1.2.3', '/usr/lib/pnpm/dist/pnpm.cjs', fakeNode, 'linux')).toEqual(fallback)
})

test('selfInstallCmd without npm_execpath uses the npm shipped beside the running node (spawnable on Windows)', () => {
  // POSIX layout: <prefix>/bin/node + <prefix>/lib/node_modules/npm/bin/npm-cli.js
  const posixPrefix = mkdtempSync(join(tmpdir(), 'insta-node-'))
  const posixNpm = join(posixPrefix, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')
  mkdirSync(dirname(posixNpm), { recursive: true })
  writeFileSync(posixNpm, '')
  const posixNode = join(posixPrefix, 'bin', 'node')
  expect(selfInstallCmd('1.2.3', '', posixNode, 'linux'))
    .toEqual({ cmd: posixNode, args: [posixNpm, 'install', '-g', 'insta@1.2.3'] })

  // Windows layout: <dir>\node.exe + <dir>\node_modules\npm\bin\npm-cli.js — bare `npm` would
  // be npm.cmd, which spawn() without a shell refuses.
  const winDir = mkdtempSync(join(tmpdir(), 'insta-nodew-'))
  const winNpm = join(winDir, 'node_modules', 'npm', 'bin', 'npm-cli.js')
  mkdirSync(dirname(winNpm), { recursive: true })
  writeFileSync(winNpm, '')
  const winNode = join(winDir, 'node.exe')
  expect(selfInstallCmd('1.2.3', '', winNode, 'win32'))
    .toEqual({ cmd: winNode, args: [winNpm, 'install', '-g', 'insta@1.2.3'] })
})

test('ensureCliInstalled installs globally only on the npm channel with no durable insta', async () => {
  const runs: string[][] = []
  const runner = async (_cmd: string, args: string[]) => { runs.push(args); return { ok: true, output: '' } }

  await ensureCliInstalled(runner, 'npm', false, () => true)
  expect(runs).toHaveLength(1)
  expect(runs[0]!.slice(-3)).toEqual(['install', '-g', `insta@${VERSION}`]) // pinned to the running version

  runs.length = 0
  await ensureCliInstalled(runner, 'npm', true) // already durable — idempotent no-op
  await ensureCliInstalled(runner, 'binary', false) // native install — never npm-installs over it
  await ensureCliInstalled(runner, 'source', false) // dev checkout — never self-installs
  expect(runs).toHaveLength(0)
})

test('ensureCliInstalled only claims success after re-finding insta on PATH', async () => {
  const captured = (): { out: () => string; restore: () => void } => {
    let out = ''
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((s) => { out += String(s); return true })
    return { out: () => out, restore: () => spy.mockRestore() }
  }
  // recheck true → the unqualified success line
  let cap = captured()
  await ensureCliInstalled(async () => ({ ok: true, output: '' }), 'npm', false, () => true)
  cap.restore()
  expect(cap.out()).toContain('now works in any shell')

  // recheck false (custom npm prefix off PATH) → the add-to-PATH guidance, NOT the success claim
  cap = captured()
  await ensureCliInstalled(async () => ({ ok: true, output: '' }), 'npm', false, () => false)
  cap.restore()
  expect(cap.out()).toContain('not on PATH')
  expect(cap.out()).not.toContain('now works in any shell')
})

test('resolveSpawnable re-enters npm/npx as node scripts so Windows .cmd shims are never spawned', () => {
  // From npm_execpath: an npm-cli.js execpath resolves an `npx` call to its sibling npx-cli.js.
  const npmBin = mkdtempSync(join(tmpdir(), 'insta-npmbin-'))
  const npmCli = join(npmBin, 'npm-cli.js')
  const npxCli = join(npmBin, 'npx-cli.js')
  writeFileSync(npmCli, '')
  writeFileSync(npxCli, '')
  expect(resolveSpawnable('npx', ['skills', 'add'], npmCli, '/fake/bin/node', 'win32'))
    .toEqual({ cmd: '/fake/bin/node', args: [npxCli, 'skills', 'add'] })

  // Beside the running node (Windows layout), covering the default command path on win32.
  const winDir = mkdtempSync(join(tmpdir(), 'insta-winnode-'))
  const winNpx = join(winDir, 'node_modules', 'npm', 'bin', 'npx-cli.js')
  mkdirSync(dirname(winNpx), { recursive: true })
  writeFileSync(winNpx, '')
  const winNode = join(winDir, 'node.exe')
  expect(resolveSpawnable('npx', ['skills', 'add'], '', winNode, 'win32'))
    .toEqual({ cmd: winNode, args: [winNpx, 'skills', 'add'] })

  // Non-npm commands and unresolvable environments pass through untouched.
  expect(resolveSpawnable('claude', ['--version'], npmCli, winNode, 'win32'))
    .toEqual({ cmd: 'claude', args: ['--version'] })
  expect(resolveSpawnable('npx', ['skills'], '', '/fake/bin/node', 'linux'))
    .toEqual({ cmd: 'npx', args: ['skills'] })
})

test('setupAgent self-installs the CLI BEFORE the skill install (the skill points agents at `insta`)', async () => {
  const runs: string[][] = []
  const runner = async (_cmd: string, args: string[]) => { runs.push(args); return { ok: true, output: '' } }
  await setupAgent(
    { yes: true },
    runner,
    undefined,
    async () => [],
    (r) => ensureCliInstalled(r, 'npm', false, () => true), // force the npx-with-no-durable-insta case
  )
  expect(runs[0]!.slice(-3)).toEqual(['install', '-g', `insta@${VERSION}`])
  // Shape, not exact args: the skill source varies with the resolved environment, and
  // SETUP_ARGS' content is already asserted in setup-agent.test.ts. This test is about ORDER.
  expect(runs[1]!.slice(0, 2)).toEqual(SETUP_ARGS.slice(0, 2)) // ['skills', 'add']
  expect(runs[1]!.join(' ')).toContain('-s insta')
})

test('ensureCliInstalled is best-effort: a failed install prints the fallback (and the EACCES hint) without an exit code', async () => {
  const prev = process.exitCode
  let out = ''
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((s) => { out += String(s); return true })
  await ensureCliInstalled(async () => ({ ok: false, output: 'npm ERR! EACCES permission denied' }), 'npm', false, () => false)
  spy.mockRestore()
  expect(out).toContain('npm install -g insta') // the manual fallback line
  expect(out).toContain('permission error') // the targeted EACCES hint
  expect(process.exitCode).toBe(prev)
  process.exitCode = prev
})
