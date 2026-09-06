import { describe, it, expect } from 'vitest'
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  parseGitHubTemplateUrl, defaultGitRunner, makeGitRunner,
  LS_REMOTE_TIMEOUT_MS, CLONE_TIMEOUT_MS, type SpawnFn,
} from '../src/github-source.js'

describe('parseGitHubTemplateUrl', () => {
  it('returns null only for targets that are not URL-shaped', () => {
    expect(parseGitHubTemplateUrl('plausible')).toBeNull()
    expect(parseGitHubTemplateUrl('sub/dir')).toBeNull()
    // A dotted FIRST segment is a hostname; a dot later in a plain path is not.
    expect(parseGitHubTemplateUrl('templates/my.app')).toBeNull()
    expect(parseGitHubTemplateUrl('my.app')).toBeNull()
  })

  // `./x` and `../x` DO match the dotted-host shape, so the local-path prefix must be checked
  // first. Without that check every relative path would throw "unsupported template source".
  it('lets relative and absolute paths through to local mode, dots and all', () => {
    expect(parseGitHubTemplateUrl('./tpl')).toBeNull()
    expect(parseGitHubTemplateUrl('../tpl')).toBeNull()
    expect(parseGitHubTemplateUrl('./a.b/tpl')).toBeNull()
    expect(parseGitHubTemplateUrl('/abs/tpl')).toBeNull()
    expect(parseGitHubTemplateUrl('~/tpl')).toBeNull()
  })

  it('parses a bare repository URL', () => {
    expect(parseGitHubTemplateUrl('https://github.com/acme/tpl')).toEqual({ owner: 'acme', repo: 'tpl', refAndPath: '' })
  })

  it('accepts a missing scheme, a trailing slash and a .git suffix', () => {
    const want = { owner: 'acme', repo: 'tpl', refAndPath: '' }
    expect(parseGitHubTemplateUrl('github.com/acme/tpl')).toEqual(want)
    expect(parseGitHubTemplateUrl('https://github.com/acme/tpl/')).toEqual(want)
    expect(parseGitHubTemplateUrl('https://github.com/acme/tpl.git')).toEqual(want)
    expect(parseGitHubTemplateUrl('http://www.github.com/acme/tpl')).toEqual(want)
  })

  it('keeps ref and path unsplit after /tree/', () => {
    expect(parseGitHubTemplateUrl('https://github.com/acme/tpl/tree/v2')).toEqual({ owner: 'acme', repo: 'tpl', refAndPath: 'v2' })
    expect(parseGitHubTemplateUrl('https://github.com/acme/tpl/tree/feature/foo/templates/bot'))
      .toEqual({ owner: 'acme', repo: 'tpl', refAndPath: 'feature/foo/templates/bot' })
  })

  it('reads a /blob/ link to the manifest as its directory', () => {
    expect(parseGitHubTemplateUrl('https://github.com/acme/tpl/blob/v2/templates/bot/insta.template.yaml'))
      .toEqual({ owner: 'acme', repo: 'tpl', refAndPath: 'v2/templates/bot' })
    expect(parseGitHubTemplateUrl('https://github.com/acme/tpl/blob/main/insta.template.yaml'))
      .toEqual({ owner: 'acme', repo: 'tpl', refAndPath: 'main' })
  })

  it('rejects a /blob/ link to any other file', () => {
    expect(() => parseGitHubTemplateUrl('https://github.com/acme/tpl/blob/main/README.md'))
      .toThrow(/unsupported template source/)
  })

  // Spec 4.1: a URL-shaped target NEVER falls back to a local path. Returning null here would end
  // in "no insta.template.yaml at <cwd>/https:/gitlab.com/a/b", which names neither problem nor fix.
  it('rejects other hosts and gists instead of returning null', () => {
    for (const bad of [
      'https://gitlab.com/a/b',
      'https://gist.github.com/acme/deadbeef',
      'https://bitbucket.org/a/b',
      'git@github.com:acme/tpl.git',
      'ssh://git@github.com/acme/tpl.git',
    ]) {
      expect(() => parseGitHubTemplateUrl(bad)).toThrow(/unsupported template source/)
    }
  })

  it('rejects GitHub URLs that are not repository trees', () => {
    for (const bad of [
      'https://github.com/acme',
      'https://github.com/acme/tpl/pull/3',
      'https://github.com/acme/tpl/releases/tag/v1',
      'https://github.com/acme/tpl/tree',
    ]) {
      expect(() => parseGitHubTemplateUrl(bad)).toThrow(/unsupported template source/)
    }
  })

  // Spec 4.1: path segments are validated BEFORE anything is joined to a filesystem path.
  // path.join('/tmp/x', '../../../etc') is '/etc' — silently, with no error to catch later.
  it('rejects path traversal, plain and percent-encoded', () => {
    for (const bad of [
      'https://github.com/acme/tpl/tree/main/../../../etc',
      'https://github.com/acme/tpl/tree/main/..',
      'https://github.com/acme/tpl/tree/main/%2e%2e/%2e%2e/etc',
      'https://github.com/acme/tpl/tree/main/a%2Fb',
      'https://github.com/acme/tpl/tree/main/./x',
      'https://github.com/acme/tpl/tree/main//x',
    ]) {
      expect(() => parseGitHubTemplateUrl(bad)).toThrow(/unsupported template source/)
    }
  })

  // Decoding is what makes the check meaningful, so an ordinary encoded name must still work.
  it('decodes ordinary percent-encoded segments', () => {
    expect(parseGitHubTemplateUrl('https://github.com/acme/tpl/tree/main/my%20templates/bot'))
      .toEqual({ owner: 'acme', repo: 'tpl', refAndPath: 'main/my templates/bot' })
  })
})

describe('git runner', () => {
  it('exposes the two timeout budgets the spec fixes', () => {
    expect(LS_REMOTE_TIMEOUT_MS).toBe(30_000)
    expect(CLONE_TIMEOUT_MS).toBe(120_000)
  })

  it('captures stdout and a zero exit code', async () => {
    const r = await defaultGitRunner(['--version'], { timeoutMs: LS_REMOTE_TIMEOUT_MS })
    expect(r.code).toBe(0)
    expect(r.timedOut).toBe(false)
    expect(r.stdout).toMatch(/^git version/)
  })

  it('reports a non-zero exit code with stderr instead of throwing', async () => {
    const r = await defaultGitRunner(['rev-parse', '--verify', 'refs/heads/definitely-not-a-branch-xyz'], { timeoutMs: LS_REMOTE_TIMEOUT_MS })
    expect(r.code).not.toBe(0)
    expect(r.timedOut).toBe(false)
  })

  // A local child that will not exit on its own: deterministic on every platform, no network.
  it('kills a child that outlives its timeout and flags it', async () => {
    const slowSpawn: SpawnFn = ((_cmd: string, _args: string[], opts: any) =>
      spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], opts)) as SpawnFn
    const started = Date.now()
    const r = await makeGitRunner(slowSpawn)(['ls-remote', 'https://example.invalid/x.git'], { timeoutMs: 300 })
    expect(r.timedOut).toBe(true)
    expect(r.code).not.toBe(0)
    expect(Date.now() - started).toBeLessThan(10_000)
  }, 15_000)

  // The real shape of the problem: git spawns ssh, ssh inherits the pipes, git dies, ssh does not.
  // Node's 'close' waits for the pipes, so a runner that waits for 'close' overshoots its budget.
  // Measured before the fix: child exited at 94ms, 'close' arrived at 5086ms.
  it('returns on time even when a grandchild holds the pipes open', async () => {
    // The child spawns its own long-lived child on the SAME stdout/stderr, then exits quickly.
    const parentSrc = `
      const { spawn } = require('node:child_process')
      spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], { stdio: ['ignore', 1, 2] })
      setTimeout(() => process.exit(0), 50)
    `
    const nestingSpawn: SpawnFn = ((_cmd: string, _args: string[], opts: any) =>
      spawn(process.execPath, ['-e', parentSrc], opts)) as SpawnFn
    const started = Date.now()
    const r = await makeGitRunner(nestingSpawn)(['clone', 'x'], { timeoutMs: 200 })
    const elapsed = Date.now() - started
    expect(r.timedOut).toBe(true)
    // Generous, but far below the 5s the unfixed version took.
    expect(elapsed).toBeLessThan(2000)
  }, 30_000)

  // The bound that matters to a user is when the COMMAND ends, not when a promise settles. Vitest
  // cannot watch its own event loop drain, so the runner is exercised in a child process and that
  // process's exit is timed from out here. Before releasing the pipes: promise at 203ms, process
  // exit at 20094ms.
  it('lets the process exit promptly after a timeout, even when a grandchild escaped the kill', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'insta-exit-'))
    const probe = join(dir, 'probe.mts')
    const moduleUrl = pathToFileURL(join(process.cwd(), 'src', 'github-source.ts')).href
    // The grandchild DETACHES itself, so killing our process group misses it on purpose.
    const grandchild =
      "const { spawn } = require('node:child_process');" +
      "spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], { stdio: ['ignore', 1, 2], detached: true }).unref();" +
      'setTimeout(() => process.exit(0), 30)'
    writeFileSync(probe, [
      `import { spawn } from 'node:child_process'`,
      `import { makeGitRunner } from ${JSON.stringify(moduleUrl)}`,
      `const escaping: any = (_c: string, _a: string[], opts: any) => spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}], opts)`,
      `const r = await makeGitRunner(escaping)(['clone', 'x'], { timeoutMs: 200 })`,
      `if (!r.timedOut) process.exit(3)`,
    ].join('\n'))

    const tsxCli = join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs')
    const started = Date.now()
    // The exit CODE proves the probe really ran the runner; the elapsed time is the assertion.
    const code = await new Promise<number | null>((resolve) => {
      const p = spawn(process.execPath, [tsxCli, probe], { stdio: 'ignore' })
      p.on('close', (c) => resolve(c))
    })
    const elapsed = Date.now() - started
    rmSync(dir, { recursive: true, force: true })
    expect(code).toBe(0)
    // tsx startup is most of this; the failure mode being guarded is tens of seconds.
    expect(elapsed).toBeLessThan(8000)
  }, 40_000)

  it('disables every git prompt through the child environment', async () => {
    let seenEnv: Record<string, string> = {}
    const spySpawn: SpawnFn = ((_cmd: string, _args: string[], opts: any) => {
      seenEnv = opts.env
      return spawn(process.execPath, ['-e', ''], opts)
    }) as SpawnFn
    await makeGitRunner(spySpawn)(['--version'], { timeoutMs: LS_REMOTE_TIMEOUT_MS })
    expect(seenEnv.GIT_TERMINAL_PROMPT).toBe('0')
    expect(seenEnv.GIT_SSH_COMMAND).toContain('BatchMode=yes')
  })
})
