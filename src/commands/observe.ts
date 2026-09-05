// `insta observe` — the local credential-audit hook. install wires a PostToolUse hook into the
// agent harness; report renders the local audit; sync uploads findings into the project timeline
// (idempotent via a stable dedup key, matching the platform's audit-event ingest).
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { installObserve, uninstallObserve } from '../observe/install.js'
import { untrackHint } from '../gitignore.js'
import { findProjectRoot } from '../config.js'
import { renderReport } from '../observe/report.js'
import { ApiClient, requireProject } from '../api.js'
import { info, printJson } from '../util.js'

// Where the audit lives: the hook records at the directory it is materialized in
// (<root>/.insta/observe/hook.js — see projectRootFor), so report/sync must anchor on the same
// thing. The link file is the usual root, but a standalone `insta observe install` in an
// unlinked directory has no project.json — climb for the hook itself then, so both halves agree
// from any subdirectory. Falls back to cwd when neither exists (→ "audit log is empty").
export async function auditRoot(cwd = process.cwd()): Promise<string> {
  const linked = await findProjectRoot(cwd)
  if (linked) return linked
  let dir = resolve(cwd)
  for (;;) {
    if (existsSync(join(dir, '.insta', 'observe', 'hook.js'))) return dir
    const parent = dirname(dir)
    if (parent === dir) return cwd
    dir = parent
  }
}

async function readAudit(): Promise<Array<Record<string, unknown>>> {
  try {
    const txt = await readFile(join(await auditRoot(), '.insta', 'audit.jsonl'), 'utf8')
    return txt.split('\n').filter(Boolean).map((l) => JSON.parse(l))
  } catch {
    return []
  }
}

function dedupKey(r: Record<string, any>): string {
  return `${r.ts}|${r.fingerprint}|${r.surface}|${r.sink}|${r.kind}`
}

function* chunk<T>(a: T[], n: number): Generator<T[]> {
  for (let i = 0; i < a.length; i += n) yield a.slice(i, i + n)
}

export async function observeInstall(): Promise<void> {
  const res = installObserve({ cwd: process.cwd() })
  info(`installed observe hook (claude: ${res.claude}, codex: ${res.codex}) → ./.insta/observe`)
  if (res.ignored.length) info(`  .gitignore += ${res.ignored.join(', ')}`)
  const hint = untrackHint(res.tracked)
  if (hint) info(hint)
  info('it scans agent tool-use for credential exposure; findings append to ./.insta/audit.jsonl')
  info('run `insta observe report` to review, `insta observe sync` to upload to the project timeline')
}

export async function observeUninstall(): Promise<void> {
  uninstallObserve(process.cwd())
  info('uninstalled observe hook')
}

export async function observeReport(opts: { json?: boolean }): Promise<void> {
  const rows = await readAudit()
  if (opts.json) return printJson(rows)
  info(renderReport(rows))
}

export async function observeSync(): Promise<void> {
  const api = await ApiClient.load()
  const p = await requireProject()
  const rows = await readAudit()
  if (!rows.length) return info('nothing to sync (./.insta/audit.jsonl is empty)')
  const events = rows.map((r) => ({ source: 'agent', kind: `cred.${r.kind ?? 'touch'}`, branchId: null, dedupKey: dedupKey(r), payload: r }))
  let recorded = 0
  let skipped = 0
  for (const c of chunk(events, 200)) {
    const out = await api.request('POST', `/projects/${p.projectId}/events`, { events: c })
    recorded += out.recorded
    skipped += out.skipped
  }
  info(`synced ${rows.length} finding(s) → recorded ${recorded}, skipped ${skipped} (already uploaded)`)
}
