import { describe, it, expect } from 'vitest'
import { compileIgnore } from '../src/pack-ignore.js'

const git = (text: string, base = '') => compileIgnore([{ base, text }], 'git')
const docker = (text: string) => compileIgnore([{ base: '', text }], 'docker')

describe('compileIgnore — shared syntax', () => {
  it('ignores blank lines and comments', () => {
    const ig = git('\n# a comment\n\n  \nbuild\n')
    expect(ig.excludes('build', true)).toBe(true)
    expect(ig.excludes('# a comment', false)).toBe(false)
  })

  it('treats a trailing-slash pattern as directory-only', () => {
    const ig = git('logs/\n')
    expect(ig.excludes('logs', true)).toBe(true)
    expect(ig.excludes('logs', false)).toBe(false)
  })

  it('matches a single path segment with * but not across a separator', () => {
    const ig = git('*.log\n')
    expect(ig.excludes('debug.log', false)).toBe(true)
    expect(ig.excludes('nested/debug.log', false)).toBe(true) // basename rule, not the star
    expect(git('src/*.log\n').excludes('src/deep/debug.log', false)).toBe(false)
  })

  it('crosses separators with **', () => {
    const ig = git('src/**/gen.js\n')
    expect(ig.excludes('src/gen.js', false)).toBe(true)
    expect(ig.excludes('src/a/b/gen.js', false)).toBe(true)
  })

  it('lets the last matching rule win, so order decides', () => {
    expect(git('*.log\n!keep.log\n').excludes('keep.log', false)).toBe(false)
    expect(git('!keep.log\n*.log\n').excludes('keep.log', false)).toBe(true)
  })
})

// git anchors only when the pattern has a slash; a bare name matches at any depth.
describe('compileIgnore — git anchoring', () => {
  it('matches a slashless pattern at any depth', () => {
    const ig = git('node_modules\n')
    expect(ig.excludes('node_modules', true)).toBe(true)
    expect(ig.excludes('packages/api/node_modules', true)).toBe(true)
  })

  it('anchors a pattern that starts with a slash', () => {
    const ig = git('/build\n')
    expect(ig.excludes('build', true)).toBe(true)
    expect(ig.excludes('src/build', true)).toBe(false)
  })

  it('anchors a pattern with an interior slash', () => {
    const ig = git('src/tmp\n')
    expect(ig.excludes('src/tmp', true)).toBe(true)
    expect(ig.excludes('vendor/src/tmp', true)).toBe(false)
  })

  it('scopes a nested ignore file to its own directory and below', () => {
    const ig = compileIgnore(
      [
        { base: '', text: 'a.txt\n' },
        { base: 'sub', text: 'b.txt\n' },
      ],
      'git',
    )
    expect(ig.excludes('b.txt', false)).toBe(false)
    expect(ig.excludes('sub/b.txt', false)).toBe(true)
    expect(ig.excludes('sub/a.txt', false)).toBe(true) // the root file still reaches down
  })

  it('lets a deeper ignore file override a shallower one', () => {
    const ig = compileIgnore(
      [
        { base: '', text: '*.log\n' },
        { base: 'sub', text: '!keep.log\n' },
      ],
      'git',
    )
    expect(ig.excludes('sub/keep.log', false)).toBe(false)
    expect(ig.excludes('keep.log', false)).toBe(true)
  })
})

describe('compileIgnore — docker anchoring', () => {
  it('anchors every pattern to the context root, slash or not', () => {
    const ig = docker('node_modules\n')
    expect(ig.excludes('node_modules', true)).toBe(true)
    expect(ig.excludes('packages/api/node_modules', true)).toBe(false)
  })

  it('needs an explicit **/ to reach any depth', () => {
    const ig = docker('**/node_modules\n')
    expect(ig.excludes('packages/api/node_modules', true)).toBe(true)
  })

  it('excludes everything under a matched directory', () => {
    const ig = docker('build\n')
    expect(ig.excludes('build/out/app.js', false)).toBe(true)
  })
})

// git cannot re-include under an excluded parent; docker can, so canPrune must stay conservative.
describe('compileIgnore — re-inclusion under an excluded directory', () => {
  it('keeps a git re-include suppressed under an excluded parent', () => {
    const ig = git('node_modules/\n!node_modules/keep.js\n')
    expect(ig.excludes('node_modules', true)).toBe(true)
    expect(ig.canPrune('node_modules')).toBe(true)
  })

  it('honours a docker re-include under an excluded parent', () => {
    const ig = docker('build\n!build/keep.js\n')
    expect(ig.excludes('build/keep.js', false)).toBe(false)
    expect(ig.excludes('build/other.js', false)).toBe(true)
    expect(ig.canPrune('build')).toBe(false)
  })

  it('still prunes a docker directory no negation can reach into', () => {
    const ig = docker('build\nvendor\n!build/keep.js\n')
    expect(ig.canPrune('vendor')).toBe(true)
  })
})

// `.gitignore` is what decides the upload boundary, so a rule that silently fails to match does
// not merely pack an extra file, it ships one the author explicitly withheld. Each of these is a
// documented gitignore(5) escape that the parser used to read as literal backslash text.
describe('compileIgnore — git escaping', () => {
  it('excludes a file whose name really starts with # via \\#', () => {
    const ig = git('\\#credentials\n')
    expect(ig.excludes('#credentials', false)).toBe(true)
    // Still a comment without the escape, and still not a rule about a backslash.
    expect(git('#credentials\n').excludes('#credentials', false)).toBe(false)
    expect(ig.excludes('\\#credentials', false)).toBe(false)
  })

  it('excludes a file whose name really starts with ! via \\!, and does not read it as negation', () => {
    const ig = git('*\n\\!secrets\n')
    // The inverse failure is the dangerous one: unescaping before the negation check would turn
    // this into "re-include secrets", so assert the file is EXCLUDED, not merely matched.
    expect(ig.excludes('!secrets', false)).toBe(true)
    expect(git('\\!secrets\n').excludes('!secrets', false)).toBe(true)
  })

  it('keeps an escaped trailing space as part of the name', () => {
    const ig = git('private\\ \n')
    expect(ig.excludes('private ', false)).toBe(true)
    expect(ig.excludes('private', false)).toBe(false)
    // Unescaped trailing spaces are still ignored, which is the other half of the same rule.
    expect(git('private  \n').excludes('private', false)).toBe(true)
  })

  it('treats an escaped wildcard as the character itself', () => {
    const ig = git('\\*.log\n')
    expect(ig.excludes('*.log', false)).toBe(true)
    expect(ig.excludes('debug.log', false)).toBe(false)
  })

  it('does not let an escaped wildcard cut the prune head short', () => {
    // literalHead must read the escape the way translate does, or it stops at the `*` and prunes
    // on the head "build/" instead of the real directory name.
    const ig = git('build\\*dir/\n')
    expect(ig.excludes('build*dir', true)).toBe(true)
    expect(ig.canPrune('build*dir')).toBe(true)
  })

  it('still honours a CRLF file, where \\r is the line ending and not pattern text', () => {
    expect(git('build\r\nvendor\r\n').excludes('build', true)).toBe(true)
  })

  // docker's own parser trims and comments unconditionally, with no line-level escape, while its
  // matcher does honour `\` inside a pattern. Both halves pinned so the flavours cannot converge.
  it('leaves docker line parsing alone but still escapes inside a pattern', () => {
    expect(docker('\\*.log\n').excludes('*.log', false)).toBe(true)
    expect(docker('\\*.log\n').excludes('debug.log', false)).toBe(false)
    expect(docker('#comment\n').excludes('#comment', false)).toBe(false)
  })
})

// `.dockerignore` decides the upload boundary, so a rule that silently fails to match ships a
// file the author withheld. These are the shapes docker's own parser handles and this one did
// not (moby/patternmatcher ReadAll: BOM strip, comment test before trim, TrimSpace, Clean).
describe('compileIgnore — docker preprocessing parity', () => {
  it('strips a UTF-8 BOM, so a BOM-prefixed first rule still matches', () => {
    expect(docker('﻿secrets.env\n').excludes('secrets.env', false)).toBe(true)
    // Same for git: the BOM belongs to the file, not to the pattern.
    expect(git('﻿secrets.env\n').excludes('secrets.env', false)).toBe(true)
  })

  it('cleans a path so a traversal spelling still names the file it resolves to', () => {
    expect(docker('foo/../secrets.env\n').excludes('secrets.env', false)).toBe(true)
    expect(docker('./secrets.env\n').excludes('secrets.env', false)).toBe(true)
    expect(docker('a//b\n').excludes('a/b', false)).toBe(true)
  })

  // Clean drops the trailing slash, so docker has no directory-only form. Treating it as one
  // under-excludes: `secrets/` would then miss a FILE called secrets.
  it('matches a file for a trailing-slash rule, the way docker does', () => {
    const ig = docker('secrets/\n')
    expect(ig.excludes('secrets', true)).toBe(true)
    expect(ig.excludes('secrets', false)).toBe(true)
    // git keeps its own meaning: there, the slash really does mean directory-only.
    expect(git('secrets/\n').excludes('secrets', false)).toBe(false)
  })

  it('trims surrounding whitespace, and only treats an UNINDENTED hash as a comment', () => {
    expect(docker('   secrets.env   \n').excludes('secrets.env', false)).toBe(true)
    // docker tests for '#' before trimming, so an indented one is a pattern, not a comment.
    expect(docker('  #secrets\n').excludes('#secrets', false)).toBe(true)
    expect(docker('#secrets\n').excludes('#secrets', false)).toBe(false)
  })

  it('trims after the negation marker too', () => {
    const ig = docker('build\n!  build/keep.js\n')
    expect(ig.excludes('build/keep.js', false)).toBe(false)
  })
})
