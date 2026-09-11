// `insta compute connect-repo` / `repo` / `watch-paths`: the parts that decide, without a network.
import { describe, it, expect, vi } from 'vitest'
import { ApiError, type ApiClient } from '../src/api.js'
import { parseRepoRef, pickCandidate, sourceBody, repoLine, findCallerRepo, authorizeTerminal, parseWatchPaths, computeWatchPaths, watchPathsClause, type Candidate } from '../src/commands/github.js'

const cand = (o: Partial<Candidate> = {}): Candidate => ({ rootDir: null, builder: 'nixpacks', buildCommand: 'npm run build', startCommand: 'npm start', port: 3000, ...o })

describe('parseRepoRef', () => {
  it('accepts owner/repo and the github.com URL shapes people paste', () => {
    for (const raw of ['acme/app', 'github.com/acme/app', 'https://github.com/acme/app', 'https://www.github.com/acme/app.git', ' https://github.com/acme/app/ ', 'https://github.com/acme/app.git/']) {
      expect(parseRepoRef(raw)).toEqual({ owner: 'acme', repo: 'app' })
    }
  })
  it('refuses anything else before a request is made', () => {
    for (const raw of ['app', 'acme/app/tree/main', 'https://gitlab.com/acme/app', '']) {
      expect(() => parseRepoRef(raw)).toThrow(/not a GitHub repository reference/)
    }
  })
})

describe('pickCandidate', () => {
  it('a single detected directory is the pick', () => {
    expect(pickCandidate([cand()])).toEqual(cand())
  })
  it('several without --root-dir refuse and list them', () => {
    expect(() => pickCandidate([cand({ rootDir: 'apps/web' }), cand({ rootDir: 'apps/api' })]))
      .toThrow(/2 deployable directories[\s\S]*apps\/web[\s\S]*apps\/api/)
  })
  it('--root-dir picks by path; repo-root spellings mean the platform\'s null', () => {
    const root = cand(); const api = cand({ rootDir: 'apps/api' })
    expect(pickCandidate([root, api], 'apps/api')).toBe(api)
    expect(pickCandidate([root, api], '/apps/api/')).toBe(api)
    for (const spelling of ['', '.', '/', './']) expect(pickCandidate([root, api], spelling)).toBe(root)
    expect(() => pickCandidate([root, api], 'packages/x')).toThrow(/no deployable directory at packages\/x — detected: \(repo root\), apps\/api/)
  })
  it('nothing detected is its own message', () => {
    expect(() => pickCandidate([])).toThrow(/no deployable service detected/)
  })
})

describe('sourceBody', () => {
  const app = { source: 'app' as const, installationId: 7, repoId: 42, owner: 'acme', repo: 'app' }
  it('sends the picked directory and its detected config — no name, no env, no branch unless asked', () => {
    expect(sourceBody(app, cand({ rootDir: 'apps/web' }), {})).toEqual({ installationId: 7, repoId: 42, owner: 'acme', repo: 'app', rootDir: 'apps/web', buildCommand: 'npm run build', startCommand: 'npm start', port: 3000 })
  })
  it('a public repo sends owner/repo flagged public, never installation ids', () => {
    expect(sourceBody({ source: 'public', owner: 'acme', repo: 'app' }, cand(), {})).toMatchObject({ public: true, owner: 'acme', repo: 'app' })
    expect(sourceBody({ source: 'public', owner: 'acme', repo: 'app' }, cand(), {})).not.toHaveProperty('installationId')
  })
  it('--repo-branch, --no-auto-deploy and --watch-paths ride along only when given', () => {
    expect(sourceBody(app, cand(), { repoBranch: 'release', autoDeploy: false })).toMatchObject({ branch: 'release', autoDeploy: false })
    expect(sourceBody(app, cand(), { autoDeploy: true })).not.toHaveProperty('autoDeploy')
    expect(sourceBody(app, cand(), {})).not.toHaveProperty('watchPaths')
    expect(sourceBody(app, cand(), { watchPaths: 'apps/web/**' })).toMatchObject({ watchPaths: ['apps/web/**'] })
    // An unset shell variable must not connect the repo with no filter at all.
    expect(() => sourceBody(app, cand(), { watchPaths: '' })).toThrow(/at least one pattern/)
  })
  it('--port overrides the detected port through the shared parser', () => {
    expect(sourceBody(app, cand(), { port: '8080' }).port).toBe(8080)
    expect(() => sourceBody(app, cand(), { port: '0x1f90' })).toThrow(/port must be/)
  })
})

describe('authorizeTerminal', () => {
  const start = { state: 's1', verificationUri: 'https://github.com/login/device', userCode: 'WDJB-MJHT', interval: 1, expiresAt: new Date(Date.now() + 900_000).toISOString() }
  const drive = (answers: unknown[], startOverride: Record<string, unknown> = {}) => {
    const polls: unknown[] = []; const waits: number[] = []; const said: string[] = []
    const api = { request: async (method: string, path: string, body?: unknown) => {
      if (path === '/orgs/org_1/github/device') { expect(method).toBe('POST'); return { ...start, ...startOverride } }
      if (path !== '/orgs/org_1/github/device/poll') throw new Error(`unexpected path ${path}`)
      expect(method).toBe('POST')
      polls.push(body)
      const a = answers.shift()
      if (a instanceof Error) throw a
      return a
    } } as unknown as ApiClient
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((l: any) => { said.push(String(l)); return true })
    return { api, polls, waits, said, spy, wait: async (s: number) => { waits.push(s) } }
  }
  it('prints the URL and the code, then polls with its own state until the person confirms', async () => {
    const d = drive([{ pending: true, slowDownBy: 0 }, { pending: false, repos: [{ id: 42, owner: 'acme', repo: 'app', installationId: 7 }] }])
    await expect(authorizeTerminal(d.api, 'org_1', d.wait)).resolves.toEqual([{ id: 42, owner: 'acme', repo: 'app', installationId: 7 }])
    expect(d.polls).toEqual([{ state: 's1' }, { state: 's1' }])
    // The URL and the code ARE the flow: without them on screen there is nothing for the person to do.
    expect(d.said.join('')).toContain('https://github.com/login/device')
    expect(d.said.join('')).toContain('WDJB-MJHT')
    d.spy.mockRestore()
  })
  it('honours slow_down and refuses a negative one: either way the wait must not collapse', async () => {
    const d = drive([{ pending: true, slowDownBy: 5 }, { pending: true, slowDownBy: -30 }, { pending: false, repos: [] }])
    await authorizeTerminal(d.api, 'org_1', d.wait); d.spy.mockRestore()
    expect(d.waits).toEqual([1, 6, 6])
  })
  it('clamps an interval Node would fire instantly', async () => {
    for (const [given, expected] of [[0, 5], [1e12, 60], [-4, 5]] as const) {
      const d = drive([{ pending: false, repos: [] }], { interval: given })
      await authorizeTerminal(d.api, 'org_1', d.wait); d.spy.mockRestore()
      expect(d.waits).toEqual([expected])
    }
  })
  it('a missing expiry is refused, not turned into an endless loop', async () => {
    const d = drive([{ pending: true }], { expiresAt: undefined })
    await expect(authorizeTerminal(d.api, 'org_1', d.wait)).rejects.toThrow(/missing expiresAt/)
    expect(d.polls).toEqual([]); d.spy.mockRestore()
  })
  it('stops at the deadline instead of polling forever', async () => {
    const d = drive([{ pending: true }], { expiresAt: new Date(Date.now() - 1).toISOString() })
    await expect(authorizeTerminal(d.api, 'org_1', d.wait)).rejects.toThrow(/expired before it was confirmed/)
    expect(d.polls).toEqual([]); d.spy.mockRestore()
  })
  it('a rate-limited or dropped poll backs off instead of ending the authorization', async () => {
    const d = drive([new ApiError(429, 'HTTP 429', {}), new TypeError('socket hang up'), { pending: false, repos: [] }])
    await expect(authorizeTerminal(d.api, 'org_1', d.wait)).resolves.toEqual([]); d.spy.mockRestore()
    expect(d.waits).toEqual([1, 6, 11])
  })
  it('a confirmed authorization that carries no repositories fails loudly', async () => {
    const d = drive([{ pending: false }])
    await expect(authorizeTerminal(d.api, 'org_1', d.wait)).rejects.toThrow(/returned no repositories/); d.spy.mockRestore()
  })
})

describe('findCallerRepo', () => {
  const fake = (answers: Record<string, unknown>) => ({ request: async (_m: string, path: string) => {
    const a = answers[path.split('?')[0]!]
    if (a instanceof Error) throw a
    if (a === undefined) throw new Error(`unexpected path ${path}`)
    return a
  } }) as unknown as ApiClient
  const ref = { owner: 'acme', repo: 'app' }
  const never = async () => { throw new Error('must not authorize') }
  const listed = (repos: unknown[]) => fake({ '/orgs/org_1/github/repos': { repos } })
  it('answers the installation the repo came from, as numbers, matching case-insensitively', async () => {
    await expect(findCallerRepo(listed([{ id: 42, owner: 'Acme', repo: 'App', installationId: 7 }]), 'org_1', ref, never)).resolves.toEqual({ installationId: 7, repoId: 42 })
  })
  it('a repo this caller cannot reach says so, with the --public way out', async () => {
    await expect(findCallerRepo(listed([{ id: 9, owner: 'acme', repo: 'other', installationId: 7 }]), 'org_1', ref, never)).rejects.toThrow(/not one your GitHub account can reach[\s\S]*--public/)
  })
  it('reaching nothing at all points at installing the App', async () => {
    await expect(findCallerRepo(listed([]), 'org_1', ref, never)).rejects.toThrow(/install it on the account/)
  })
  it('a listed repo with no usable installation id is named as that, not as unreachable', async () => {
    for (const bad of [null, 0, '', undefined]) {
      await expect(findCallerRepo(listed([{ id: 42, owner: 'acme', repo: 'app', installationId: bad }]), 'org_1', ref, never)).rejects.toThrow(/without an installation to build it through/)
    }
  })
  it('an unlinked terminal authorizes once, and the repos that come back are used', async () => {
    const api = fake({ '/orgs/org_1/github/repos': new ApiError(400, 'your github account is not linked — authorize github, then list again', {}) })
    await expect(findCallerRepo(api, 'org_1', ref, async () => [{ id: 42, owner: 'acme', repo: 'app', installationId: 7 }])).resolves.toEqual({ installationId: 7, repoId: 42 })
  })
  it('a dead authorization also authorizes again', async () => {
    const api = fake({ '/orgs/org_1/github/repos': new ApiError(400, 'your github authorization is no longer accepted — authorize github again', {}) })
    await expect(findCallerRepo(api, 'org_1', ref, async () => [{ id: 42, owner: 'acme', repo: 'app', installationId: 7 }])).resolves.toEqual({ installationId: 7, repoId: 42 })
  })
  it('the same words at another status are a real failure, not a reason to visit GitHub', async () => {
    const api = fake({ '/orgs/org_1/github/repos': new ApiError(502, 'your github account is not linked', {}) })
    await expect(findCallerRepo(api, 'org_1', ref, never)).rejects.toThrow(/not linked/)
  })
  it('a member is told what role connecting needs', async () => {
    const api = fake({ '/orgs/org_1/github/repos': new ApiError(403, 'requires admin role', {}) })
    await expect(findCallerRepo(api, 'org_1', ref, never)).rejects.toThrow(/needs the org admin role/)
  })
  it('an org-less link is refused before any request', async () => {
    await expect(findCallerRepo(fake({}), '', ref, never)).rejects.toThrow(/INSTA_ORG_ID/)
  })
})

describe('parseWatchPaths', () => {
  it('splits the quoted list a shell hands over, and drops what is not a pattern', () => {
    expect(parseWatchPaths('apps/web/**,packages/ui/**')).toEqual(['apps/web/**', 'packages/ui/**'])
    expect(parseWatchPaths(' apps/web/** , , packages/ui/** ')).toEqual(['apps/web/**', 'packages/ui/**'])
  })
  it('refuses an empty list rather than sending one', () => {
    for (const raw of ['', '  ', ',', ' , ']) expect(() => parseWatchPaths(raw)).toThrow(/at least one pattern/)
  })
})

