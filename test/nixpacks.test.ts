import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { parseNixpacksPlan, nixpacksPlan, nixpacksGeneratedDockerfile, nixpacksAvailable } from '../src/nixpacks.js'
import type { BuildRunner } from '../src/flyctl-build.js'

// The documented `nixpacks plan` output shape (providers + phases + start).
const PLAN_JSON = JSON.stringify({
  providers: ['node'],
  buildImage: 'ghcr.io/railwayapp/nixpacks:latest',
  phases: {
    setup: { nixPkgs: ['nodejs-18_x'] },
    install: { cmds: ['npm ci'], dependsOn: ['setup'] },
    build: { cmds: ['npm run build'], dependsOn: ['install'] },
  },
  start: { cmd: 'npm run start' },
})

describe('parseNixpacksPlan', () => {
  it('extracts providers, install/build commands, and the start command', () => {
    expect(parseNixpacksPlan(PLAN_JSON)).toEqual({
      providers: ['node'],
      installCommand: 'npm ci',
      buildCommand: 'npm run build',
      startCommand: 'npm run start',
    })
  })

  it('tolerates missing phases and start (partial detection)', () => {
    expect(parseNixpacksPlan(JSON.stringify({ providers: ['staticfile'] }))).toEqual({
      providers: ['staticfile'],
      installCommand: undefined,
      buildCommand: undefined,
      startCommand: undefined,
    })
  })

  it('returns null on non-JSON output', () => {
    expect(parseNixpacksPlan('error: no providers matched')).toBeNull()
  })

  it('falls back to NIXPACKS_METADATA when the providers array is empty (nixpacks ≥1.x real output)', () => {
    const real = JSON.stringify({
      providers: [],
      variables: { CI: 'true', NIXPACKS_METADATA: 'node,python' },
      phases: { install: { cmds: ['npm i'] } },
      start: { cmd: 'npm run start' },
    })
    expect(parseNixpacksPlan(real)?.providers).toEqual(['node', 'python'])
  })
})

describe('nixpacksPlan', () => {
  it('runs `nixpacks plan <dir>` and parses the JSON it prints', async () => {
    const seen: { cmd?: string; args?: string[] } = {}
    const run: BuildRunner = async (cmd, args) => {
      seen.cmd = cmd; seen.args = args
      return { code: 0, output: PLAN_JSON }
    }
    const plan = await nixpacksPlan('/some/app', run)
    expect(seen.cmd).toBe('nixpacks')
    expect(seen.args).toEqual(['plan', '/some/app'])
    expect(plan?.startCommand).toBe('npm run start')
  })

  it('returns null when nixpacks exits non-zero (caller degrades gracefully)', async () => {
    const run: BuildRunner = async () => ({ code: 1, output: 'Error: no providers found' })
    expect(await nixpacksPlan('/some/app', run)).toBeNull()
  })
})

describe('nixpacksAvailable', () => {
  it('probes `nixpacks --version` quietly — true on 0, false otherwise (never installs anything)', async () => {
    const seen: { cmd?: string; args?: string[] } = {}
    const up: BuildRunner = async (cmd, args) => { seen.cmd = cmd; seen.args = args; return { code: 0, output: 'nixpacks 1.41.0' } }
    expect(await nixpacksAvailable(up)).toBe(true)
    expect(seen.cmd).toBe('nixpacks')
    expect(seen.args).toEqual(['--version'])
    const down: BuildRunner = async () => ({ code: -1, output: 'spawn nixpacks ENOENT' })
    expect(await nixpacksAvailable(down)).toBe(false)
  })
})

describe('nixpacksGeneratedDockerfile', () => {
  it('runs `nixpacks build <dir> --out <tmp>` and reads the generated Dockerfile', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'insta-build-src-'))
    const seen: { args?: string[] } = {}
    const run: BuildRunner = async (cmd, args) => {
      seen.args = args
      // nixpacks writes <out>/.nixpacks/Dockerfile; the fake does the same
      const out = args[args.indexOf('--out') + 1]
      mkdirSync(join(out, '.nixpacks'), { recursive: true })
      writeFileSync(join(out, '.nixpacks', 'Dockerfile'), 'FROM node:18\nCMD ["npm","start"]\n')
      return { code: 0, output: 'saved output to directory' }
    }
    const content = await nixpacksGeneratedDockerfile(dir, run)
    expect(seen.args?.slice(0, 2)).toEqual(['build', dir])
    expect(seen.args).toContain('--out')
    expect(content).toContain('FROM node:18')
    // the temp out dir is cleaned up — nothing is written into the user's source dir
    expect(existsSync(join(dir, '.nixpacks'))).toBe(false)
  })

  it('returns null when generation fails', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'insta-build-src-'))
    const run: BuildRunner = async () => ({ code: 1, output: 'boom' })
    expect(await nixpacksGeneratedDockerfile(dir, run)).toBeNull()
  })
})
