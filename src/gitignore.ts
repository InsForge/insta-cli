// Shared `.gitignore` maintenance for files the CLI writes into a project that are not the
// developer's source (installed skills, observe-hook state). The rule: whatever writes a
// regenerable or machine-local file adds its ignore entry in the same step, so `git status` never
// surfaces it as a surprise — the same convention as `insta secrets` for .env.
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// Append any missing entries to the project's ./.gitignore (creating it if absent). Idempotent:
// entries already present (exact line match) are left alone; a block gets one `comment` header
// the first time it contributes. Returns the entries it added.
export function ensureGitignore(cwd: string, entries: string[], comment?: string): string[] {
  const p = join(cwd, '.gitignore')
  const existing = existsSync(p) ? readFileSync(p, 'utf8') : ''
  const have = new Set(existing.split('\n').map((l) => l.trim()))
  const missing = entries.filter((e) => !have.has(e))
  if (missing.length === 0) return []
  const prefix = existing && !existing.endsWith('\n') ? '\n' : ''
  const header = comment && !have.has(comment) ? `${comment}\n` : ''
  writeFileSync(p, existing + `${prefix}\n${header}${missing.join('\n')}\n`)
  return missing
}

// An ignore entry does nothing for a path git already tracks — and the repos that most need these
// entries are the ones where the files were committed before the CLI ignored them. Returns the
// entries (as given) that have tracked files under them, so the caller can print the one hint
// that fixes it (`git rm -r --cached …`). Empty when git is absent or cwd is not a repo.
export function alreadyTracked(cwd: string, entries: string[]): string[] {
  if (entries.length === 0) return []
  try {
    const r = spawnSync('git', ['ls-files', '-z', '--', ...entries], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    if (r.status !== 0 || !r.stdout) return []
    const tracked = r.stdout.split('\0').filter(Boolean)
    return entries.filter((e) => tracked.some((t) => t === e || t.startsWith(e.endsWith('/') ? e : `${e}/`)))
  } catch {
    return []
  }
}

/** The one-line hint for `alreadyTracked` hits, or null when there are none. */
export function untrackHint(tracked: string[]): string | null {
  return tracked.length ? `  already tracked by git — to stop committing: git rm -r --cached ${tracked.join(' ')}` : null
}
