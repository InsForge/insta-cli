// Real `git`, real clone, no network: the repository is built in a temp dir and served over file://.
// Mocked tests cannot catch a wrong git invocation; this one can (spec FAQ 7.14).
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { fetchGitHubTemplate, defaultGitRunner, type GitHubTarget, type GitRunner } from '../src/github-source.js'

const MANIFEST = (code: string) =>
  `code: ${code}\nversion: "1.0"\nservices:\n  app:\n    type: worker\n    image: nginx:1.27\n`

let root = ''
let repo = ''

// fetchGitHubTemplate builds https://github.com/<owner>/<repo>.git internally, so the runner
// rewrites exactly that URL to the local repository. Everything else about the call is untouched:
// same argv, same env, same real git.
// pathToFileURL, not string interpolation: it percent-encodes spaces and `#` (which would
// otherwise truncate the URL at a fragment) and produces file:///C:/… on Windows.
const localRunner: GitRunner = (args, opts) =>
  defaultGitRunner(args.map((a) => (a === 'https://github.com/acme/tpl.git' ? pathToFileURL(repo).href : a)), opts)

const TARGET = (refAndPath: string): GitHubTarget => ({ owner: 'acme', repo: 'tpl', refAndPath })

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'insta-int-'))
  repo = join(root, 'origin')
  mkdirSync(repo)
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' })
  git('init', '-q', '--initial-branch=main', '.')
  git('config', 'user.email', 'test@example.com')
  git('config', 'user.name', 'Test')
  git('config', 'commit.gpgsign', 'false')

  mkdirSync(join(repo, 'templates', 'bot'), { recursive: true })
  writeFileSync(join(repo, 'insta.template.yaml'), MANIFEST('root-tpl'))
  writeFileSync(join(repo, 'templates', 'bot', 'insta.template.yaml'), MANIFEST('bot'))
  git('add', '-A')
  git('commit', '-q', '-m', 'first')

  // An ANNOTATED tag: its ref entry names a tag object, not this commit.
  git('tag', '-a', 'v2', '-m', 'release 2')

  // A branch and a tag sharing a name, pointing at DIFFERENT commits, so the tie-break is visible.
  git('tag', 'dup')
  git('checkout', '-q', '-b', 'dup')
  writeFileSync(join(repo, 'insta.template.yaml'), MANIFEST('dup-branch'))
  git('add', '-A')
  git('commit', '-q', '-m', 'on the dup branch')
  git('checkout', '-q', 'main')

  // A branch whose name contains a slash.
  git('checkout', '-q', '-b', 'feature/foo')
  writeFileSync(join(repo, 'insta.template.yaml'), MANIFEST('feature-tpl'))
  git('add', '-A')
  git('commit', '-q', '-m', 'on the feature branch')
  git('checkout', '-q', 'main')
})

afterAll(() => { rmSync(root, { recursive: true, force: true }) })

const headOf = (ref: string) => execFileSync('git', ['rev-parse', ref], { cwd: repo }).toString().trim()

describe('fetchGitHubTemplate against a real repository', () => {
  // First, because everything below is unreadable if the harness itself cannot run git: this one
  // failing means the runner's spawn is wrong, not that a ref or a manifest is missing.
  it('reaches the fixture repository over file://', async () => {
    const r = await localRunner(['ls-remote', '--symref', 'https://github.com/acme/tpl.git'], { timeoutMs: 30_000 })
    expect(`code=${r.code} timedOut=${r.timedOut} stdout=${r.stdout} stderr=${r.stderr}`).toContain('refs/heads/main')
  })

  it('clones the default branch and reads the root manifest', async () => {
    const got = await fetchGitHubTemplate(TARGET(''), localRunner)
    expect(got.manifest.code).toBe('root-tpl')
    expect(got.source.ref).toBe('main')
    expect(got.source.commit).toBe(headOf('main'))
  })

  it('reads a sub-directory manifest on the default branch', async () => {
    const got = await fetchGitHubTemplate(TARGET('main/templates/bot'), localRunner)
    expect(got.manifest.code).toBe('bot')
    expect(got.source.path).toBe('templates/bot')
  })

  // The case the mocked test got wrong: a real clone with a real tag.
  it('clones an annotated tag and reports the COMMIT, not the tag object', async () => {
    const got = await fetchGitHubTemplate(TARGET('v2'), localRunner)
    expect(got.manifest.code).toBe('root-tpl')
    expect(got.source.ref).toBe('v2')
    expect(got.source.commit).toBe(headOf('v2^{commit}'))
    expect(got.source.commit).not.toBe(headOf('refs/tags/v2')) // the tag object's own SHA
  })

  it('clones a branch whose name contains a slash', async () => {
    const got = await fetchGitHubTemplate(TARGET('feature/foo'), localRunner)
    expect(got.manifest.code).toBe('feature-tpl')
    expect(got.source.ref).toBe('feature/foo')
  })

  // Both refs exist and point at different commits, so only one answer can be right.
  it('prefers the branch when a branch and a tag share a name', async () => {
    const got = await fetchGitHubTemplate(TARGET('dup'), localRunner)
    expect(got.manifest.code).toBe('dup-branch')
    expect(got.source.commit).toBe(headOf('refs/heads/dup'))
    expect(got.source.commit).not.toBe(headOf('refs/tags/dup'))
  })

  it('reports a ref the repository does not have', async () => {
    await expect(fetchGitHubTemplate(TARGET('no-such-ref'), localRunner))
      .rejects.toThrow('no branch or tag no-such-ref in acme/tpl')
  })

  it('reports a directory with no manifest', async () => {
    await expect(fetchGitHubTemplate(TARGET('main/templates'), localRunner))
      .rejects.toThrow(/no insta\.template\.yaml at acme\/tpl@main:templates/)
  })
})
