// `insta storage` — browse, download, and delete the objects in a storage service's bucket.
import { rename, rm } from 'node:fs/promises'
import { createWriteStream } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { ApiClient, requireProject } from '../api.js'
import { info, printJson, handleApproval } from '../util.js'
import { q, resolveSoleService } from './services.js'
import { fmtBytes } from './db.js' // the repo's tested bytes formatter — don't grow a third copy

type Common = { branch?: string; service?: string; json?: boolean }

function qs(params: Record<string, string | undefined>): string {
  const u = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') u.set(k, String(v))
  const s = u.toString()
  return s ? `?${s}` : ''
}

// Page size the listing route accepts. Junk must fail here, not travel as `limit=NaN`.
export function parseObjectLimit(raw: string): number {
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 1 || n > 1000) throw new Error(`--limit must be an integer 1..1000, got: ${raw}`)
  return n
}

type ObjectParams = { branch?: string; prefix?: string; cursor?: string; limit?: number; key?: string }

// pure: platform path for the objects collection — GET lists it, DELETE removes one `key`.
export function objectsPath(projectId: string, serviceId: string, params: ObjectParams): string {
  const { limit, ...rest } = params
  return `/projects/${projectId}/services/${serviceId}/objects${qs({ ...rest, limit: limit === undefined ? undefined : String(limit) })}`
}

// pure: the presign route — a static subpath, so keys containing `/` stay in the query.
export function objectDownloadPath(projectId: string, serviceId: string, params: { branch?: string; key: string }): string {
  return `/projects/${projectId}/services/${serviceId}/objects/download${qs(params)}`
}

// pure: one `storage list` row, size-first so the columns line up over variable-length keys.
export function objectListLine(o: { key: string; size?: number; lastModified?: string }): string {
  const size = typeof o.size === 'number' ? fmtBytes(o.size) : '—'
  return `${size.padStart(10)}  ${(o.lastModified ?? '—').padEnd(24)}  ${o.key}`
}

// Resolve the branch's storage service (named, or the sole one) — its bucket is what we browse.
async function storageTarget(api: ApiClient, projectId: string, branch: string | undefined, name?: string): Promise<{ id: string; name: string }> {
  const { services } = await api.request('GET', `/projects/${projectId}/services${q(branch)}`)
  return resolveSoleService(services as Array<{ id: string; type: string; name: string }>, 'storage', name)
}

type ListOpts = Common & { prefix?: string; cursor?: string; limit?: string }

// S3 filters by prefix only — there is no substring search, so `--prefix` is the query surface.
export async function storageList(opts: ListOpts): Promise<void> {
  const limit = opts.limit === undefined ? undefined : parseObjectLimit(opts.limit)
  const api = await ApiClient.load()
  const p = await requireProject()
  const branch = opts.branch ?? p.branch
  const svc = await storageTarget(api, p.projectId, branch, opts.service)
  const res = await api.rawRequest('GET', objectsPath(p.projectId, svc.id, { branch, prefix: opts.prefix, cursor: opts.cursor, limit }))
  if (handleApproval(res)) return
  if (opts.json) return printJson(res.body)
  const objects: Array<{ key: string; size?: number; lastModified?: string }> = res.body?.objects ?? []
  if (!objects.length) {
    return info(opts.prefix ? `(no objects under prefix ${opts.prefix} in storage/${svc.name})` : `(storage/${svc.name} is empty)`)
  }
  for (const o of objects) info(objectListLine(o))
  const next = res.body?.nextCursor
  if (next) info(`  (more — next page: ${nextPageCommand({ ...opts, limit }, next)})`)
}

// Single-quote anything a shell would reinterpret; a prefix or cursor may hold spaces, & or $.
function shellQuote(value: string): string {
  return /^[\w./:@=+-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`
}

// The continuation command must repeat the filters, or following it lists a different set.
export function nextPageCommand(opts: { branch?: string; service?: string; prefix?: string; limit?: number }, cursor: string): string {
  const flags = [
    opts.service ? `--service ${shellQuote(opts.service)}` : '',
    opts.branch ? `--branch ${shellQuote(opts.branch)}` : '',
    opts.prefix ? `--prefix ${shellQuote(opts.prefix)}` : '',
    opts.limit === undefined ? '' : `--limit ${opts.limit}`,
    `--cursor ${shellQuote(cursor)}`,
  ].filter(Boolean)
  return `insta storage list ${flags.join(' ')}`
}

export type GetDeps = { streamTo?: (url: string, out: string) => Promise<number> }

// pure: where the bytes land. Only the last segment is used, so no key can escape cwd.
export function outputPath(key: string, output?: string): string {
  if (output) return output
  // Split on `\` too: a key may contain one, and on Windows that is also a separator.
  const base = key.split(/[\\/]/).pop() ?? ''
  if (!base) throw new Error(`cannot infer a filename from key "${key}" — pass -o <file>`)
  return base
}

// Stream from the provider (never through the platform, which only signs) straight to disk, so a
// multi-gigabyte object never has to fit in memory. Returns the byte count written.
export async function streamPresignedTo(url: string, out: string, fetchImpl: typeof fetch = fetch): Promise<number> {
  const res = await fetchImpl(url)
  if (!res.ok || !res.body) throw new Error(`download failed: HTTP ${res.status} (a presigned URL lives ~60s — re-run to mint a fresh one)`)
  let written = 0
  const counting = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) { written += chunk.byteLength; controller.enqueue(chunk) },
  })
  // Write beside the target, then rename: opening `out` directly would truncate an existing file
  // that a failed download then deletes. Same directory keeps the rename atomic.
  const part = `${out}.insta-part-${randomBytes(4).toString('hex')}`
  try {
    await pipeline(Readable.fromWeb(res.body.pipeThrough(counting) as ReadableStream<Uint8Array>), createWriteStream(part))
    await rename(part, out)
  } catch (e) {
    await rm(part, { force: true })
    throw e
  }
  return written
}

// Core, dependency-injected for tests (mirrors runWithSecrets): stream → disk, return byte count.
export async function saveObject(url: string, out: string, deps: GetDeps = {}): Promise<number> {
  return (deps.streamTo ?? streamPresignedTo)(url, out)
}

type GetOpts = Common & { output?: string }

export async function storageGet(key: string, opts: GetOpts, deps: GetDeps = {}): Promise<void> {
  if (!key) throw new Error('key is required')
  const api = await ApiClient.load()
  const p = await requireProject()
  const branch = opts.branch ?? p.branch
  const svc = await storageTarget(api, p.projectId, branch, opts.service)
  const res = await api.rawRequest('GET', objectDownloadPath(p.projectId, svc.id, { branch, key }))
  if (handleApproval(res)) return
  // --json hands over the presigned URL instead of downloading, as `insta secrets --json` does.
  // Before outputPath, so a key with no filename still works when nothing is written to disk.
  if (opts.json) return printJson(res.body)
  const out = outputPath(key, opts.output)
  if (!res.body?.url) throw new Error('the platform returned no download URL')
  const bytes = await saveObject(res.body.url, out, deps)
  info(`wrote ${fmtBytes(bytes)} to ${out} (${key} from storage/${svc.name}, branch ${branch})`)
}

// No prompt, matching every other destructive command here — the governance gate is the guard.
export async function storageDelete(key: string, opts: Common): Promise<void> {
  if (!key) throw new Error('key is required')
  const api = await ApiClient.load()
  const p = await requireProject()
  const branch = opts.branch ?? p.branch
  const svc = await storageTarget(api, p.projectId, branch, opts.service)
  const res = await api.rawRequest('DELETE', objectsPath(p.projectId, svc.id, { branch, key }))
  if (handleApproval(res)) return
  if (opts.json) return printJson(res.body)
  info(`deleted ${key} from storage/${svc.name} (branch ${branch})`)
}
