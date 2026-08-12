// `insta storage` — browse, download, and delete the objects in a storage service's bucket.
import { writeFile } from 'node:fs/promises'
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
  const objects: Array<{ key: string; size?: number; lastModified?: string }> = res.body.objects ?? []
  if (!objects.length) {
    return info(opts.prefix ? `(no objects under prefix ${opts.prefix} in storage/${svc.name})` : `(storage/${svc.name} is empty)`)
  }
  for (const o of objects) info(objectListLine(o))
  if (res.body.nextCursor) info(`  (more — next page: insta storage list --cursor ${res.body.nextCursor})`)
}

export type GetDeps = { fetchBytes?: (url: string) => Promise<Uint8Array>; writeImpl?: (path: string, data: Uint8Array) => Promise<void> }

// pure: where the bytes land. Only the key's LAST segment is used, so no key can escape cwd.
export function outputPath(key: string, output?: string): string {
  if (output) return output
  const base = key.split('/').pop() ?? ''
  if (!base) throw new Error(`cannot infer a filename from key "${key}" — pass -o <file>`)
  return base
}

// Pull the bytes from the provider (never through the platform, which only signs the URL).
export async function fetchPresigned(url: string, fetchImpl: typeof fetch = fetch): Promise<Uint8Array> {
  const res = await fetchImpl(url)
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status} (a presigned URL lives ~60s — re-run to mint a fresh one)`)
  return new Uint8Array(await res.arrayBuffer())
}

// Core, dependency-injected for tests (mirrors runWithSecrets): fetch → write, return byte count.
export async function saveObject(url: string, out: string, deps: GetDeps = {}): Promise<number> {
  const bytes = await (deps.fetchBytes ?? fetchPresigned)(url)
  await (deps.writeImpl ?? writeFile)(out, bytes)
  return bytes.byteLength
}

type GetOpts = Common & { output?: string }

export async function storageGet(key: string, opts: GetOpts, deps: GetDeps = {}): Promise<void> {
  if (!key) throw new Error('key is required')
  const out = outputPath(key, opts.output)
  const api = await ApiClient.load()
  const p = await requireProject()
  const branch = opts.branch ?? p.branch
  const svc = await storageTarget(api, p.projectId, branch, opts.service)
  const res = await api.rawRequest('GET', objectDownloadPath(p.projectId, svc.id, { branch, key }))
  if (handleApproval(res)) return
  // --json hands over the presigned URL instead of downloading, as `insta secrets --json` does.
  if (opts.json) return printJson(res.body)
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
