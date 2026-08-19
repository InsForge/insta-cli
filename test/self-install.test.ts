import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, expect } from 'vitest'
import { ensureCliInstalled, findDurableOnPath, selfInstallCmd } from '../src/commands/setup.js'

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

test('selfInstallCmd falls back to plain npm when no npm_execpath is present (or it is not a script)', () => {
  expect(selfInstallCmd('1.2.3', '')).toEqual({ cmd: 'npm', args: ['install', '-g', 'insta@1.2.3'] })
  expect(selfInstallCmd('1.2.3', '/usr/local/bin/bun', '/usr/local/bin/bun')).toEqual({ cmd: 'npm', args: ['install', '-g', 'insta@1.2.3'] })
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
  // recheck false (custom npm prefix off PATH) must not throw and must not set an exit code —
  // the setup continues either way; the distinction is only which guidance line is printed.
  const prev = process.exitCode
  await ensureCliInstalled(async () => ({ ok: true, output: '' }), 'npm', false, () => false)
  expect(process.exitCode).toBe(prev)
  process.exitCode = prev
})

test('ensureCliInstalled is best-effort: a failed global install does not throw or set an exit code', async () => {
  const prev = process.exitCode
  await ensureCliInstalled(async () => ({ ok: false, output: 'npm ERR! EACCES permission denied' }), 'npm', false, () => false)
  expect(process.exitCode).toBe(prev)
  process.exitCode = prev
})
