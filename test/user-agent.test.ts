import { describe, expect, it } from 'vitest'
import { ApiClient } from '../src/api.js'
import { USER_AGENT, cliVersion } from '../src/version.js'

describe('User-Agent', () => {
  it('names the CLI and its version so the platform can attribute the call', async () => {
    expect(USER_AGENT).toBe(`insta-cli/${cliVersion()}`)
    let seen: Record<string, string> = {}
    const fetchImpl = (async (_url: any, init: any) => { seen = init.headers; return new Response('{}', { status: 200 }) }) as typeof fetch
    await new ApiClient({ apiUrl: 'https://api.test' }, fetchImpl).request('GET', '/me', undefined, { auth: false })
    expect(seen['User-Agent']).toBe(USER_AGENT)
  })
})
