// Environment resolution (prod | staging) and the guarantees that keep the two from bleeding into
// each other: matched api+mcp hosts, distinct MCP registration names, and a dropped session on
// every switch (prod and staging are separate deployments — a token from one is useless and
// dangerous at the other).
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DEFAULT_ENV, ENVS, ENV_NAMES, envForApiUrl, envFromEnvVar, isEnvName, mcpServerName,
} from '../src/env.js'

const PROD_API = 'https://api.instacloud.com'
const STAGING_API = 'https://api.staging.instacloud.com'

describe('env table', () => {
  it('has a matched api + mcp host for every environment', () => {
    for (const name of ENV_NAMES) {
      expect(ENVS[name].api).toMatch(/^https:\/\//)
      expect(ENVS[name].mcp).toMatch(/^https:\/\/.*\/mcp$/)
    }
  })

  it('points prod and staging at genuinely different hosts', () => {
    expect(ENVS.prod.api).toBe(PROD_API)
    expect(ENVS.staging.api).toBe(STAGING_API)
    expect(ENVS.prod.mcp).not.toBe(ENVS.staging.mcp)
  })

  // The whole point of resolving api+mcp from one switch: staging's mcp host must sit under the
  // staging domain, so a staging install can't end up talking to prod's MCP server.
  it('keeps each environment\'s mcp host under that environment\'s domain', () => {
    expect(ENVS.staging.mcp).toContain('staging.instacloud.com')
    expect(ENVS.prod.mcp).not.toContain('staging')
  })
})

describe('mcpServerName', () => {
  it('keeps the bare name for prod so existing registrations are not orphaned', () => {
    expect(mcpServerName('prod')).toBe('insta-cloud')
  })

  // registerMcp treats an existing name as "already done", so a shared name would leave a staging
  // install silently wired to prod. Distinct names let both coexist on one machine.
  it('gives staging its own name so it can coexist with prod', () => {
    expect(mcpServerName('staging')).toBe('insta-cloud-staging')
    expect(mcpServerName('staging')).not.toBe(mcpServerName('prod'))
  })
})

describe('envForApiUrl', () => {
  it('maps known hosts back to their environment', () => {
    expect(envForApiUrl(PROD_API)).toBe('prod')
    expect(envForApiUrl(STAGING_API)).toBe('staging')
  })

  it('ignores a trailing slash', () => {
    expect(envForApiUrl(STAGING_API + '/')).toBe('staging')
  })

  // A localhost/self-hosted URL is a deliberate choice, not an error — callers must leave it alone.
  it('returns null for a custom host', () => {
    expect(envForApiUrl('http://localhost:8080')).toBeNull()
    expect(envForApiUrl('https://beta-api.insta.insforge.dev')).toBeNull()
  })

  // staging.instacloud.com is a deeper label than instacloud.com; a sloppy suffix match would
  // classify the staging host as prod and provision against the wrong control plane.
  it('does not let the prod host swallow the staging host', () => {
    expect(envForApiUrl(STAGING_API)).not.toBe('prod')
  })
})

describe('envFromEnvVar', () => {
  it('accepts the known names, case- and whitespace-insensitively', () => {
    expect(envFromEnvVar('staging')).toBe('staging')
    expect(envFromEnvVar(' STAGING ')).toBe('staging')
    expect(envFromEnvVar('prod')).toBe('prod')
  })

  it('treats unset and empty as no opinion', () => {
    expect(envFromEnvVar(undefined)).toBeNull()
    expect(envFromEnvVar('')).toBeNull()
    expect(envFromEnvVar('  ')).toBeNull()
  })

  // Silently falling back to prod on a typo would provision real production infrastructure and
  // stay invisible until the bill arrived. Fail loudly instead.
  it('throws on an unknown value rather than falling back to prod', () => {
    expect(() => envFromEnvVar('stagng')).toThrow(/unknown INSTA_ENV/)
    expect(() => envFromEnvVar('production')).toThrow(/unknown INSTA_ENV/)
  })
})

describe('isEnvName', () => {
  it('accepts only the declared environments', () => {
    expect(isEnvName('prod')).toBe(true)
    expect(isEnvName('staging')).toBe(true)
    expect(isEnvName('dev')).toBe(false)
  })

  it('defaults to prod', () => {
    expect(DEFAULT_ENV).toBe('prod')
  })
})

// ---- config resolution + `env use`, against a real temp $HOME ----

describe('config + env use', () => {
  let home: string
  const origHome = process.env.HOME
  const origEnv = process.env.INSTA_ENV
  const origApi = process.env.INSTA_API_URL
  const origMcp = process.env.INSTA_MCP_URL

  const configFile = () => join(home, '.insta', 'config.json')
  const writeConfig = async (c: unknown) => {
    await mkdir(join(home, '.insta'), { recursive: true })
    await writeFile(configFile(), JSON.stringify(c, null, 2))
  }
  const readConfig = async () => JSON.parse(await readFile(configFile(), 'utf8'))

  // config.ts resolves $HOME at import time, so each test needs a fresh module registry.
  const freshConfig = async () => {
    vi.resetModules()
    return await import('../src/config.js')
  }

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'insta-env-'))
    process.env.HOME = home
    delete process.env.INSTA_ENV
    delete process.env.INSTA_API_URL
    delete process.env.INSTA_MCP_URL
  })

  afterEach(() => {
    if (origHome === undefined) delete process.env.HOME; else process.env.HOME = origHome
    if (origEnv === undefined) delete process.env.INSTA_ENV; else process.env.INSTA_ENV = origEnv
    if (origApi === undefined) delete process.env.INSTA_API_URL; else process.env.INSTA_API_URL = origApi
    if (origMcp === undefined) delete process.env.INSTA_MCP_URL; else process.env.INSTA_MCP_URL = origMcp
    vi.resetModules()
  })

  it('defaults a fresh install to prod', async () => {
    const { readGlobal, resolveEnv } = await freshConfig()
    expect((await readGlobal()).apiUrl).toBe(PROD_API)
    expect(await resolveEnv()).toMatchObject({ env: 'prod', apiUrl: PROD_API, mcpUrl: ENVS.prod.mcp })
  })

  it('resolves INSTA_ENV=staging to staging api AND mcp together', async () => {
    process.env.INSTA_ENV = 'staging'
    const { resolveEnv } = await freshConfig()
    expect(await resolveEnv()).toMatchObject({
      env: 'staging', apiUrl: STAGING_API, mcpUrl: ENVS.staging.mcp,
    })
  })

  it('lets INSTA_ENV override a persisted prod apiUrl', async () => {
    await writeConfig({ apiUrl: PROD_API, accessToken: 't' })
    process.env.INSTA_ENV = 'staging'
    const { readGlobal } = await freshConfig()
    expect((await readGlobal()).apiUrl).toBe(STAGING_API)
  })

  // A hand-written URL is the more specific instruction, and the only way to reach a host no
  // environment name covers (insta-oss, a preview deployment).
  it('lets INSTA_API_URL outrank INSTA_ENV', async () => {
    process.env.INSTA_ENV = 'staging'
    process.env.INSTA_API_URL = 'http://localhost:9999'
    const { resolveEnv } = await freshConfig()
    const r = await resolveEnv()
    expect(r.apiUrl).toBe('http://localhost:9999')
    expect(r.env).toBeNull()
  })

  it('lets INSTA_MCP_URL override the environment mcp host', async () => {
    process.env.INSTA_ENV = 'staging'
    process.env.INSTA_MCP_URL = 'http://localhost:1234/mcp'
    const { resolveEnv } = await freshConfig()
    expect(await resolveEnv()).toMatchObject({ env: 'staging', mcpUrl: 'http://localhost:1234/mcp' })
  })

  it('honours a persisted staging apiUrl with no env vars set', async () => {
    await writeConfig({ apiUrl: STAGING_API })
    const { resolveEnv } = await freshConfig()
    expect(await resolveEnv()).toMatchObject({ env: 'staging', mcpUrl: ENVS.staging.mcp })
  })

  it('surfaces a bad INSTA_ENV as an error instead of using prod', async () => {
    process.env.INSTA_ENV = 'nope'
    const { readGlobal } = await freshConfig()
    await expect(readGlobal()).rejects.toThrow(/unknown INSTA_ENV/)
  })

  it('env use persists the switch so it survives the install pipe', async () => {
    await writeConfig({ apiUrl: PROD_API })
    vi.resetModules()
    const { envUse } = await import('../src/commands/env.js')
    await envUse('staging')
    expect((await readConfig()).apiUrl).toBe(STAGING_API)
  })

  // api.ts's 401 path POSTs the refresh token to whatever apiUrl now resolves to, so carrying a
  // session across a switch would hand one deployment's credential to another.
  it('env use drops the stored session when changing deployment', async () => {
    await writeConfig({ apiUrl: PROD_API, accessToken: 'a', refreshToken: 'r', user: { id: 'u', email: null, name: null } })
    vi.resetModules()
    const { envUse } = await import('../src/commands/env.js')
    await envUse('staging')
    const c = await readConfig()
    expect(c.apiUrl).toBe(STAGING_API)
    expect(c.accessToken).toBeUndefined()
    expect(c.refreshToken).toBeUndefined()
    expect(c.user).toBeUndefined()
  })

  it('env use is a no-op that keeps the session when already on that environment', async () => {
    await writeConfig({ apiUrl: STAGING_API, accessToken: 'a', refreshToken: 'r' })
    vi.resetModules()
    const { envUse } = await import('../src/commands/env.js')
    await envUse('staging')
    const c = await readConfig()
    expect(c.apiUrl).toBe(STAGING_API)
    expect(c.accessToken).toBe('a')
  })

  // `die` exits the process, so trap it rather than letting it take the test worker down with it.
  it('env use rejects an unknown name', async () => {
    vi.resetModules()
    const { envUse } = await import('../src/commands/env.js')
    const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit ${code}`)
    }) as never)
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    try {
      await expect(envUse('stagng')).rejects.toThrow(/exit 1/)
    } finally {
      exit.mockRestore()
      err.mockRestore()
    }
  })

  it('preserves unrelated config keys across a switch', async () => {
    await writeConfig({ apiUrl: PROD_API, autoUpdate: false })
    vi.resetModules()
    const { envUse } = await import('../src/commands/env.js')
    await envUse('staging')
    expect((await readConfig()).autoUpdate).toBe(false)
  })
})
