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
