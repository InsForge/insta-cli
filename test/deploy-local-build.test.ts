// Source deploys against a local daemon (insta-oss): the deploy-token mint answers 501, and the
// CLI falls back to a local docker build — the daemon runs from the same docker, so the tag works.
import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildFromSource, dockerBuildLocal, localImageTag } from '../src/commands/deploy.js'
import { ApiError } from '../src/api.js'
import type { BuildRunner } from '../src/flyctl-build.js'

const srcDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'insta-src-'))
  writeFileSync(join(dir, 'Dockerfile'), 'FROM scratch\nEXPOSE 3000\n')
  return dir
}

describe('localImageTag', () => {
  it('is unique per build and legible per project/group', () => {
    expect(localImageTag('abcdef01-2345', 'api', 42)).toBe('insta-src-abcdef01-api:42')
    expect(localImageTag('abcdef01-2345', undefined, 42)).toBe('insta-src-abcdef01-default:42')
  })
})

describe('dockerBuildLocal', () => {
  it('builds with docker in the source dir and returns the tag', async () => {
    const calls: Array<{ cmd: string; args: string[]; cwd: string }> = []
    const runner: BuildRunner = async (cmd, args, opts) => { calls.push({ cmd, args, cwd: opts.cwd }); return { code: 0, output: '' } }
    const dir = srcDir()
    expect(await dockerBuildLocal(dir, 't:1', runner)).toBe('t:1')
    expect(calls).toEqual([{ cmd: 'docker', args: ['build', '-t', 't:1', '.'], cwd: dir }])
  })
  it('surfaces a failed build as an error, not a bogus tag', async () => {
    const runner: BuildRunner = async () => ({ code: 1, output: '' })
    await expect(dockerBuildLocal(srcDir(), 't:1', runner)).rejects.toThrow(/docker build failed/)
  })
})

describe('buildFromSource against a local daemon', () => {
  it('falls back to a local docker build when the deploy-token mint answers 501', async () => {
    const api = { rawRequest: async () => { throw new ApiError(501, 'deploy tokens (remote builders) is cloud-only') } }
    const calls: string[][] = []
    const runner: BuildRunner = async (cmd, args) => { calls.push([cmd, ...args]); return { code: 0, output: '' } }
    const tag = await buildFromSource(api, 'abcdef01-2345', srcDir(), 'main', { group: 'api' }, runner)
    expect(tag).toMatch(/^insta-src-abcdef01-api:\d+$/)
    expect(calls[0]?.slice(0, 3)).toEqual(['docker', 'build', '-t'])
  })
  it('re-throws every non-501 error (cloud failures must stay loud)', async () => {
    const api = { rawRequest: async () => { throw new ApiError(403, 'forbidden') } }
    const runner: BuildRunner = async () => ({ code: 0, output: '' })
    await expect(buildFromSource(api, 'p', srcDir(), 'main', {}, runner)).rejects.toThrow('forbidden')
  })
})
