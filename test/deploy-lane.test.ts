import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect, afterEach, vi } from 'vitest'
import { prepareSource } from '../src/commands/deploy.js'
import { ApiError } from '../src/api.js'
import type { BuildRunner } from '../src/flyctl-build.js'

function srcDir(withDockerfile = true): string {
  const dir = mkdtempSync(join(tmpdir(), 'insta-lane-'))
  if (withDockerfile) writeFileSync(join(dir, 'Dockerfile'), 'FROM alpine\nEXPOSE 3000\n')
  writeFileSync(join(dir, 'app.js'), 'console.log(1)\n')
  return dir
}

const noRun: BuildRunner = async () => ({ code: 0, output: '' })

// A platform that answers `lane` on discovery and records every path and body it was asked for.
function fakeApi(lane: unknown, extra: Record<string, unknown> = {}) {
  const paths: string[] = []
  const bodies: Record<string, any> = {}
  const api = {
    rawRequest: async (method: string, path: string, body?: unknown) => {
      const key = `${method} ${path.split('?')[0]}`
      paths.push(key)
      bodies[key] = body
      // Overrides win: a test that wants a different answer for one path says so, and the
      // defaults below are only what the happy path needs.
      const override = extra[key]
      if (override) return override
      if (path.includes('/source-build')) {
        if (lane === '404') throw new ApiError(404, 'Route not found')
        return { status: 200, body: lane }
      }
      if (path.includes('/build-uploads/')) return { status: 200, body: { state: 'valid' } }
      // Submit answers an id; the poll answers a finished build, so the loop runs exactly once.
      if (key === 'POST /projects/p1/archive-builds') return { status: 200, body: { buildId: 'bld_1' } }
      if (path.includes('/archive-builds/')) return { status: 200, body: { state: 'succeeded', imageRef: 'ecr.example/app@sha256:aa' } }
      throw new ApiError(501, 'deploy tokens (remote builders) is cloud-only')
    },
  }
  return { api, paths, bodies }
}

afterEach(() => { process.exitCode = undefined })

describe('prepareSource — lane dispatch', () => {
  // 404 must mean "old server", for a human AND an agent, which is why discovery is a GET.
  it('falls back to the unchanged deploy-token path when discovery 404s', async () => {
    const { api, paths } = fakeApi('404')

    const out = await prepareSource(api, 'p1', srcDir(), 'main', {}, noRun)

    expect(out).toHaveProperty('image')
    expect(paths).toContain('POST /projects/p1/deploy-token')
  })

  it('takes the flyctl path when the platform names that lane', async () => {
    const { api, paths } = fakeApi({ lane: 'flyctl' })

    await prepareSource(api, 'p1', srcDir(), 'main', {}, noRun)

    expect(paths).toContain('POST /projects/p1/deploy-token')
  })

  // The archive lane never mints a Fly token, a directory with no Dockerfile is legitimate, and
  // the lane ends in an IMAGE like every other one: the CLI submits the build and waits it out,
  // so the deploy call that follows is the same call an image deploy has always made.
  it('packs, uploads, builds and resolves to an image, minting no deploy token', async () => {
    const { api, paths, bodies } = fakeApi({ lane: 'archive', limits: { maxArchiveBytes: 1024 * 1024, maxExtractedBytes: 1024 * 1024, maxFiles: 100 } })

    const out = await prepareSource(api, 'p1', srcDir(false), 'main', {}, noRun)

    expect(out).toEqual({ image: 'ecr.example/app@sha256:aa' })
    expect(bodies['POST /projects/p1/archive-builds'].archive.build).toEqual({ type: 'nixpacks' })
    expect(paths).not.toContain('POST /projects/p1/deploy-token')
    // Order matters: the object has to exist before a build is asked for it.
    expect(paths.indexOf('POST /projects/p1/build-uploads')).toBeLessThan(paths.indexOf('POST /projects/p1/archive-builds'))
  })

  it('selects a dockerfile build when the packed tree has one', async () => {
    const { api, bodies } = fakeApi({ lane: 'archive', limits: { maxArchiveBytes: 1024 * 1024, maxExtractedBytes: 1024 * 1024, maxFiles: 100 } })

    await prepareSource(api, 'p1', srcDir(true), 'main', {}, noRun)

    expect(bodies['POST /projects/p1/archive-builds'].archive.build).toEqual({ type: 'dockerfile' })
  })

  // A failed build is an ANSWER the gateway gave, not a transport error, and its sentence is the
  // only thing telling the user why their tree did not build. `die` carries it on stderr, not on
  // the thrown CliExit, so that is where it has to be asserted.
  it('dies with the gateway’s own sentence when the build fails', async () => {
    const { api } = fakeApi({ lane: 'archive', limits: { maxArchiveBytes: 1024 * 1024, maxExtractedBytes: 1024 * 1024, maxFiles: 100 } }, {
      'GET /projects/p1/archive-builds/bld_1': { status: 200, body: { state: 'failed', message: 'build bld_1 failed: no Dockerfile at ./api' } },
    })
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    try {
      await expect(prepareSource(api, 'p1', srcDir(false), 'main', {}, noRun)).rejects.toThrow()
      expect(err.mock.calls.map((c) => String(c[0])).join('')).toMatch(/no Dockerfile at \.\/api/)
    } finally {
      err.mockRestore()
    }
  })

  // The platform already worded the refusal; repeating it in the CLI would let the two drift.
  it('refuses with the platform’s own reason when no lane serves the target', async () => {
    const { api } = fakeApi({ lane: 'none', reason: 'source builds are not supported on the insta-compute provider yet' })

    await expect(prepareSource(api, 'p1', srcDir(), 'main', {}, noRun)).rejects.toThrow()
  })

  // On the archive lane the server enforces the caps; the client only names which one was hit.
  it('enforces the caps discovery reported', async () => {
    const { api } = fakeApi({ lane: 'archive', limits: { maxArchiveBytes: 1024 * 1024, maxExtractedBytes: 1024 * 1024, maxFiles: 1 } })

    await expect(prepareSource(api, 'p1', srcDir(), 'main', {}, noRun)).rejects.toThrow(/too many files/)
  })
})
