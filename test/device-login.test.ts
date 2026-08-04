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

// A poster that returns START for /device/code, then plays `polls` in order for /device/token —
// each entry is either an OAuth error code (thrown as ApiError, like the real client does) or a
// token to grant. Records waits so tests can assert the pacing.
function fakeFlow(polls: string[]) {
  const waits: number[] = []
  let sent: unknown = null
  const post: DevicePoster = async (path, body) => {
    if (path === '/api/auth/device/code') return START
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
})
