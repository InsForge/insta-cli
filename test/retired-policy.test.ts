import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

const entry = fileURLToPath(new URL('../src/index.ts', import.meta.url))
const run = (...args: string[]) => spawnSync(process.execPath, ['--import', 'tsx', entry, ...args], { encoding: 'utf8', timeout: 10000 })

it('only exposes agent-policy and rejects the retired policy command', () => {
  const help = run('--help')
  expect(help.status).toBe(0)
  expect(help.stdout).toContain('agent-policy')
  expect(help.stdout).not.toMatch(/^\s+policy\s/m)
  const retired = run('policy', 'get')
  expect(retired.status).not.toBe(0)
  expect(retired.stderr).toContain("unknown command 'policy'")
})

it('rejects approval --always instead of promising a permanent grant', () => {
  const help = run('approvals', 'approve', '--help')
  expect(help.status).toBe(0)
  expect(help.stdout).not.toContain('--always')
  const retired = run('approvals', 'approve', 'test-id', '--always')
  expect(retired.status).not.toBe(0)
  expect(retired.stderr).toContain("unknown option '--always'")
})
