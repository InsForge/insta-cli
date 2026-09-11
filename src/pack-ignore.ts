import { posix } from 'node:path'
import ignore from 'ignore'

// Ignore matching for `insta deploy <dir>`. Two flavours, two implementations, on purpose.
//
// git is the `ignore` package: the gitignore(5) grammar as the eslint and prettier tooling already
// relies on it, with `**` crossing directories only at a segment boundary, bracket expressions
// including the POSIX named classes, escapes, negation and the trailing-space and comment rules.
// Three hand-written rounds of that grammar each shipped a file a valid rule had withheld, and the
// grammar is not ours to re-derive. Pinned to an exact version because its verdicts decide which
// files enter the archive, so they are part of the archive's identity exactly as the compressor is.
//
// docker is hand-written to moby/patternmatcher, which no package implements: filepath.Clean on
// every pattern, everything anchored to the context root, `**` crossing directories wherever it
// stands, Go regexp classes where `!` is an ordinary member, and re-inclusion under an excluded
// directory, which is why the walker may not prune there.

export type Flavour = 'git' | 'docker'

// base: the file's own directory, relative to the archive root ('' at the root).
export type IgnoreFile = { base: string; text: string }

export interface Ignore {
  excludes(relPath: string, isDir: boolean): boolean
  // May the walker skip descending into this excluded directory?
  canPrune(dirPath: string): boolean
}

export function compileIgnore(files: IgnoreFile[], flavour: Flavour): Ignore {
  return flavour === 'git' ? compileGit(files) : compileDocker(files)
}

// ---- git ----

const depth = (base: string): number => (base === '' ? 0 : base.split('/').length)

// One matcher per .gitignore, each asked only about the paths beneath its own directory and
// spelled relative to it, the way git reads them. Shallower files are consulted first, so a deeper
// file's last matching rule wins, which is gitignore's precedence, and a file with no matching
// rule leaves the verdict where the previous file put it.
//
// Case-sensitive on purpose. The package defaults to ignorecase, git itself follows
// core.ignorecase, which differs between a macOS laptop and the Linux box that extracts the
// archive. One tree has to pack to one identity everywhere, so the rule is the Linux one.
function compileGit(files: IgnoreFile[]): Ignore {
  const scoped = [...files]
    .sort((a, b) => depth(a.base) - depth(b.base))
    .map((f) => ({ base: f.base, ig: ignore({ ignorecase: false }).add(f.text) }))
  return {
    excludes(relPath, isDir) {
      let excluded = false
      for (const { base, ig } of scoped) {
        const sub = base === '' ? relPath : relPath.startsWith(base + '/') ? relPath.slice(base.length + 1) : ''
        if (sub === '') continue
        // A trailing slash is how the package is told the path is a directory, for `logs/` rules.
        const verdict = ig.test(isDir ? sub + '/' : sub)
        if (verdict.ignored) excluded = true
        else if (verdict.unignored) excluded = false
      }
      return excluded
    },
    // git cannot re-include under an excluded directory, so there is never a reason to descend.
    canPrune: () => true,
  }
}

// ---- docker ----

type Rule = { re: RegExp; negated: boolean; literal: string }

const escapeLiteral = (c: string): string => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// Glob to RegExp the way moby/patternmatcher compiles one: `*` and `?` stop at a separator, `**`
// crosses wherever it stands. `**foo` is a suffix match and `foo**` a prefix match on the literal
// there, so `.*` is what docker does, not an approximation of it.
function translate(p: string): string {
  let out = ''
  let i = 0
  while (i < p.length) {
    if (p.startsWith('**', i)) {
      const atBoundary = i === 0 || p.charAt(i - 1) === '/'
      if (atBoundary && p.charAt(i + 2) === '/') {
        out += '(?:.*/)?' // any number of directories, including none
        i += 3
      } else if (atBoundary && i + 2 === p.length) {
        // Bare `**` is everything. `abc/**` is everything INSIDE abc and NOT abc itself: making
        // the suffix optional matched the directory too, and a rule that reads as "drop this tree
        // but keep one file" then dropped the file with it.
        out += i === 0 ? '.*' : '.+'
        i += 2
      } else {
        out += '.*'
        i += 2
      }
    } else if (p.charAt(i) === '*') {
      out += '[^/]*'
      i += 1
    } else if (p.charAt(i) === '?') {
      out += '[^/]'
      i += 1
    } else if (p.charAt(i) === '[') {
      const cls = bracket(p, i)
      if (cls) {
        out += cls.re
        i = cls.end
      } else {
        out += '\\['
        i += 1
      }
    } else if (p.charAt(i) === '\\' && i + 1 < p.length) {
      // Escape: the next character is data, not a wildcard. Go's filepath.Match honours it.
      out += escapeLiteral(p.charAt(i + 1))
      i += 2
    } else {
      out += escapeLiteral(p.charAt(i))
      i += 1
    }
  }
  return out
}

// Inside a class only these carry regex meaning; `-` is left alone so a range stays a range.
const escapeInClass = (c: string): string => (/[\\\]\[^-]/.test(c) ? '\\' + c : c)

// A bracket expression starting at p[start], or null when no `]` closes it and the `[` is a
// literal. docker hands the class to Go's regexp: a `]` right after the opening `[` (or after
// the `^`) is a MEMBER, not the close, `\` quotes the next character, and only `^` negates, so a
// `!` is an ordinary member. A negated class never matches a separator, the rule `*` and `?`
// already follow.
function bracket(p: string, start: number): { re: string; end: number } | null {
  let j = start + 1
  let negated = false
  if (p.charAt(j) === '^') {
    negated = true
    j += 1
  }
  let body = ''
  let first = true
  while (j < p.length) {
    const c = p.charAt(j)
    if (c === ']' && !first) return { re: `[${negated ? '^/' : ''}${body}]`, end: j + 1 }
    first = false
    if (c === '\\' && j + 1 < p.length) {
      body += escapeInClass(p.charAt(j + 1))
      j += 2
      continue
    }
    body += c === '-' ? c : escapeInClass(c)
    j += 1
  }
  return null
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

function compileDocker(files: IgnoreFile[]): Ignore {
  const rules: Rule[] = []
  for (const f of files) {
    // A UTF-8 BOM belongs to the FILE, not to its first pattern: without stripping it a
    // BOM-prefixed `secrets.env` silently matches nothing.
    const text = f.text.charCodeAt(0) === 0xfeff ? f.text.slice(1) : f.text
    for (const raw of text.split('\n')) {
      const noEol = raw.replace(/\r+$/, '')
      // Comment test first, untrimmed, then trim: docker's order, not ours.
      if (noEol.startsWith('#')) continue
      let pat = noEol.trim()
      if (!pat) continue
      const negated = pat.startsWith('!')
      if (negated) pat = pat.slice(1).trim()
      if (!pat) continue
      pat = cleanDockerPattern(pat)
      if (pat === '.') continue
      // Every pattern is anchored to the context root, slash or not.
      if (pat.startsWith('/')) pat = pat.slice(1)
      if (!pat) continue

      // The base is a real DIRECTORY NAME, not pattern syntax, so it is escaped as a literal and
      // joined at the regex level, and prefixed to the prune head the same way, since that head
      // is compared against real path text.
      const prefix = f.base ? escapeLiteral(f.base) + '/' : ''
      const head = f.base ? `${f.base}/${literalHead(pat)}` : literalHead(pat)
      rules.push({ re: new RegExp('^' + prefix + translate(pat) + '$'), negated, literal: head })
    }
  }

  // A rule matching an ancestor excludes the path too: excluding a dir excludes its contents.
  const hits = (r: Rule, path: string): boolean => {
    if (r.re.test(path)) return true
    const parts = path.split('/')
    for (let i = 1; i < parts.length; i++) if (r.re.test(parts.slice(0, i).join('/'))) return true
    return false
  }

  const negations = rules.filter((r) => r.negated)

  return {
    excludes(relPath) {
      let excluded = false
      for (const r of rules) if (hits(r, relPath)) excluded = !r.negated // last match wins
      return excluded
    },
    // docker can re-include under an excluded directory, so prune only where no negation reaches.
    canPrune(dirPath) {
      return !negations.some((r) => r.literal === '' || r.literal.startsWith(dirPath + '/') || dirPath.startsWith(r.literal))
    },
  }
}
