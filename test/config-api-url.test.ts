// readGlobal freezes whatever DEFAULT_API was in force at first login into ~/.insta/config.json
// (persist() writes the resolved object straight back), so installs from v0.0.3..v0.0.16 carry
// the retired beta-api host permanently and upgrading the binary does not move them. These cover
// the retirement path and, just as importantly, the values that must NOT be rewritten.
import { test, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const RETIRED = 'https://beta-api.insta.insforge.dev'
const DEFAULT_API = 'https://api.instacloud.com'

/** Point HOME at a fresh dir, optionally seeding ~/.insta/config.json. */
function seedHome(global: Record<string, unknown> | null): string {
  const home = mkdtempSync(join(tmpdir(), 'insta-home-'))
  process.env.HOME = home
  if (global) {
    mkdirSync(join(home, '.insta'), { recursive: true })
    writeFileSync(join(home, '.insta', 'config.json'), JSON.stringify(global))
  }
  return home
}

/** GLOBAL_FILE is resolved at module load, so HOME must be set before each import. */
const load = () => { vi.resetModules(); return import('../src/config.js') }

const readRaw = (home: string) =>
  JSON.parse(readFileSync(join(home, '.insta', 'config.json'), 'utf8')) as { apiUrl: string }

beforeEach(() => { delete process.env.INSTA_API_URL })
afterEach(() => { delete process.env.INSTA_API_URL; vi.resetModules() })

test('a persisted retired host is replaced by the current default', async () => {
  seedHome({ apiUrl: RETIRED, accessToken: 't' })
  expect((await (await load()).readGlobal()).apiUrl).toBe(DEFAULT_API)
})

test('the session minted by the retired deployment is dropped with it', async () => {
  seedHome({ apiUrl: RETIRED, accessToken: 'a', refreshToken: 'r', user: { id: 'u', email: null, name: null } })
  const cfg = await (await load()).readGlobal()
  expect(cfg.accessToken).toBeUndefined()
  expect(cfg.refreshToken).toBeUndefined()
  expect(cfg.user).toBeUndefined()
})

test('non-credential settings survive the replacement', async () => {
  seedHome({ apiUrl: RETIRED, accessToken: 't', autoUpdate: false })
  expect(await (await load()).readGlobal()).toMatchObject({ apiUrl: DEFAULT_API, autoUpdate: false })
})

test('the notice goes to stderr, so --json output on stdout stays parseable', async () => {
  seedHome({ apiUrl: RETIRED, accessToken: 't' })
  const err = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
  const out = vi.spyOn(process.stdout, 'write').mockReturnValue(true)
  await (await load()).readGlobal()
  expect(err).toHaveBeenCalledWith(expect.stringContaining(RETIRED))
  expect(out).not.toHaveBeenCalled()
  err.mockRestore(); out.mockRestore()
})

test('a healthy config keeps its session', async () => {
  seedHome({ apiUrl: 'https://api.instacloud.com', accessToken: 'a', refreshToken: 'r' })
  expect(await (await load()).readGlobal()).toMatchObject({ accessToken: 'a', refreshToken: 'r' })
})

test('a trailing slash does not smuggle the retired host through', async () => {
  seedHome({ apiUrl: `${RETIRED}/` })
  expect((await (await load()).readGlobal()).apiUrl).toBe(DEFAULT_API)
})

test('the healed value reaches disk the next time any command persists', async () => {
  const home = seedHome({ apiUrl: RETIRED, accessToken: 't' })
  expect(readRaw(home).apiUrl).toBe(RETIRED) // precondition: the stale value really is on disk
  const { readGlobal, writeGlobal } = await load()
  await writeGlobal(await readGlobal()) // what upgrade.ts and ApiClient.persist() both do
  expect(readRaw(home).apiUrl).toBe(DEFAULT_API)
})

test('a deliberate self-hosted or localhost apiUrl still wins', async () => {
  seedHome({ apiUrl: 'http://localhost:8080' })
  expect((await (await load()).readGlobal()).apiUrl).toBe('http://localhost:8080')
})

test('INSTA_API_URL beats both the retired host and the default', async () => {
  seedHome({ apiUrl: RETIRED })
  process.env.INSTA_API_URL = 'https://api.example.test'
  expect((await (await load()).readGlobal()).apiUrl).toBe('https://api.example.test')
})

test('with no config file at all the default is used', async () => {
  seedHome(null)
  expect((await (await load()).readGlobal()).apiUrl).toBe(DEFAULT_API)
})
