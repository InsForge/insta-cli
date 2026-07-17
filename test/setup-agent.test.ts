import { test, expect } from 'vitest'
import { setupAgent, registerMcp, SETUP_ARGS, MCP_SERVER_NAME, DEFAULT_MCP_URL } from '../src/commands/setup.js'

test('setup agent installs the insta skill user-globally for all agents', async () => {
  const runs: string[][] = []
  await setupAgent({ yes: true }, async (_cmd, args) => { runs.push(args); return { ok: true, output: '' } }, undefined, async () => [])
  expect(runs[0]).toEqual(SETUP_ARGS)
  expect(SETUP_ARGS).toContain('-g')          // user-level, not per-project
  expect(SETUP_ARGS).toContain('*')           // every agent dir
  expect(SETUP_ARGS.join(' ')).toContain('-s insta') // ONLY the product skill — stack skills stay project-scoped
  expect(SETUP_ARGS.join(' ')).not.toMatch(/tigris|neon|better-auth/)
})

test('failed install sets exit code and prints the manual fallback', async () => {
  const prev = process.exitCode
  const runs: string[][] = []
  await setupAgent({ yes: true }, async (_cmd, args) => { runs.push(args); return { ok: false, output: '' } }, undefined, async () => [])
  expect(process.exitCode).toBe(1)
  expect(runs).toHaveLength(1) // MCP registration is skipped when the skill install fails
  process.exitCode = prev
})

test('setup agent skips MCP registration cleanly when there is no claude binary', async () => {
  const cmds: string[] = []
  await setupAgent({ yes: true }, async (cmd) => {
    cmds.push(cmd)
    if (cmd === 'claude') return { ok: false, output: '' } // `claude --version` fails => not installed
    return { ok: true, output: '' }
  }, undefined, async () => [])
  expect(cmds.filter((c) => c === 'claude')).toHaveLength(1) // only the version probe
})

test('registerMcp is idempotent — an existing registration is left alone (no token minted)', async () => {
  const runs: string[][] = []
  let minted = 0
  await registerMcp(
    async (_cmd, args) => { runs.push(args); return { ok: true, output: '' } },
    async () => { minted++; return 'insta_x_y' },
  )
  expect(runs.map((a) => a.join(' '))).toEqual(['--version', `mcp get ${MCP_SERVER_NAME}`])
  expect(minted).toBe(0)
})

test('registerMcp defaults to OAuth: adds the server with NO auth header and mints nothing', async () => {
  const runs: string[][] = []
  let minted = 0
  await registerMcp(
    async (_cmd, args) => {
      runs.push(args)
      // version probe ok; `mcp get` says not registered; `mcp add` ok
      return { ok: !(args[0] === 'mcp' && args[1] === 'get'), output: '' }
    },
    async () => { minted++; return 'insta_x_y' },
  )
  const add = runs.find((a) => a[0] === 'mcp' && a[1] === 'add')!
  expect(add).toBeDefined()
  expect(add.join(' ')).toContain(`--transport http --scope user ${MCP_SERVER_NAME} ${DEFAULT_MCP_URL}`)
  expect(add).not.toContain('--header') // OAuth flow — no static credential on disk
  expect(minted).toBe(0)
})

test('registerMcp --mcp-token mints a durable token into the Authorization header (headless)', async () => {
  const runs: string[][] = []
  await registerMcp(
    async (_cmd, args) => { runs.push(args); return { ok: !(args[0] === 'mcp' && args[1] === 'get'), output: '' } },
    async () => 'insta_abc_secret',
    true,
  )
  const add = runs.find((a) => a[0] === 'mcp' && a[1] === 'add')!
  expect(add.join(' ')).toContain(`--transport http --scope user ${MCP_SERVER_NAME} ${DEFAULT_MCP_URL}`)
  expect(add.join(' ')).toContain('Authorization: Bearer insta_abc_secret')
})

test('registerMcp --mcp-token prints the login hint instead of registering when no token can be minted', async () => {
  const runs: string[][] = []
  await registerMcp(
    async (_cmd, args) => { runs.push(args); return { ok: !(args[0] === 'mcp' && args[1] === 'get'), output: '' } },
    async () => null, // not logged in
    true,
  )
  expect(runs.some((a) => a[0] === 'mcp' && a[1] === 'add')).toBe(false)
})
