// Shared `.gitignore` maintenance for files the CLI writes into a project that are not the
// developer's source (installed skills, observe-hook state). The rule: whatever writes a
// regenerable or machine-local file adds its ignore entry in the same step, so `git status` never
// surfaces it as a surprise — the same convention as `insta secrets` for .env.
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
