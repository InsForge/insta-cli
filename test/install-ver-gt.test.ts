// install.sh's ver_gt guards against the installer silently downgrading a machine that
// auto-updated to a newer prerelease (v0.0.23-rc.1 downgraded to stable v0.0.22 on every
// re-run — found live, 2026-08-02). These tests run the REAL function extracted from
// install.sh, so an awk refactor can't quietly change the four behaviors the guard exists for.
// Duplication note: keep behavior in sync with cmpSemver (src/commands/upgrade.ts).
import { test, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

const installSh = readFileSync(join(__dirname, '..', 'install.sh'), 'utf8')
const fn = installSh.match(/^ver_gt\(\) \{[\s\S]*?^\}/m)?.[0]

function verGt(a: string, b: string): boolean {
  const r = spawnSync('sh', ['-c', `${fn}\nver_gt "${a}" "${b}"`])
  return r.status === 0
}

test('ver_gt is present in install.sh', () => {
  expect(fn).toBeTruthy()
})

test('auto-updated prerelease is kept over the older stable it follows', () => {
  expect(verGt('v0.0.23-rc.1', 'v0.0.22')).toBe(true)
})

test('older install is upgraded', () => {
  expect(verGt('v0.0.21', 'v0.0.22')).toBe(false)
})

test('exact-equal versions are not "newer" (equality path handles the skip)', () => {
  expect(verGt('v0.0.22', 'v0.0.22')).toBe(false)
})

test('prerelease graduates to its own stable release instead of pinning forever', () => {
  expect(verGt('v0.0.23-rc.1', 'v0.0.23')).toBe(false)
})

test('numeric compare, not lexicographic', () => {
  expect(verGt('v0.1.0', 'v0.0.99')).toBe(true)
  expect(verGt('v0.0.99', 'v0.1.0')).toBe(false)
})
