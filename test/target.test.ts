// Naming the target. The incident these cover: `insta login --device` against a terminated
// insta-oss box printed `error: fetch failed` and nothing else, while the config still held a
// months-old `login --api-url` host. Every assertion here is about a message saying which host,
// why it failed, and what pointed the CLI at it — without asking the (unreachable) host anything.
import { describe, expect, it } from 'vitest'
import { ApiClient, NetworkError } from '../src/api.js'
import { buildTarget, failureReason, targetLines } from '../src/target.js'

const PROD = 'https://api.instacloud.com'
const STAGING = 'https://api.staging.instacloud.com'
const OSS = 'https://api.98-87-8-168.sslip.io'

describe('target provenance', () => {
  it('names INSTA_API_URL when the env var chose the host', () => {
    const t = buildTarget({ apiUrl: OSS, stored: PROD, envApiUrl: OSS })
    expect(t.source).toBe('INSTA_API_URL')
    expect(t.recovery).toBe('unset INSTA_API_URL')
  })

  it('names INSTA_ENV when the named env var chose the host', () => {
    const t = buildTarget({ apiUrl: STAGING, stored: PROD, envName: 'staging' })
    expect(t.source).toBe('INSTA_ENV=staging')
    expect(t.recovery).toBe('unset INSTA_ENV')
  })

  // `env use` only ever writes a host from the env table, so a stored host OUTSIDE it can only
  // have come from a literal `login --api-url`. That is the whole reason no field has to be stored.
  it('distinguishes a stored custom URL from a stored named environment', () => {
    expect(buildTarget({ apiUrl: OSS, stored: OSS }).source).toBe('saved by `insta login --api-url`')
    expect(buildTarget({ apiUrl: STAGING, stored: STAGING }).source).toBe('saved by `insta env use`')
  })

  it('separates "prod was never chosen" from "prod was saved"', () => {
    expect(buildTarget({ apiUrl: PROD, stored: null }).source).toBe('built-in default')
    expect(buildTarget({ apiUrl: PROD, stored: PROD }).source).toBe('saved by `insta env use`')
  })

  // login --api-url sets the client's host before anything is persisted.
  it('attributes a host that matches nothing on disk to the flag', () => {
    expect(buildTarget({ apiUrl: OSS, stored: PROD }).source).toBe('--api-url flag')
  })

  it('ignores a trailing slash when matching the source', () => {
    expect(buildTarget({ apiUrl: `${OSS}/`, stored: OSS }).source).toBe('saved by `insta login --api-url`')
  })

  it('survives an unparseable URL rather than throwing inside an error path', () => {
    expect(buildTarget({ apiUrl: 'not a url', stored: null }).host).toBe('not a url')
  })
})

describe('target lines', () => {
  // The cloud default is where nearly every run happens; a run that is where it expects to be has
  // nothing to explain, so the common error stays exactly one line.
  it('adds nothing on the cloud default', () => {
    expect(targetLines(buildTarget({ apiUrl: PROD, stored: null }))).toEqual([])
  })

  it('names the target on a named non-default environment', () => {
    const lines = targetLines(buildTarget({ apiUrl: STAGING, stored: STAGING }))
    expect(lines).toEqual(['  target: https://api.staging.instacloud.com (saved by `insta env use`)'])
  })

  it('names the target and the way back on a custom host', () => {
    expect(targetLines(buildTarget({ apiUrl: OSS, stored: OSS }))).toEqual([
      '  target: https://api.98-87-8-168.sslip.io (saved by `insta login --api-url`)',
      '  for InstaCloud: insta env use prod',
    ])
  })
})

describe('failureReason', () => {
  it('translates the undici and libuv codes a dead host produces', () => {
    expect(failureReason({ code: 'UND_ERR_CONNECT_TIMEOUT' })).toBe('connect timeout')
    expect(failureReason({ code: 'ENOTFOUND' })).toBe('DNS lookup failed')
    expect(failureReason({ code: 'ECONNREFUSED' })).toBe('connection refused')
  })

  // An unmapped code must still reach the user: a raw code beats a silently reasonless message.
  it('falls back to the code, then the message, then nothing', () => {
    expect(failureReason({ code: 'UND_ERR_SOMETHING_NEW' })).toBe('UND_ERR_SOMETHING_NEW')
    expect(failureReason({ message: 'socket hang up' })).toBe('socket hang up')
    expect(failureReason(undefined)).toBeNull()
  })
})

describe('NetworkError', () => {
  it('names the host and the reason instead of "fetch failed"', () => {
    const e = new NetworkError(OSS, { code: 'UND_ERR_CONNECT_TIMEOUT' })
    expect(e.message).toBe('cannot reach api.98-87-8-168.sslip.io (connect timeout)')
  })

  // telemetry.ts lifts error.cause.code; wrapping must not drop it.
  it('keeps the original failure as cause so telemetry still sees the code', () => {
    const cause = { code: 'ENOTFOUND' }
    expect((new NetworkError(OSS, cause).cause as { code: string }).code).toBe('ENOTFOUND')
  })

  it('is what the client throws when the transport never answers', async () => {
    const dead: typeof fetch = () => Promise.reject(
      Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }),
    )
    const api = new ApiClient({ apiUrl: OSS }, dead)
    await expect(api.request('GET', '/me')).rejects.toThrow('cannot reach api.98-87-8-168.sslip.io (connection refused)')
  })
})
