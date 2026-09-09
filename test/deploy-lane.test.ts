import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect, afterEach } from 'vitest'
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

// A platform that answers `lane` on discovery and records every path it was asked for.
function fakeApi(lane: unknown, extra: Record<string, unknown> = {}) {
  const paths: string[] = []
  const api = {
    rawRequest: async (method: string, path: string, body?: unknown) => {
      paths.push(`${method} ${path.split('?')[0]}`)
      if (path.includes('/source-build')) {
        if (lane === '404') throw new ApiError(404, 'Route not found')
        return { status: 200, body: lane }
      }
      if (path.includes('/build-uploads/')) return { status: 200, body: { state: 'valid' } }
      const hit = extra[`${method} ${path.split('?')[0]}`]
      if (hit) return hit
      throw new ApiError(501, 'deploy tokens (remote builders) is cloud-only')
    },
  }
  return { api, paths }
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

  // The archive lane never mints a Fly token, and a directory with no Dockerfile is legitimate.
  it('packs and uploads on the archive lane, minting no deploy token', async () => {
    const { api, paths } = fakeApi({ lane: 'archive', limits: { maxArchiveBytes: 1024 * 1024, maxExtractedBytes: 1024 * 1024, maxFiles: 100 } })

    const out = await prepareSource(api, 'p1', srcDir(false), 'main', {}, noRun)

    expect(out).toMatchObject({ archive: { build: { type: 'nixpacks' } } })
    expect(paths).not.toContain('POST /projects/p1/deploy-token')
    expect(paths.some((p) => p.includes('/build-uploads/'))).toBe(true)
  })

  it('selects a dockerfile build when the packed tree has one', async () => {
    const { api } = fakeApi({ lane: 'archive', limits: { maxArchiveBytes: 1024 * 1024, maxExtractedBytes: 1024 * 1024, maxFiles: 100 } })

    const out = await prepareSource(api, 'p1', srcDir(true), 'main', {}, noRun)

    expect(out).toMatchObject({ archive: { build: { type: 'dockerfile' } } })
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
