// `insta compute connect-repo` / `repo` / `watch-paths`: the parts that decide, without a network.
import { describe, it, expect } from 'vitest'
import type { ApiClient } from '../src/api.js'
import { parseRepoRef, pickCandidate, sourceBody, repoLine, findInstalledRepo, parseWatchPaths, computeWatchPaths, watchPathsClause, type Candidate } from '../src/commands/github.js'

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

describe('findInstalledRepo', () => {
  const fake = (answers: Record<string, unknown>) => ({ request: async (_m: string, path: string) => answers[path.split('?')[0]!] }) as unknown as ApiClient
  const ref = { owner: 'acme', repo: 'app' }
  it('names the installation that sees the repo, as numbers, matching case-insensitively', async () => {
    const api = fake({ '/github/installations': { installations: [{ installation_id: '7', account_login: 'Acme' }] }, '/github/installations/7/repos': { repos: [{ id: 42, owner: 'Acme', repo: 'App' }] } })
    await expect(findInstalledRepo(api, 'org_1', ref)).resolves.toEqual({ installationId: 7, repoId: 42 })
  })
  it('a repo in no installation names the accounts and the --public way out', async () => {
    const api = fake({ '/github/installations': { installations: [{ installation_id: '7', account_login: 'Acme' }] }, '/github/installations/7/repos': { repos: [] } })
    await expect(findInstalledRepo(api, 'org_1', ref)).rejects.toThrow(/installed on: Acme.*--public/)
  })
  it('no installation at all points at the console', async () => {
    await expect(findInstalledRepo(fake({ '/github/installations': { installations: [] } }), 'org_1', ref)).rejects.toThrow(/connect GitHub in the console first/)
  })
  it('an org-less link is refused before any request', async () => {
    await expect(findInstalledRepo(fake({}), '', ref)).rejects.toThrow(/INSTA_ORG_ID/)
  })
})

describe('repo line', () => {
  const gh = { type: 'github' as const, owner: 'acme', repo: 'app', branch: 'main', root_dir: null, auto_deploy: true, public: false }
  it('says how it redeploys, or how to connect one', () => {
    expect(repoLine('api', gh)).toBe('compute api: deploys from acme/app@main — every push to main redeploys it')
    expect(repoLine('api', { ...gh, root_dir: 'apps/api', auto_deploy: false })).toBe('compute api: deploys from acme/app@main (apps/api/) — auto-deploy off (pushes do not redeploy)')
    expect(repoLine('api', { ...gh, public: true, auto_deploy: false })).toMatch(/public repo, deploys are manual/)
    expect(repoLine('api', { type: 'image', image: 'nginx:1.27' })).toMatch(/no repository connected \(runs image nginx:1.27\) — connect one with `insta compute connect-repo <owner\/repo> api`/)
    expect(repoLine('api', { type: 'image', image: null })).toMatch(/^compute api: no repository connected — connect one/)
  })

  it('names the watch paths as repo-root paths, since the same line carries root_dir', () => {
    expect(repoLine('api', { ...gh, watch_paths: ['apps/api/**', 'packages/**'] }))
      .toBe('compute api: deploys from acme/app@main — every push to main redeploys it, but only when a push changes these repo-root paths: apps/api/**, packages/**')
    // root_dir is apps/api, the pattern is repo-root src/**: the line must not let those read as one root.
    expect(repoLine('api', { ...gh, root_dir: 'apps/api', watch_paths: ['src/**'] }))
      .toBe('compute api: deploys from acme/app@main (apps/api/) — every push to main redeploys it, but only when a push changes these repo-root paths: src/**')
    expect(repoLine('api', { ...gh, watch_paths: [] })).toBe('compute api: deploys from acme/app@main — every push to main redeploys it')
    expect(repoLine('api', { ...gh, watch_paths: null })).toBe('compute api: deploys from acme/app@main — every push to main redeploys it')
    // A push cannot redeploy these at all, so the line must not promise that it would on a match.
    expect(repoLine('api', { ...gh, public: true, auto_deploy: false, watch_paths: ['apps/api/**'] }))
      .toBe('compute api: deploys from acme/app@main — public repo, deploys are manual (pushes do not redeploy); watch paths apps/api/** are stored but cannot apply')
    expect(repoLine('api', { ...gh, auto_deploy: false, watch_paths: ['apps/api/**'] })).toMatch(/auto-deploy off .*; watch paths apps\/api\/\*\* are stored but cannot apply/)
  })
})

// The clause `insta compute repo` prints and the one `connect-repo` confirms with are the same string:
// a connect that stores a filter must not answer "every push redeploys it".
describe('watchPathsClause', () => {
  it('names the root the patterns are against, since every line carrying it also carries root_dir', () => {
    expect(watchPathsClause(['apps/web/**', 'packages/**'])).toBe(', but only when a push changes these repo-root paths: apps/web/**, packages/**')
  })
  it('is what repoLine appends, so the two lines cannot drift', () => {
    const gh = { type: 'github' as const, owner: 'acme', repo: 'app', branch: 'main', root_dir: null, auto_deploy: true, public: false, watch_paths: ['apps/web/**'] }
    expect(repoLine('api', gh)).toContain(watchPathsClause(['apps/web/**']))
  })
})

describe('computeWatchPaths validation (throws before any network/config access)', () => {
  it('refuses --set together with --clear', async () => {
    await expect(computeWatchPaths('api', { set: 'apps/web/**', clear: true })).rejects.toThrow(/--set or --clear, not both/)
  })
  it('refuses an empty --set before it can be read as a clear', async () => {
    // The server coerces a list that normalizes to nothing into null, i.e. into a clear.
    await expect(computeWatchPaths('api', { set: ' , ' })).rejects.toThrow(/at least one pattern/)
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

