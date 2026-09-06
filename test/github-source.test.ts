import { describe, it, expect } from 'vitest'
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync, existsSync, mkdirSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  parseGitHubTemplateUrl, defaultGitRunner, makeGitRunner,
  LS_REMOTE_TIMEOUT_MS, CLONE_TIMEOUT_MS, type SpawnFn,
  parseLsRemote, splitRefAndPath, resolveGitHubRef, repoUrl, type GitRunner,
  fetchGitHubTemplate, type GitHubSource,
} from '../src/github-source.js'
import type { TemplateManifest } from '../src/template-manifest.js'

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
    // The message carries the whole result: a spawn that went wrong is unreadable from `code` alone.
    expect(r.code, JSON.stringify(r)).toBe(0)
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
  // Windows only: a grandchild does not hold the parent's pipe handles the way POSIX does, so the
  // condition this guards cannot be built there — the child simply exits and 'close' arrives early.
  it.skipIf(process.platform === 'win32')('returns on time even when a grandchild holds the pipes open', async () => {
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

  // A user's GIT_SSH_COMMAND carries the identity a private repo authenticates with (`ssh -i …`,
  // or a wrapper). Replacing it would drop exactly the credentials this feature promises to use.
  it('extends an existing GIT_SSH_COMMAND instead of replacing it', async () => {
    const original = process.env.GIT_SSH_COMMAND
    process.env.GIT_SSH_COMMAND = 'ssh -i /tmp/work_key'
    try {
      let seenEnv: Record<string, string> = {}
      const spySpawn: SpawnFn = ((_cmd: string, _args: string[], opts: any) => {
        seenEnv = opts.env
        return spawn(process.execPath, ['-e', ''], opts)
      }) as SpawnFn
      await makeGitRunner(spySpawn)(['--version'], { timeoutMs: LS_REMOTE_TIMEOUT_MS })
      expect(seenEnv.GIT_SSH_COMMAND).toBe('ssh -i /tmp/work_key -o BatchMode=yes')
    } finally {
      if (original === undefined) delete process.env.GIT_SSH_COMMAND
      else process.env.GIT_SSH_COMMAND = original
    }
  })

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

const SHA_MAIN = 'a'.repeat(40)
const SHA_TAG_OBJECT = 'b'.repeat(40)
const SHA_TAG_COMMIT = 'd'.repeat(40) // an annotated tag's peeled commit differs from its tag object
const SHA_SLASH = 'c'.repeat(40)
const SHA_DUP_BRANCH = 'e'.repeat(40)
const SHA_DUP_TAG = 'f'.repeat(40)

// Shaped like real output. v2 is an ANNOTATED tag: the ^{} line carries a different SHA, measured
// against github.com/git/git where v2.43.0 lists c089584a and its peel lists 564d0252.
const LS_REMOTE_OUT = [
  `ref: refs/heads/main\tHEAD`,
  `${SHA_MAIN}\tHEAD`,
  `${SHA_MAIN}\trefs/heads/main`,
  `${SHA_SLASH}\trefs/heads/feature/foo`,
  `${SHA_DUP_BRANCH}\trefs/heads/dup`,
  `${SHA_TAG_OBJECT}\trefs/tags/v2`,
  `${SHA_TAG_COMMIT}\trefs/tags/v2^{}`,
  `${SHA_DUP_TAG}\trefs/tags/dup`,
  '',
].join('\n')

const TARGET = { owner: 'acme', repo: 'tpl', refAndPath: '' }
const okRunner = (stdout: string): GitRunner => async () => ({ code: 0, stdout, stderr: '', timedOut: false })

describe('parseLsRemote', () => {
  it('reads the default branch from the HEAD symref', () => {
    expect(parseLsRemote(LS_REMOTE_OUT).head).toBe('main')
  })
  it('keys refs by their FULL name so a branch and a tag can share a short one', () => {
    const { refs } = parseLsRemote(LS_REMOTE_OUT)
    expect(refs.get('refs/heads/dup')).toBe(SHA_DUP_BRANCH)
    expect(refs.get('refs/tags/dup')).toBe(SHA_DUP_TAG)
    expect(refs.get('refs/heads/feature/foo')).toBe(SHA_SLASH)
  })
  // A peeled entry names the commit behind an annotated tag; it is not a ref anyone can clone.
  it('does not expose peeled tag entries as refs of their own', () => {
    expect(parseLsRemote(LS_REMOTE_OUT).refs.has('refs/tags/v2^{}')).toBe(false)
  })
})

describe('splitRefAndPath', () => {
  const refs = parseLsRemote(LS_REMOTE_OUT).refs
  it('splits a tag from its directory and qualifies it', () => {
    expect(splitRefAndPath('v2/templates/bot', refs)).toEqual({ ref: 'v2', qualifiedRef: 'refs/tags/v2', path: 'templates/bot' })
  })
  it('prefers the longest matching ref, so a branch containing a slash wins', () => {
    expect(splitRefAndPath('feature/foo/templates/bot', refs))
      .toEqual({ ref: 'feature/foo', qualifiedRef: 'refs/heads/feature/foo', path: 'templates/bot' })
  })
  it('handles a ref with no directory', () => {
    expect(splitRefAndPath('main', refs)).toEqual({ ref: 'main', qualifiedRef: 'refs/heads/main', path: '' })
  })
  // Spec FAQ 7.11: git clone --branch resolves an ambiguous name to the branch; so do we, explicitly.
  it('prefers the branch when a branch and a tag share a name', () => {
    expect(splitRefAndPath('dup/x', refs)).toEqual({ ref: 'dup', qualifiedRef: 'refs/heads/dup', path: 'x' })
  })
  it('returns null when no ref matches', () => {
    expect(splitRefAndPath('nope/templates/bot', refs)).toBeNull()
  })
})

describe('resolveGitHubRef', () => {
  it('uses the default branch when the URL names no ref', async () => {
    expect(await resolveGitHubRef(TARGET, okRunner(LS_REMOTE_OUT)))
      .toEqual({ ref: 'main', qualifiedRef: 'refs/heads/main', path: '' })
  })

  it('resolves a tag with a directory, and reports no commit of its own', async () => {
    const r = await resolveGitHubRef({ ...TARGET, refAndPath: 'v2/templates/bot' }, okRunner(LS_REMOTE_OUT))
    expect(r).toEqual({ ref: 'v2', qualifiedRef: 'refs/tags/v2', path: 'templates/bot' })
    expect(r).not.toHaveProperty('commit')
  })

  it('resolves a branch whose name contains a slash', async () => {
    expect(await resolveGitHubRef({ ...TARGET, refAndPath: 'feature/foo/templates/bot' }, okRunner(LS_REMOTE_OUT)))
      .toEqual({ ref: 'feature/foo', qualifiedRef: 'refs/heads/feature/foo', path: 'templates/bot' })
  })

  it('calls ls-remote once, with --symref, on the https repo URL', async () => {
    const seen: string[][] = []
    const run: GitRunner = async (args) => { seen.push(args); return { code: 0, stdout: LS_REMOTE_OUT, stderr: '', timedOut: false } }
    await resolveGitHubRef(TARGET, run)
    expect(seen).toEqual([['ls-remote', '--symref', 'https://github.com/acme/tpl.git']])
  })

  it('names the missing ref when nothing matches', async () => {
    await expect(resolveGitHubRef({ ...TARGET, refAndPath: 'nope/x' }, okRunner(LS_REMOTE_OUT)))
      .rejects.toThrow('no branch or tag nope/x in acme/tpl')
  })

  it('tells the user how to sign in when the repository cannot be read', async () => {
    const run: GitRunner = async () => ({ code: 128, stdout: '', stderr: 'remote: Repository not found.', timedOut: false })
    await expect(resolveGitHubRef(TARGET, run))
      .rejects.toThrow(/could not read https:\/\/github\.com\/acme\/tpl[\s\S]*gh auth login[\s\S]*gh auth setup-git/)
  })

  it('reports a timeout as a timeout, naming the budget', async () => {
    const run: GitRunner = async () => ({ code: -1, stdout: '', stderr: '', timedOut: true })
    await expect(resolveGitHubRef(TARGET, run)).rejects.toThrow('timed out after 30s resolving https://github.com/acme/tpl')
  })

  it('says git is missing when the binary cannot be spawned', async () => {
    const run: GitRunner = async () => ({ code: -1, stdout: '', stderr: 'spawn git ENOENT', timedOut: false })
    await expect(resolveGitHubRef(TARGET, run)).rejects.toThrow(/git is required to deploy a template from a GitHub URL/)
  })
})

const MANIFEST_YAML = 'code: bot\nversion: "1.4.0"\nservices:\n  app:\n    type: worker\n    image: ghcr.io/acme/bot:1.4.0\n'
const HEAD_COMMIT = '9'.repeat(40)

// A runner that answers ls-remote from the fixture, writes a manifest on clone the way git would,
// and answers rev-parse with a commit that matches NEITHER ls-remote SHA — so a test can only pass
// by reading the checkout.
function cloneRunner(opts: { manifestAt?: string; symlinkTo?: string } = {}) {
  const calls: string[][] = []
  const dirs: string[] = []
  const run: GitRunner = async (args) => {
    calls.push(args)
    if (args[0] === 'ls-remote') return { code: 0, stdout: LS_REMOTE_OUT, stderr: '', timedOut: false }
    if (args[0] === '-C') return { code: 0, stdout: `${HEAD_COMMIT}\n`, stderr: '', timedOut: false }
    const dest = args[args.length - 1]!
    dirs.push(dest)
    if (opts.symlinkTo !== undefined) {
      mkdirSync(dest, { recursive: true })
      symlinkSync(opts.symlinkTo, join(dest, 'templates'))
    } else if (opts.manifestAt !== undefined) {
      const dir = opts.manifestAt ? join(dest, opts.manifestAt) : dest
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'insta.template.yaml'), MANIFEST_YAML)
    }
    return { code: 0, stdout: '', stderr: '', timedOut: false }
  }
  return { run, calls, dirs }
}

describe('fetchGitHubTemplate', () => {
  it('clones the resolved ref shallowly by short name and returns the manifest with its source', async () => {
    const { run, calls, dirs } = cloneRunner({ manifestAt: 'templates/bot' })
    const got = await fetchGitHubTemplate({ owner: 'acme', repo: 'tpl', refAndPath: 'v2/templates/bot' }, run)

    expect(got.manifest.code).toBe('bot')
    expect(got.source).toEqual<GitHubSource>({ repo: 'acme/tpl', ref: 'v2', path: 'templates/bot', commit: HEAD_COMMIT })
    const clone = calls.find((c) => c[0] === 'clone')!
    expect(clone.slice(0, 5)).toEqual(['clone', '--depth', '1', '--quiet', '--branch'])
    // The SHORT name: `--branch refs/tags/v2` exits 128 against a real remote (spec FAQ 7.14).
    expect(clone[5]).toBe('v2')
    expect(clone).not.toContain('refs/tags/v2')
    expect(clone).toContain('https://github.com/acme/tpl.git')
    expect(existsSync(dirs[0]!)).toBe(false)
  })

  // Spec acceptance 11: for an annotated tag the ls-remote SHA is the tag OBJECT. Reporting it
  // would be reporting something that is not the deployed commit.
  it('reports the checked-out commit, not any SHA from the ref listing', async () => {
    const { run } = cloneRunner({ manifestAt: 'templates/bot' })
    const got = await fetchGitHubTemplate({ owner: 'acme', repo: 'tpl', refAndPath: 'v2/templates/bot' }, run)
    expect(got.source.commit).toBe(HEAD_COMMIT)
    expect(got.source.commit).not.toBe(SHA_TAG_OBJECT)
    expect(got.source.commit).not.toBe(SHA_TAG_COMMIT)
  })

  it('runs rev-parse inside the clone', async () => {
    const { run, calls, dirs } = cloneRunner({ manifestAt: '' })
    await fetchGitHubTemplate({ owner: 'acme', repo: 'tpl', refAndPath: '' }, run)
    const revParse = calls.find((c) => c[0] === '-C')!
    expect(revParse).toEqual(['-C', dirs[0]!, 'rev-parse', 'HEAD'])
  })

  it('reads the repository root when the URL names no directory', async () => {
    const { run } = cloneRunner({ manifestAt: '' })
    const got = await fetchGitHubTemplate({ owner: 'acme', repo: 'tpl', refAndPath: '' }, run)
    expect(got.source).toEqual({ repo: 'acme/tpl', ref: 'main', path: '', commit: HEAD_COMMIT })
  })

  it('names the repo, ref and directory when the manifest is absent, and still cleans up', async () => {
    const { run, dirs } = cloneRunner() // clone succeeds, writes nothing
    await expect(fetchGitHubTemplate({ owner: 'acme', repo: 'tpl', refAndPath: 'v2/templates/bot' }, run))
      .rejects.toThrow(/no insta\.template\.yaml at acme\/tpl@v2:templates\/bot[\s\S]*Point the URL at the directory/)
    expect(existsSync(dirs[0]!)).toBe(false)
  })

  // Spec 4.2 step 5: a committed symlink can point anywhere; following one would read a file the
  // user never chose and post its contents to the platform.
  it('refuses a manifest that resolves outside the clone through a symlink', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'insta-outside-'))
    mkdirSync(join(outside, 'bot'), { recursive: true })
    writeFileSync(join(outside, 'bot', 'insta.template.yaml'), MANIFEST_YAML)
    const { run, dirs } = cloneRunner({ symlinkTo: outside })
    await expect(fetchGitHubTemplate({ owner: 'acme', repo: 'tpl', refAndPath: 'v2/templates/bot' }, run))
      .rejects.toThrow(/resolves outside the repository — refusing to read it/)
    expect(existsSync(dirs[0]!)).toBe(false)
    rmSync(outside, { recursive: true, force: true })
  })

  it('surfaces a clone failure with the sign-in hint and cleans up', async () => {
    const run: GitRunner = async (args) =>
      args[0] === 'ls-remote'
        ? { code: 0, stdout: LS_REMOTE_OUT, stderr: '', timedOut: false }
        : { code: 128, stdout: '', stderr: 'remote: Repository not found.', timedOut: false }
    await expect(fetchGitHubTemplate({ owner: 'acme', repo: 'tpl', refAndPath: '' }, run))
      .rejects.toThrow(/could not read https:\/\/github\.com\/acme\/tpl[\s\S]*gh auth setup-git/)
  })

  it('reports a clone timeout with the clone budget', async () => {
    const run: GitRunner = async (args) =>
      args[0] === 'ls-remote'
        ? { code: 0, stdout: LS_REMOTE_OUT, stderr: '', timedOut: false }
        : { code: -1, stdout: '', stderr: '', timedOut: true }
    await expect(fetchGitHubTemplate({ owner: 'acme', repo: 'tpl', refAndPath: '' }, run))
      .rejects.toThrow('timed out after 120s cloning https://github.com/acme/tpl')
  })

  it('propagates a manifest that fails validation, and still cleans up', async () => {
    const { run, dirs } = cloneRunner({ manifestAt: '' })
    const load = () => { throw new Error('insta.template.yaml is not deployable:\n  - services.app: image and build are mutually exclusive') }
    await expect(fetchGitHubTemplate({ owner: 'acme', repo: 'tpl', refAndPath: '' }, run, load))
      .rejects.toThrow(/not deployable/)
    expect(existsSync(dirs[0]!)).toBe(false)
  })
})
