import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, expect, vi } from 'vitest'
import { ensureCliInstalled, findDurableOnPath, selfInstallCmd, setupAgent, SETUP_ARGS } from '../src/commands/setup.js'

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

test('selfInstallCmd falls back to plain npm when npm_execpath is absent or not an npm/npx script', () => {
  const fallback = { cmd: 'npm', args: ['install', '-g', 'insta@1.2.3'] }
  expect(selfInstallCmd('1.2.3', '')).toEqual(fallback)
  expect(selfInstallCmd('1.2.3', '/usr/local/bin/bun', '/usr/local/bin/bun')).toEqual(fallback)
  // yarn classic sets npm_execpath to yarn.js — `node yarn.js install -g` is not a valid
  // invocation of anything, so it must NOT be re-entered.
  expect(selfInstallCmd('1.2.3', '/usr/lib/yarn/bin/yarn.js')).toEqual(fallback)
  expect(selfInstallCmd('1.2.3', '/usr/lib/pnpm/dist/pnpm.cjs')).toEqual(fallback)
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

test('ensureCliInstalled is best-effort: a failed global install does not throw or set an exit code', async () => {
  const prev = process.exitCode
  await ensureCliInstalled(async () => ({ ok: false, output: 'npm ERR! EACCES permission denied' }), 'npm', false, () => false)
  expect(process.exitCode).toBe(prev)
  process.exitCode = prev
})
