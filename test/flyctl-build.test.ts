import { mkdtempSync, existsSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect, vi } from 'vitest'
import { parseImageDigest, flyctlBuildAndPush, type BuildRunner } from '../src/flyctl-build.js'

const PUSH_LINE = 'pushing manifest for registry.fly.io/my-app:insta-1@sha256:abc123def456'

describe('parseImageDigest', () => {
  it('pins to the digest (not the racy tag)', () => {
    expect(parseImageDigest(PUSH_LINE, 'my-app')).toBe('registry.fly.io/my-app@sha256:abc123def456')
  })
  it('returns null when no manifest line is present', () => {
    expect(parseImageDigest('built ok, no push line', 'my-app')).toBeNull()
  })
})

describe('flyctlBuildAndPush', () => {
  it('invokes flyctl remote build+push with the scoped token and returns the digest ref', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'insta-src-'))
    const seen: { cmd: string; args: string[]; env: Record<string, string> } = { cmd: '', args: [], env: {} }
    const run: BuildRunner = async (cmd, args, opts) => {
      seen.cmd = cmd; seen.args = args; seen.env = opts.env
      // flyctl writes no fly.toml itself; assert the stub exists mid-build
      expect(existsSync(join(dir, 'fly.toml'))).toBe(true)
      return { code: 0, output: PUSH_LINE }
    }
    const { imageRef } = await flyctlBuildAndPush({ dir, flyApp: 'my-app', imageLabel: 'insta-1', token: 'FlyV1 secret', port: 3000 }, run)

    expect(imageRef).toBe('registry.fly.io/my-app@sha256:abc123def456')
    expect(seen.cmd).toBe('flyctl')
    expect(seen.args.join(' ')).toBe('deploy --remote-only --build-only --push --app my-app --image-label insta-1 --no-cache')
    expect(seen.env.FLY_API_TOKEN).toBe('FlyV1 secret') // scoped token passed via env, not a flag
    expect(existsSync(join(dir, 'fly.toml'))).toBe(false) // stub cleaned up after
  })

  it('leaves a user-provided fly.toml intact', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'insta-src-'))
    writeFileSync(join(dir, 'fly.toml'), 'app = "mine"\n')
    const run: BuildRunner = async () => ({ code: 0, output: PUSH_LINE })
    await flyctlBuildAndPush({ dir, flyApp: 'my-app', imageLabel: 'insta-1', token: 't', port: 8080 }, run)
    expect(readFileSync(join(dir, 'fly.toml'), 'utf8')).toBe('app = "mine"\n') // untouched
  })

  it('throws a clear error when flyctl fails', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'insta-src-'))
    const run: BuildRunner = async () => ({ code: 1, output: 'boom' })
    await expect(flyctlBuildAndPush({ dir, flyApp: 'my-app', imageLabel: 'insta-1', token: 't', port: 8080 }, run)).rejects.toThrow(/flyctl deploy --build-only failed/)
  })
})

// The tee destination is the `deploy --json` stdout-purity contract: build progress must reach the
// user either way, but with --json it may not touch stdout (stdout carries exactly one JSON doc).
describe('build runner tee destinations', () => {
  it('defaultBuildRunner tees child stdout to process.stdout; stderrBuildRunner keeps stdout clean', async () => {
    const { defaultBuildRunner, stderrBuildRunner } = await import('../src/flyctl-build.js')
    const outChunks: string[] = []
    const errChunks: string[] = []
    const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation((c: any) => { outChunks.push(String(c)); return true })
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation((c: any) => { errChunks.push(String(c)); return true })
    try {
      const opts = { cwd: process.cwd(), env: process.env as Record<string, string> }
      const a = await defaultBuildRunner(process.execPath, ['-e', 'console.log("BUILD_PROGRESS")'], opts)
      expect(a.code).toBe(0)
      expect(a.output).toContain('BUILD_PROGRESS')
      expect(outChunks.join('')).toContain('BUILD_PROGRESS')

      outChunks.length = 0; errChunks.length = 0
      const b = await stderrBuildRunner(process.execPath, ['-e', 'console.log("BUILD_PROGRESS")'], opts)
      expect(b.code).toBe(0)
      expect(b.output).toContain('BUILD_PROGRESS')      // still captured for digest parsing
      expect(outChunks.join('')).toBe('')               // stdout untouched — reserved for the JSON doc
      expect(errChunks.join('')).toContain('BUILD_PROGRESS')
    } finally {
      outSpy.mockRestore()
      errSpy.mockRestore()
    }
  })
})
