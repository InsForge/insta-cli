import { test, expect, beforeEach, afterEach } from 'vitest'
import { planSetupEnv, setupAgent, shouldOfferLogin, registerMcp, SETUP_ARGS, MCP_SERVER_NAME, DEFAULT_MCP_URL } from '../src/commands/setup.js'
import { ENVS } from '../src/env.js'

// setupAgent's default planner inputs read $INSTA_ENV / $INSTA_API_URL — a developer or CI shell
// with either set would change the plan under these tests. Clear and restore around every test.
const ambient: Record<string, string | undefined> = {}
beforeEach(() => {
  for (const k of ['INSTA_ENV', 'INSTA_API_URL']) { ambient[k] = process.env[k]; delete process.env[k] }
})
afterEach(() => {
  for (const k of ['INSTA_ENV', 'INSTA_API_URL']) {
    if (ambient[k] === undefined) delete process.env[k]; else process.env[k] = ambient[k]
  }
})

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
  // A persisted CUSTOM host with an explicit --env is a plain switch (login --api-url is undone knowingly).
  expect(planSetupEnv('staging', 'https://preview.example.com', undefined, null)).toEqual({ target: 'staging', switch: true })
})

test('planSetupEnv: --env conflicting with an ambient override is an ERROR, never a quiet loser', () => {
  // Everything downstream resolves through resolveEnv(), where the ambient override outranks the
  // persisted config — proceeding would persist one env and install another's skills/MCP.
  expect(() => planSetupEnv('staging', ENVS.prod.api, 'http://127.0.0.1:8080', null)).toThrow(/conflicts with \$INSTA_API_URL/)
  expect(() => planSetupEnv('prod', ENVS.prod.api, undefined, 'staging')).toThrow(/conflicts with \$INSTA_ENV/)
  // Agreeing values are fine (the installer exports nothing, but a CI shell might set both).
  expect(planSetupEnv('staging', ENVS.prod.api, undefined, 'staging')).toEqual({ target: 'staging', switch: true })
  expect(() => planSetupEnv('nope', ENVS.prod.api, undefined, null)).toThrow(/unknown --env/)
})

test('setupAgent surfaces the --env/$INSTA_API_URL conflict before touching anything', async () => {
  process.env.INSTA_API_URL = 'http://127.0.0.1:8080'
  const runs: string[][] = []
  await expect(callSetup({ yes: true, env: 'staging' }, async (_cmd, args) => { runs.push(args); return { ok: true, output: '' } }))
    .rejects.toThrow(/conflicts with \$INSTA_API_URL/)
  expect(runs).toHaveLength(0) // nothing installed, nothing switched
})

test('shouldOfferLogin: only an interactive human terminal with no session', () => {
  expect(shouldOfferLogin(false, false, true, true)).toBe(true)
  expect(shouldOfferLogin(true, false, true, true)).toBe(false)   // -y = non-interactive by request
  expect(shouldOfferLogin(false, true, true, true)).toBe(false)   // already logged in
  expect(shouldOfferLogin(false, false, false, true)).toBe(false) // piped stdin (agents, CI)
  expect(shouldOfferLogin(false, false, true, false)).toBe(false) // redirected stdout
})

test('setup agent flows into GitHub login by default on a TTY when not logged in', async () => {
  const events: string[] = []
  await setupAgent(
    { yes: false }, // interactive
    async (_cmd, args) => { events.push(`run:${args[0]}`); return { ok: true, output: '' } },
    undefined, async () => [], async () => {},
    async () => ({ apiUrl: ENVS.prod.api }), // no session → not logged in
    noSwitch,
    { ask: async (q) => { events.push(`ask:${q.trim()}`); return true }, login: async () => { events.push('login') }, stdinTty: true, stdoutTty: true },
  )
  expect(events).toContain('ask:log in now with GitHub? (Y/n)')
  expect(events[events.length - 1]).toBe('login')
})

test('declined prompt and failed login both end with the manual hint, never an error', async () => {
  const prev = process.exitCode
  // Declined: login never runs.
  let loggedIn = 0
  await setupAgent({ yes: false }, async () => ({ ok: true, output: '' }), undefined, async () => [], async () => {},
    storedProd, noSwitch,
    { ask: async () => false, login: async () => { loggedIn++ }, stdinTty: true, stdoutTty: true })
  expect(loggedIn).toBe(0)
  // Failed: swallowed — setup already succeeded.
  await setupAgent({ yes: false }, async () => ({ ok: true, output: '' }), undefined, async () => [], async () => {},
    storedProd, noSwitch,
    { ask: async () => true, login: async () => { throw new Error('browser exploded') }, stdinTty: true, stdoutTty: true })
  expect(process.exitCode).toBe(prev)
})

test('non-TTY (agents/CI) never prompts for login, even without -y', async () => {
  // yes:false so this exercises the TTY gate itself, not the -y gate (covered above).
  let asked = 0
  await setupAgent({ yes: false }, async () => ({ ok: true, output: '' }), undefined, async () => [], async () => {},
    storedProd, noSwitch,
    { ask: async () => { asked++; return true }, login: async () => { asked++ }, stdinTty: false, stdoutTty: false })
  expect(asked).toBe(0)
})

test('--mcp-token + interactive login registers MCP with the token exactly once, AFTER the session exists', async () => {
  const events: string[] = []
  let sessionExists = false // production defaultMinter returns null while logged out
  await setupAgent(
    { yes: false, mcpToken: true },
    async (cmd, args) => {
      if (args[0] === 'mcp' && args[1] === 'add') events.push('mcp-add')
      else events.push(`${cmd}:${args[0]}`)
      return { ok: !(args[0] === 'mcp' && args[1] === 'get'), output: '' }
    },
    async () => { events.push('mint'); return sessionExists ? 'insta_tok' : null },
    async () => [], async () => {},
    async () => ({ apiUrl: ENVS.prod.api }), noSwitch,
    { ask: async () => true, login: async () => { sessionExists = true; events.push('login') }, stdinTty: true, stdoutTty: true },
  )
  const loginAt = events.indexOf('login')
  expect(loginAt).toBeGreaterThan(-1)
  // The production contract: the logged-out pre-login registration mints null and adds NOTHING;
  // the one and only `mcp add` happens after login.
  expect(events.slice(0, loginAt)).not.toContain('mcp-add')
  expect(events.filter((e) => e === 'mcp-add')).toHaveLength(1)
  expect(events.indexOf('mcp-add')).toBeGreaterThan(loginAt)
})

test('setupAgent surfaces a disagreeing $INSTA_ENV the same way (INSTA_ENV=staging + --env prod)', async () => {
  process.env.INSTA_ENV = 'staging'
  const runs: string[][] = []
  await expect(callSetup({ yes: true, env: 'prod' }, async (_cmd, args) => { runs.push(args); return { ok: true, output: '' } }))
    .rejects.toThrow(/conflicts with \$INSTA_ENV/)
  expect(runs).toHaveLength(0)
  // Agreeing values proceed — and the assets install for that same env (resolveEnv honors
  // $INSTA_ENV, which equals the flag, so the plan and the resolution cannot diverge).
  delete process.env.INSTA_ENV
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
