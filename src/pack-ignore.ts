import { posix } from 'node:path'

// Ignore matching for `insta deploy <dir>`: git and docker anchor patterns differently.

export type Flavour = 'git' | 'docker'

// base: the file's own directory, relative to the archive root ('' at the root).
export type IgnoreFile = { base: string; text: string }

export interface Ignore {
  excludes(relPath: string, isDir: boolean): boolean
  // May the walker skip descending into this excluded directory?
  canPrune(dirPath: string): boolean
}

type Rule = { re: RegExp; negated: boolean; dirOnly: boolean; literal: string }

const escapeLiteral = (c: string): string => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// Glob to RegExp: `*` and `?` stop at a separator, only `**` crosses one.
function translate(p: string): string {
  let out = ''
  let i = 0
  while (i < p.length) {
    if (p.startsWith('**/', i)) {
      out += '(?:.*/)?' // any number of directories, including none
      i += 3
    } else if (p.startsWith('/**', i) && i + 3 === p.length) {
      out += '(?:/.*)?'
      i += 3
    } else if (p.startsWith('**', i)) {
      out += '.*'
      i += 2
    } else if (p.charAt(i) === '*') {
      out += '[^/]*'
      i += 1
    } else if (p.charAt(i) === '?') {
      out += '[^/]'
      i += 1
    } else if (p.charAt(i) === '[') {
      const end = p.indexOf(']', i + 1)
      if (end === -1) {
        out += '\\['
        i += 1
      } else {
        const cls = p.slice(i + 1, end)
        out += '[' + (cls.startsWith('!') ? '^' + cls.slice(1) : cls) + ']'
        i = end + 1
      }
    } else if (p.charAt(i) === '\\' && i + 1 < p.length) {
      // Escape: the next character is data, not a wildcard. Git documents this, and docker's
      // matcher (Go filepath.Match) honours it too, so it applies to both flavours.
      out += escapeLiteral(p.charAt(i + 1))
      i += 2
    } else {
      out += escapeLiteral(p.charAt(i))
      i += 1
    }
  }
  return out
}

// Wildcard-free head of a pattern; empty means it could match anywhere. Escape-aware for the same
// reason translate() is: `\*` is a literal star, so a head stopping at it would prune the wrong
// tree, and the head must be UNESCAPED because it is compared against real path text.
function literalHead(full: string): string {
  let out = ''
  for (let i = 0; i < full.length; i++) {
    const c = full.charAt(i)
    if (c === '\\' && i + 1 < full.length) {
      out += full.charAt(i + 1)
      i += 1
      continue
    }
    if (c === '*' || c === '?' || c === '[') return out
    out += c
  }
  return out
}

// Git ignores trailing spaces UNLESS escaped, so `private\ ` names a file whose name ends in a
// space. Stripping unconditionally silently widened every such rule to a different path.
function stripTrailingSpaces(line: string): string {
  let end = line.length
  while (end > 0 && line.charAt(end - 1) === ' ') {
    let backslashes = 0
    for (let k = end - 2; k >= 0 && line.charAt(k) === '\\'; k--) backslashes++
    if (backslashes % 2 === 1) break
    end -= 1
  }
  return line.slice(0, end)
}

// Docker's own preprocessing, in its order (moby/patternmatcher ReadAll): the comment test runs
// BEFORE trimming, so `  #x` is a pattern and not a comment, and every surviving pattern goes
// through filepath.Clean. Clean is the part that matters most here: it resolves `foo/../secrets`
// to `secrets` and DROPS a trailing slash, so `secrets/` excludes a file named `secrets` too.
// Treating that slash as directory-only, the way git does, under-excludes exactly the shape a
// user writes when they mean "keep this out".
function cleanDockerPattern(pat: string): string {
  const normalized = posix.normalize(pat)
  const cut = normalized.length > 1 ? normalized.replace(/\/+$/, '') : normalized
  return cut === '' ? '.' : cut
}

export function compileIgnore(files: IgnoreFile[], flavour: Flavour): Ignore {
  const rules: Rule[] = []
  for (const f of files) {
    // A UTF-8 BOM belongs to the FILE, not to its first pattern. Both parsers strip it, and
    // without that a BOM-prefixed `secrets.env` silently matches nothing.
    const text = f.text.charCodeAt(0) === 0xfeff ? f.text.slice(1) : f.text
    for (const raw of text.split('\n')) {
      // \r always goes: that is the line ending, never pattern text. What follows differs by
      // flavour, so the two are separate steps.
      const noEol = raw.replace(/\r+$/, '')
      let pat: string
      let negated = false
      let dirOnly = false

      if (flavour === 'docker') {
        // Comment test first, untrimmed, then trim: docker's order, not ours.
        if (noEol.startsWith('#')) continue
        pat = noEol.trim()
        if (!pat) continue
        negated = pat.startsWith('!')
        if (negated) pat = pat.slice(1).trim()
        if (!pat) continue
        pat = cleanDockerPattern(pat)
        if (pat === '.') continue
      } else {
        const line = stripTrailingSpaces(noEol)
        if (!line) continue
        pat = line
        // A leading `\#` or `\!` is git's way to name a file that really starts with one. It has
        // to short-circuit BOTH checks below: unescaping first and then testing would read
        // `\!secrets` as a negation of `secrets`, the exact inverse of what was asked for.
        if (pat.startsWith('\\#') || pat.startsWith('\\!')) {
          pat = pat.slice(1)
        } else {
          if (pat.startsWith('#')) continue
          negated = pat.startsWith('!')
          if (negated) pat = pat.slice(1)
        }
        // Only git gives a trailing slash meaning. Docker's Clean already removed it above.
        if (pat.endsWith('/')) {
          dirOnly = true
          pat = pat.slice(0, -1)
        }
        if (pat.startsWith('./')) pat = pat.slice(2)
      }

      // docker anchors every pattern to the root; git only when the pattern has a slash.
      let anchored = true
      if (pat.startsWith('/')) pat = pat.slice(1)
      else if (flavour === 'git') anchored = pat.includes('/')
      if (!pat) continue

      const body = anchored ? pat : `**/${pat}`
      const full = f.base ? `${f.base}/${body}` : body
      rules.push({ re: new RegExp('^' + translate(full) + '$'), negated, dirOnly, literal: literalHead(full) })
    }
  }

  // A rule matching an ancestor excludes the path too: excluding a dir excludes its contents.
  const hits = (r: Rule, path: string, isDir: boolean): boolean => {
    if (r.re.test(path) && (!r.dirOnly || isDir)) return true
    const parts = path.split('/')
    for (let i = 1; i < parts.length; i++) if (r.re.test(parts.slice(0, i).join('/'))) return true
    return false
  }

  const negations = rules.filter((r) => r.negated)

  return {
    excludes(relPath, isDir) {
      let excluded = false
      for (const r of rules) if (hits(r, relPath, isDir)) excluded = !r.negated // last match wins
      return excluded
    },
    // git can't re-include under an excluded dir; docker can, so prune only where no negation reaches.
    canPrune(dirPath) {
      if (flavour === 'git') return true
      return !negations.some((r) => r.literal === '' || r.literal.startsWith(dirPath + '/') || dirPath.startsWith(r.literal))
    },
  }
}
