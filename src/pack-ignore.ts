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
    } else {
      out += escapeLiteral(p.charAt(i))
      i += 1
    }
  }
  return out
}

// Wildcard-free head of a pattern; empty means it could match anywhere.
function literalHead(full: string): string {
  const m = /[*?[]/.exec(full)
  return m ? full.slice(0, m.index) : full
}

export function compileIgnore(files: IgnoreFile[], flavour: Flavour): Ignore {
  const rules: Rule[] = []
  for (const f of files) {
    for (const raw of f.text.split('\n')) {
      const line = raw.replace(/\s+$/, '')
      if (!line || line.startsWith('#')) continue

      let pat = line
      const negated = pat.startsWith('!')
      if (negated) pat = pat.slice(1)

      let dirOnly = false
      if (pat.endsWith('/')) {
        dirOnly = true
        pat = pat.slice(0, -1)
      }
      if (pat.startsWith('./')) pat = pat.slice(2)

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
