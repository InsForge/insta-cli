import { test, expect } from 'vitest'
import { planSetupEnv, setupAgent, registerMcp, SETUP_ARGS, MCP_SERVER_NAME, DEFAULT_MCP_URL } from '../src/commands/setup.js'
import { ENVS } from '../src/env.js'

// Isolated persisted-config fakes: never read (or let envUse WRITE) the developer's real
// ~/.insta/config.json from inside the test suite.
const storedProd = async () => ({ apiUrl: ENVS.prod.api })
const noSwitch = async (name: string) => { throw new Error(`unexpected env switch to ${name}`) }
const withStored = { readStored: storedProd, switchEnv: noSwitch }
const callSetup = (
  opts: Parameters<typeof setupAgent>[0],
  run: Parameters<typeof setupAgent>[1],
  ensure?: Parameters<typeof setupAgent>[4],
  io: { readStored?: Parameters<typeof setupAgent>[5]; switchEnv?: Parameters<typeof setupAgent>[6] } = {},
) => setupAgent(opts, run, undefined, async () => [], ensure ?? (async () => {}),
  io.readStored ?? withStored.readStored, io.switchEnv ?? withStored.switchEnv)

test('setup agent installs the insta skill user-globally for all agents', async () => {
  const runs: string[][] = []
  await callSetup({ yes: true }, async (_cmd, args) => { runs.push(args); return { ok: true, output: '' } })
  expect(runs[0]).toEqual(SETUP_ARGS)
  expect(SETUP_ARGS).toContain('-g')          // user-level, not per-project
  expect(SETUP_ARGS).toContain('*')           // every agent dir
  expect(SETUP_ARGS.join(' ')).toContain('-s insta') // ONLY the product skill — stack skills stay project-scoped
  expect(SETUP_ARGS.join(' ')).not.toMatch(/tigris|neon|better-auth/)
})

test('failed install sets exit code and prints the manual fallback', async () => {
  const prev = process.exitCode
  const runs: string[][] = []
  await callSetup({ yes: true }, async (_cmd, args) => { runs.push(args); return { ok: false, output: '' } })
  expect(process.exitCode).toBe(1)
  expect(runs).toHaveLength(1) // MCP registration is skipped when the skill install fails
  process.exitCode = prev
})

test('setup agent skips MCP registration cleanly when there is no claude binary', async () => {
  const cmds: string[] = []
  await callSetup({ yes: true }, async (cmd) => {
    cmds.push(cmd)
    if (cmd === 'claude') return { ok: false, output: '' } // `claude --version` fails => not installed
    return { ok: true, output: '' }
  })
  expect(cmds.filter((c) => c === 'claude')).toHaveLength(1) // only the version probe
})

// ---- environment contract: bare `setup agent` = prod, staging only on explicit ask ----

test('planSetupEnv: bare setup on a prod machine stays put; on a staging machine forces prod', () => {
  expect(planSetupEnv(undefined, ENVS.prod.api, undefined, null)).toEqual({ target: 'prod', switch: false })
  expect(planSetupEnv(undefined, ENVS.staging.api, undefined, null)).toEqual({ target: 'prod', switch: true })
})

test('planSetupEnv: --env staging is the explicit staging path (switching only when needed)', () => {
  expect(planSetupEnv('staging', ENVS.prod.api, undefined, null)).toEqual({ target: 'staging', switch: true })
  expect(planSetupEnv('staging', ENVS.staging.api, undefined, null)).toEqual({ target: 'staging', switch: false })
  expect(planSetupEnv('PROD', ENVS.staging.api, undefined, null)).toEqual({ target: 'prod', switch: true })
})

test('planSetupEnv: deliberate custom hosts are left alone unless --env is given', () => {
  // $INSTA_API_URL set (insta-oss, a preview): hands off.
  expect(planSetupEnv(undefined, ENVS.staging.api, 'http://127.0.0.1:8080', null)).toEqual({ target: null, switch: false })
  // Persisted custom apiUrl (login --api-url): hands off.
  expect(planSetupEnv(undefined, 'https://preview.example.com', undefined, null)).toEqual({ target: null, switch: false })
  // --env still wins over both — an explicit flag is the most specific instruction.
  expect(planSetupEnv('staging', 'https://preview.example.com', 'http://127.0.0.1:8080', null)).toEqual({ target: 'staging', switch: true })
})

test('planSetupEnv: $INSTA_ENV counts as explicit (installer/CI path)', () => {
  expect(planSetupEnv(undefined, ENVS.prod.api, undefined, 'staging')).toEqual({ target: 'staging', switch: true })
  expect(planSetupEnv(undefined, ENVS.staging.api, undefined, 'staging')).toEqual({ target: 'staging', switch: false })
})

test('setup agent on a staging-persisted machine switches to prod BEFORE installing anything', async () => {
  const order: string[] = []
  await setupAgent(
    { yes: true },
    async (_cmd, args) => { order.push(`run:${args[0]}`); return { ok: true, output: '' } },
    undefined,
    async () => [],
    async () => { order.push('ensure') },
    async () => ({ apiUrl: ENVS.staging.api }),
    async (name) => { order.push(`switch:${name}`) },
  )
  expect(order[0]).toBe('switch:prod') // env pinned first — skills/MCP must not land for staging
  expect(order[1]).toBe('ensure')
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
