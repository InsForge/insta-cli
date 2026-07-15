import { test, expect } from 'vitest'
import { setupAgent, SETUP_ARGS } from '../src/commands/setup.js'

test('setup agent installs the insta skill user-globally for all agents', async () => {
  const runs: string[][] = []
  await setupAgent({ yes: true }, async (_cmd, args) => { runs.push(args); return { ok: true, output: '' } })
  expect(runs).toHaveLength(1)
  expect(runs[0]).toEqual(SETUP_ARGS)
  expect(SETUP_ARGS).toContain('-g')          // user-level, not per-project
  expect(SETUP_ARGS).toContain('*')           // every agent dir
  expect(SETUP_ARGS.join(' ')).toContain('-s insta') // ONLY the product skill — stack skills stay project-scoped
  expect(SETUP_ARGS.join(' ')).not.toMatch(/tigris|neon|better-auth/)
})

test('failed install sets exit code and prints the manual fallback', async () => {
  const prev = process.exitCode
  await setupAgent({ yes: true }, async () => ({ ok: false, output: '' }))
  expect(process.exitCode).toBe(1)
  process.exitCode = prev
})
