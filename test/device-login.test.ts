// deviceGrant drives the RFC 8628 poll loop against the platform's /api/auth/device* endpoints.
// The poster + wait are injected (repo pattern: DI fakes, no global mocks), so these tests assert
// the loop's protocol behavior: pending -> retry, slow_down -> back off, denial/expiry -> clear
// errors, approval -> the session token comes back.
import { describe, expect, it } from 'vitest'
import { deviceGrant, type DevicePoster } from '../src/commands/auth.js'
import { ApiError } from '../src/api.js'

const START = {
  device_code: 'dev-123', user_code: 'ABCD1234',
  verification_uri: 'https://console.test/device',
  verification_uri_complete: 'https://console.test/device?user_code=ABCD1234',
  expires_in: 900, interval: 5,
}

// A poster that returns `start` (default START) for /device/code, then plays `polls` in order for
// /device/token — each entry is either an OAuth error code (thrown as ApiError, like the real
// client does) or a token to grant. Records waits so tests can assert the pacing.
function fakeFlow(polls: string[], start: Record<string, unknown> = START) {
  const waits: number[] = []
  let sent: unknown = null
  const post: DevicePoster = async (path, body) => {
    if (path === '/api/auth/device/code') return start
    if (path === '/api/auth/device/token') {
      sent = body
      const next = polls.shift()
      if (!next) throw new Error('poll after script ended')
      if (next.startsWith('token:')) return { access_token: next.slice('token:'.length) }
      throw new ApiError(400, next)
    }
    throw new Error(`unexpected path ${path}`)
  }
  const wait = async (s: number) => { waits.push(s) }
  return { post, wait, waits, sentBody: () => sent }
}

describe('deviceGrant', () => {
  it('polls through authorization_pending and returns the granted session token', async () => {
    const { post, wait, waits, sentBody } = fakeFlow(['authorization_pending', 'authorization_pending', 'token:sess-abc'])
    await expect(deviceGrant(post, wait)).resolves.toBe('sess-abc')
    expect(waits).toEqual([5, 5, 5]) // waits BEFORE every poll (RFC: first poll after `interval`)
    expect(sentBody()).toEqual({
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      device_code: 'dev-123',
      client_id: 'insta-cli',
    })
  })

  it('backs off by 5s on slow_down and keeps polling', async () => {
    const { post, wait, waits } = fakeFlow(['slow_down', 'authorization_pending', 'token:sess-x'])
    await expect(deviceGrant(post, wait)).resolves.toBe('sess-x')
    expect(waits).toEqual([5, 10, 10])
  })

  it('surfaces a console denial as a clear error', async () => {
    const { post, wait } = fakeFlow(['access_denied'])
    await expect(deviceGrant(post, wait)).rejects.toThrow(/denied in the console/)
  })

  it('stops with a retry hint when the server reports the code expired', async () => {
    const { post, wait } = fakeFlow(['expired_token'])
    await expect(deviceGrant(post, wait)).rejects.toThrow(/expired before it was approved/)
  })

  it('rethrows unexpected errors instead of polling forever', async () => {
    const { post, wait } = fakeFlow(['invalid_grant'])
    await expect(deviceGrant(post, wait)).rejects.toThrow('invalid_grant')
  })

  // RFC 8628 §3.2: interval is OPTIONAL — absent must mean the default 5s, not NaN (which would
  // resolve wait() instantly and hot-poll the token endpoint straight into slow_down).
  it('defaults the poll interval to 5s when the response omits it', async () => {
    const { interval: _omitted, ...startWithoutInterval } = START
    const { post, wait, waits } = fakeFlow(['authorization_pending', 'token:sess-d'], startWithoutInterval)
    await expect(deviceGrant(post, wait)).resolves.toBe('sess-d')
    expect(waits).toEqual([5, 5])
  })

  // A missing expires_in would otherwise become a NaN deadline: the loop never runs and the
  // failure surfaces as a bogus "expired" — fail loudly at the response instead.
  it('rejects a malformed authorization response missing expires_in', async () => {
    const { expires_in: _omitted, ...startWithoutExpiry } = START
    const { post, wait, waits } = fakeFlow([], startWithoutExpiry)
    await expect(deviceGrant(post, wait)).rejects.toThrow(/malformed device authorization response/)
    expect(waits).toEqual([]) // failed before any poll
  })

  // Non-finite interval (Infinity survives `|| 5`) must also fall back to 5s — Node truncates a
  // setTimeout(Infinity) to ~1ms, which would hot-poll the token endpoint.
  it('treats a non-finite interval as the 5s default', async () => {
    const { post, wait, waits } = fakeFlow(['authorization_pending', 'token:sess-i'], { ...START, interval: Infinity })
    await expect(deviceGrant(post, wait)).resolves.toBe('sess-i')
    expect(waits).toEqual([5, 5])
  })

  // Huge-but-finite expires_in (Number.MAX_VALUE) overflows the ms conversion to Infinity; the
  // lifetime cap keeps the deadline finite. Grant still resolves normally.
  it('caps an absurd expires_in instead of polling forever', async () => {
    const { post, wait } = fakeFlow(['token:sess-h'], { ...START, expires_in: Number.MAX_VALUE })
    await expect(deviceGrant(post, wait)).resolves.toBe('sess-h')
  })

  it('rejects a 200 token response missing access_token', async () => {
    const { post, wait } = fakeFlow(['token:'], START) // fake grants an empty token string
    await expect(deviceGrant(post, wait)).rejects.toThrow(/missing access_token/)
  })

  // RFC 8628 clients tolerate transport failures: a dropped connection mid-wait (the flaky
  // SSH/CI links this flow exists for) must not abort a 15-minute login that would succeed on
  // the next poll. Only ApiError (a real server answer) can end the loop.
  it('keeps polling through transient network errors', async () => {
    const polls = ['authorization_pending', 'token:sess-net']
    const waits: number[] = []
    let dropped = false
    const post: DevicePoster = async (path) => {
      if (path === '/api/auth/device/code') return START
      if (!dropped) { dropped = true; throw new TypeError('fetch failed') } // transport blip, not ApiError
      const next = polls.shift()!
      if (next.startsWith('token:')) return { access_token: next.slice('token:'.length) }
      throw new ApiError(400, next)
    }
    await expect(deviceGrant(post, async (s) => { waits.push(s) })).resolves.toBe('sess-net')
    expect(waits).toEqual([5, 5, 5]) // blip consumed one poll slot, pacing unchanged
  })

  // verification_uri_complete is OPTIONAL too — the plain verification_uri is the fallback link.
  it('falls back to verification_uri when the complete variant is absent', async () => {
    const lines: string[] = []
    const write = process.stdout.write.bind(process.stdout)
    process.stdout.write = ((s: string) => { lines.push(String(s)); return true }) as typeof process.stdout.write
    try {
      const { verification_uri_complete: _omitted, ...startWithoutComplete } = START
      const { post, wait } = fakeFlow(['token:sess-f'], startWithoutComplete)
      await expect(deviceGrant(post, wait)).resolves.toBe('sess-f')
    } finally {
      process.stdout.write = write
    }
    expect(lines.join('')).toContain('https://console.test/device')
    expect(lines.join('')).not.toContain('undefined')
  })
})
