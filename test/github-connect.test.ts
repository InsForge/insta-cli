// `insta compute connect-repo` / `insta compute repo`: the parts that decide, without a network.
import { describe, it, expect } from 'vitest'
import type { ApiClient } from '../src/api.js'
import { parseRepoRef, pickCandidate, sourceBody, repoLine, findInstalledRepo, type Candidate } from '../src/commands/github.js'

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
  it('--repo-branch and --no-auto-deploy ride along only when given', () => {
    expect(sourceBody(app, cand(), { repoBranch: 'release', autoDeploy: false })).toMatchObject({ branch: 'release', autoDeploy: false })
    expect(sourceBody(app, cand(), { autoDeploy: true })).not.toHaveProperty('autoDeploy')
  })
  it('--port overrides the detected port through the shared parser', () => {
    expect(sourceBody(app, cand(), { port: '8080' }).port).toBe(8080)
    expect(() => sourceBody(app, cand(), { port: '0x1f90' })).toThrow(/port must be/)
  })
  // A repo-backed worker is the same shape as an image-backed one: `--port 0` must override the
  // detected HTTP port rather than being rejected or falling back to it.
  it('--port 0 connects the repo as a worker, overriding the detected port', () => {
    expect(sourceBody(app, cand({ port: 3000 }), { port: '0' }).port).toBe(0)
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
})
