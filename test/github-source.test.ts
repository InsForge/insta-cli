import { describe, it, expect } from 'vitest'
import { parseGitHubTemplateUrl } from '../src/github-source.js'

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
