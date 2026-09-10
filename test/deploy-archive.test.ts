import { describe, it, expect, afterEach } from 'vitest'
import { buildArchive, uploadArchive, archiveBuildSpec } from '../src/deploy-archive.js'

const DIGEST = 'a'.repeat(64)
const packed = (hasDockerfile = true) => ({ archive: Buffer.from('tar.gz bytes'), sha256: DIGEST, hasDockerfile })

type Call = { method: string; path: string; body?: any }

// A platform whose /build-uploads/:sha256 answers `states` in order, one per call.
function fakeApi(states: Array<'valid' | 'missing'>, opts: { mint?: any; deployStatus?: number } = {}) {
  const calls: Call[] = []
  let statusIdx = 0
  const api = {
    rawRequest: async (method: string, path: string, body?: unknown) => {
      calls.push({ method, path, body })
      if (method === 'GET' && path.includes('/build-uploads/')) {
        const state = states[Math.min(statusIdx++, states.length - 1)]
        return { status: 200, body: state === 'valid' ? { state: 'valid', size: 12 } : { state: 'missing' } }
      }
      if (method === 'POST' && path.endsWith('/build-uploads')) {
        return opts.mint ?? { status: 200, body: { uploadUrl: 'https://bucket.example/o?put=1', expiresAt: '2026-09-09T00:15:00Z' } }
      }
      throw new Error(`unexpected call ${method} ${path}`)
    },
  }
  return { api, calls }
}

afterEach(() => { process.exitCode = undefined })

describe('archiveBuildSpec', () => {
  // The platform never sees the tree and the gateway does not fall back, so the side that packed
  // it chooses.
  it('selects dockerfile when one was packed, nixpacks when none was', () => {
    expect(archiveBuildSpec(true)).toEqual({ type: 'dockerfile' })
    expect(archiveBuildSpec(false)).toEqual({ type: 'nixpacks' })
  })
})

describe('uploadArchive', () => {
  // The whole point of checking BEFORE minting: a re-run after an approval must not need another
  // approval for a mint it no longer has to make.
  it('skips the gated mint and the upload when the object is already there', async () => {
    const { api, calls } = fakeApi(['valid'])
    const puts: string[] = []

    const out = await uploadArchive(api, 'p1', packed(), 'main', {}, async (url) => { puts.push(url) })

    expect(out).toEqual({ archiveSha256: DIGEST, build: { type: 'dockerfile' } })
    expect(puts).toEqual([])
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([`GET /projects/p1/build-uploads/${DIGEST}`])
  })

  it('mints, uploads and re-checks when the object is missing', async () => {
    const { api, calls } = fakeApi(['missing', 'valid'])
    const puts: Array<{ url: string; bytes: number }> = []

    const out = await uploadArchive(api, 'p1', packed(false), 'main', { group: 'api' }, async (url, body) => {
      puts.push({ url, bytes: body.length })
    })

    expect(out).toEqual({ archiveSha256: DIGEST, build: { type: 'nixpacks' } })
    expect(puts).toEqual([{ url: 'https://bucket.example/o?put=1', bytes: 12 }])
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      `GET /projects/p1/build-uploads/${DIGEST}`,
      'POST /projects/p1/build-uploads',
      `GET /projects/p1/build-uploads/${DIGEST}`,
    ])
    // The mint carries the content digest and the exact byte count that gets signed into the PUT.
    expect(calls[1]!.body).toEqual({ branch: 'main', group: 'api', sha256: DIGEST, size: 12 })
  })

  // handleApproval sets exit 2 and the user re-runs; nothing may be uploaded or deployed here.
  it('stops without uploading when the mint needs an approval', async () => {
    const { api } = fakeApi(['missing'], { mint: { status: 202, body: { status: 'approval_required', action: 'deploy', approvalId: 'ap1' } } })
    const puts: string[] = []

    const out = await uploadArchive(api, 'p1', packed(), 'main', {}, async (url) => { puts.push(url) })

    expect(out).toBeNull()
    expect(puts).toEqual([])
    expect(process.exitCode).toBe(2)
  })

  // A PUT that lands nowhere must not be reported as an upload that worked.
  it('fails loudly when the object is still missing after the upload', async () => {
    const { api } = fakeApi(['missing', 'missing'])

    await expect(uploadArchive(api, 'p1', packed(), 'main', {}, async () => {})).rejects.toThrow(/upload/i)
  })
})

// Two gated calls now stand between a directory and a running service: the mint and the build
// submit. An approval can stop the run at EITHER, so the recovery has to work from both points.
describe('buildArchive — the gated submit and the wait after it', () => {
  const ref = { archiveSha256: DIGEST, build: { type: 'dockerfile' as const } }

  function api(script: Array<{ status: number; body: any }>) {
    const calls: Array<{ method: string; path: string; body?: any }> = []
    let i = 0
    return {
      calls,
      api: {
        rawRequest: async (method: string, path: string, body?: unknown) => {
          calls.push({ method, path, body })
          return script[Math.min(i++, script.length - 1)]!
        },
      },
    }
  }

  it('stops at a pending approval on the submit and asks for nothing else', async () => {
    const { api: a, calls } = api([{ status: 202, body: { status: 'approval_required', action: 'deploy', approvalId: 'ap_1' } }])

    expect(await buildArchive(a, 'p1', ref, 'main', { json: false })).toBeNull()
    // One call: no poll loop against a build that was never started.
    expect(calls).toHaveLength(1)
    expect(process.exitCode).toBe(2)
  })

  // The re-run after approving. The submit body is composed only of values the packer reproduces
  // (the digest) and the target the user named, so it is byte-identical to the body the approval
  // was granted against, which is what lets the grant apply instead of asking a second time.
  it('sends a submit body a re-run reproduces exactly', async () => {
    const { api: a, calls } = api([
      { status: 200, body: { buildId: 'bld_1' } },
      { status: 200, body: { state: 'succeeded', imageRef: 'ecr.example/app@sha256:aa' } },
    ])

    const out = await buildArchive(a, 'p1', ref, 'main', { group: 'api' })

    expect(out).toEqual({ image: 'ecr.example/app@sha256:aa' })
    expect(calls[0]!.body).toEqual({ branch: 'main', group: 'api', archive: ref })
  })

  it('keeps polling while the build is running, one request at a time', async () => {
    let n = 0
    const a = {
      rawRequest: async (method: string) => {
        if (method === 'POST') return { status: 200, body: { buildId: 'bld_1' } }
        n += 1
        return n < 3
          ? { status: 200, body: { state: 'building' } }
          : { status: 200, body: { state: 'succeeded', imageRef: 'ecr.example/app@sha256:bb' } }
      },
    }

    const out = await buildArchive(a, 'p1', ref, 'main', {}, Date.now, async () => undefined)

    expect(out).toEqual({ image: 'ecr.example/app@sha256:bb' })
    expect(n).toBe(3)
  })

  it('gives up rather than polling forever when the gateway never finishes', async () => {
    const a = {
      rawRequest: async (method: string) =>
        method === 'POST' ? { status: 200, body: { buildId: 'bld_1' } } : { status: 200, body: { state: 'building' } },
    }
    let t = 0
    const clock = () => (t += 60 * 60 * 1000) // an hour per look

    await expect(buildArchive(a, 'p1', ref, 'main', {}, clock, async () => undefined))
      .rejects.toThrow(/did not finish/)
  })
})
