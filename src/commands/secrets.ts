import { writeFile } from 'node:fs/promises'
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ApiClient, requireProject } from '../api.js'
import { info, printJson, serializeEnv, handleApproval, die } from '../util.js'

// One env name that several services each define. The bundle is a flat map, so it cannot carry
// three values for one name — the platform reports the ambiguity here instead of picking a winner
// (which it used to do implicitly: newest row wins, so a hand-set value read back as another
// service's). `services` are "<type>/<name>" strings.
export type Collision = { name: string; services: string[] }

/** The bundle read, exactly as the platform answers it. */
export type SecretBundle = { secrets: Record<string, string>; collisions: Collision[] }

// Just enough of ApiClient to read/write secrets — so the command cores are testable with a stub.
export type SecretsApi = { rawRequest: (m: string, p: string, body?: unknown) => Promise<{ status: number; body: any }> }
export type SecretsDeps = { api: SecretsApi; projectId: string; linkedBranch?: string }

async function loadDeps(): Promise<SecretsDeps> {
  const api = await ApiClient.load()
  const p = await requireProject()
  return { api, projectId: p.projectId, linkedBranch: p.branch }
}

/** A `--service` that arrived empty (`--service ""`, or an unset variable in a script) is a typo,
 *  not a request: the platform 400s it, and silently falling back to the branch-wide read would
 *  answer a different question than the one asked. Fail locally, naming the shape. */
export function assertServiceRef(service?: string): void {
  if (service !== undefined && service.trim() === '') die('--service requires <type>/<name>, e.g. compute/api')
}

/** Query for a bundle read. `--service` asks for the env ONE compute service actually receives
 *  (unambiguous by construction, so no collision can arise); a general read asks the platform to
 *  WITHHOLD any name several services define rather than silently returning one of the values. */
export function bundleQuery(opts: { branch?: string; service?: string }): string {
  const parts: string[] = []
  if (opts.branch) parts.push(`branch=${encodeURIComponent(opts.branch)}`)
  // A bare/empty --service is a 400 on the platform; the flag is only ever sent with a value.
  if (opts.service) parts.push(`service=${encodeURIComponent(opts.service)}`)
  else parts.push('on_collision=withhold')
  return `?${parts.join('&')}`
}

/** GET the bundle. Returns null when the platform gated the read (202). An older platform that
 *  doesn't know `collisions` reads back as none — the field is a report, not a requirement. */
export async function fetchSecretBundle(
  api: SecretsApi,
  projectId: string,
  opts: { branch?: string; service?: string; json?: boolean },
): Promise<SecretBundle | null> {
  const res = await api.rawRequest('GET', `/projects/${projectId}/secrets${bundleQuery(opts)}`)
  if (handleApproval(res, opts.json)) return null
  return { secrets: res.body.secrets as Record<string, string>, collisions: (res.body.collisions ?? []) as Collision[] }
}

/** Pure: the report for each withheld name — who defines it, and how to read one of them. */
export function collisionLines(collisions: Collision[]): string[] {
  return collisions.flatMap((c) => [
    `${c.name} omitted — ${c.services.length} services define it:`,
    `  ${c.services.join(', ')}`,
    `  read one with: insta secrets --service ${c.services[0] ?? '<type>/<name>'}`,
  ])
}

// STDERR, always: `secrets --print` writes the env to stdout and `insta run`'s stdout belongs to
// the child command, so a collision report on stdout would corrupt both.
export function warnCollisions(collisions: Collision[]): void {
  for (const line of collisionLines(collisions)) process.stderr.write(line + '\n')
}

// Fetch the credential bundle (the secret seam) and write it to .env (or print). --service reads
// one compute service's own env instead of the branch-wide merge.
export async function secrets(
  opts: { branch?: string; service?: string; output?: string; print?: boolean; json?: boolean },
  deps?: SecretsDeps,
): Promise<void> {
  assertServiceRef(opts.service)
  const d = deps ?? (await loadDeps())
  const branch = opts.branch ?? d.linkedBranch
  const b = await fetchSecretBundle(d.api, d.projectId, { branch, service: opts.service, json: opts.json })
  if (!b) return
  const bundle = b.secrets
  if (opts.json) return printJson({ secrets: bundle, collisions: b.collisions })
  warnCollisions(b.collisions)
  if (opts.print) { process.stdout.write(serializeEnv(bundle)); return }
  const out = opts.output ?? '.env'
  await writeFile(out, serializeEnv(bundle))
  const scope = opts.service ? `${opts.service}, branch ${branch}` : `branch ${branch}`
  info(`wrote ${Object.keys(bundle).length} secrets to ${out} (${scope})`)
  if (ensureIgnored(process.cwd(), out)) info(`  .gitignore += ${out} (credentials must never be committed)`)
  info('  tip: `insta run -- <cmd>` injects these per-run with nothing written to disk')
}

// Shape of GET /secrets/tree: the whole binding picture — project-wide secrets, then per-branch
// service groupings plus any branch-level (unbound) secrets.
type Tree = {
  projectWide: string[]
  branches: { name: string; isDefault: boolean; services: { type: string; name: string; secrets: string[] }[]; unbound: string[] }[]
}

// Render one branch's service-grouped secrets, then its unbound (branch-level) secrets.
function renderBranch(b: Tree['branches'][number]): void {
  for (const s of b.services) if (s.secrets.length) { info(`  ${s.type}/${s.name}`); for (const n of s.secrets) info(`    ${n}`) }
  if (b.unbound.length) { info('  (branch-level)'); for (const n of b.unbound) info(`    ${n}`) }
}

// Show the full binding tree: project-wide, then every branch grouped by service.
export async function secretsTree(opts: { json?: boolean }): Promise<void> {
  const api = await ApiClient.load()
  const p = await requireProject()
  const res = await api.rawRequest('GET', `/projects/${p.projectId}/secrets/tree`)
  if (handleApproval(res, opts.json)) return
  const tree: Tree = res.body
  if (opts.json) return printJson(tree)
  if (tree.projectWide.length) { info('(project-wide)'); for (const n of tree.projectWide) info(`  ${n}`) }
  for (const b of tree.branches) { info(`${b.name}${b.isDefault ? ' *' : ''}`); renderBranch(b) }
}

// List secret names for the current (or given) branch, grouped by service.
export async function secretsList(opts: { branch?: string; json?: boolean }): Promise<void> {
  const api = await ApiClient.load()
  const p = await requireProject()
  const branch = opts.branch ?? p.branch
  const res = await api.rawRequest('GET', `/projects/${p.projectId}/secrets/tree`)
  if (handleApproval(res, opts.json)) return
  const tree: Tree = res.body
  const b = tree.branches.find((x) => x.name === branch)
  if (opts.json) return printJson({ projectWide: tree.projectWide, branch: b })
  if (tree.projectWide.length) { info('(project-wide)'); for (const n of tree.projectWide) info(`  ${n}`) }
  if (b) { info(`${b.name}`); renderBranch(b) }
}

async function readStdin(): Promise<string> {
  let data = ''
  for await (const chunk of process.stdin) data += chunk
  return data.trim()
}

// Set a user secret. Project-wide by default; --branch scopes it to one branch. --service binds
// it to a branch service instead, which implies the current branch (binding requires one). Value
// comes from the argument, or stdin when omitted (keeps secret values out of shell history).
export async function secretsSet(name: string, value: string | undefined, opts: { branch?: string; service?: string; json?: boolean }): Promise<void> {
  const api = await ApiClient.load()
  const p = await requireProject()
  const v = value ?? (await readStdin())
  if (!v) die('value is required (pass as an argument or on stdin)')
  const branch = opts.service ? (opts.branch ?? p.branch) : opts.branch
  const payload: Record<string, string> = { value: v, ...(branch ? { branch } : {}), ...(opts.service ? { service: opts.service } : {}) }
  const res = await api.rawRequest('PUT', `/projects/${p.projectId}/secrets/${encodeURIComponent(name)}`, payload)
  if (handleApproval(res, opts.json)) return
  if (opts.json) return printJson({ ok: true, name, branch: branch ?? null, service: opts.service ?? null })
  info(`set ${name}${opts.service ? ` → ${opts.service}` : ''} (${branch ? `branch ${branch}` : 'project-wide'})`)
}

// Remove a user secret. --service removes only THAT service's copy (the platform has always
// honoured ?service= here; without the flag a name several services define stays defined).
export async function secretsUnset(
  name: string,
  opts: { branch?: string; service?: string; json?: boolean },
  deps?: SecretsDeps,
): Promise<void> {
  assertServiceRef(opts.service)
  const d = deps ?? (await loadDeps())
  const parts: string[] = []
  if (opts.branch) parts.push(`branch=${encodeURIComponent(opts.branch)}`)
  if (opts.service) parts.push(`service=${encodeURIComponent(opts.service)}`)
  const qs = parts.length ? `?${parts.join('&')}` : ''
  const res = await d.api.rawRequest('DELETE', `/projects/${d.projectId}/secrets/${encodeURIComponent(name)}${qs}`)
  if (handleApproval(res, opts.json)) return
  if (opts.json) return printJson({ ok: true, name, branch: opts.branch ?? null, service: opts.service ?? null })
  const scope = opts.service ? `${opts.service}${opts.branch ? `, branch ${opts.branch}` : ''}` : opts.branch ? `branch ${opts.branch}` : 'project-wide'
  info(`unset ${name} (${scope})`)
}

export async function secretsBind(envName: string, source: string, opts: { branch?: string; to?: string; sourceName?: string; json?: boolean }): Promise<void> {
  if (!opts.to) die('--to <compute/name> is required')
  const api = await ApiClient.load()
  const p = await requireProject()
  const branch = opts.branch ?? p.branch
  const res = await api.rawRequest('PUT', `/projects/${p.projectId}/secret-bindings/${encodeURIComponent(envName)}`, {
    branch,
    target: opts.to,
    source,
    ...(opts.sourceName ? { sourceName: opts.sourceName } : {}),
  })
  if (handleApproval(res, opts.json)) return
  if (opts.json) return printJson({ ok: true })
  info(`bound ${envName} on ${opts.to} to ${source}${opts.sourceName ? `.${opts.sourceName}` : ''} (branch ${branch})`)
}

export async function secretsUnbind(envName: string, opts: { branch?: string; from?: string; json?: boolean }): Promise<void> {
  if (!opts.from) die('--from <compute/name> is required')
  const api = await ApiClient.load()
  const p = await requireProject()
  const branch = opts.branch ?? p.branch
  const res = await api.rawRequest('DELETE', `/projects/${p.projectId}/secret-bindings/${encodeURIComponent(envName)}?branch=${encodeURIComponent(branch)}&target=${encodeURIComponent(opts.from)}`)
  if (handleApproval(res, opts.json)) return
  if (opts.json) return printJson({ ok: true })
  info(`unbound ${envName} from ${opts.from} (branch ${branch})`)
}

export async function secretsBindings(opts: { branch?: string; target?: string; json?: boolean }): Promise<void> {
  if (!opts.target) die('--target <compute/name> is required')
  const api = await ApiClient.load()
  const p = await requireProject()
  const branch = opts.branch ?? p.branch
  const res = await api.rawRequest('GET', `/projects/${p.projectId}/secret-bindings?branch=${encodeURIComponent(branch)}&target=${encodeURIComponent(opts.target)}`)
  if (handleApproval(res, opts.json)) return
  const bindings = res.body.bindings ?? []
  if (opts.json) return printJson(bindings)
  if (!bindings.length) return info(`(no secret bindings for ${opts.target} on ${branch})`)
  for (const b of bindings) info(`${b.envName} <- ${b.source.type}/${b.source.name}.${b.sourceName}`)
}

export async function secretsSources(opts: { branch?: string; json?: boolean }): Promise<void> {
  const api = await ApiClient.load()
  const p = await requireProject()
  const branch = opts.branch ?? p.branch
  const res = await api.rawRequest('GET', `/projects/${p.projectId}/secret-sources?branch=${encodeURIComponent(branch)}`)
  if (handleApproval(res, opts.json)) return
  const sources = res.body.sources ?? []
  if (opts.json) return printJson(sources)
  if (!sources.length) return info(`(no credential sources on ${branch})`)
  for (const s of sources) info(`${s.service.type}/${s.service.name}: ${s.secrets.join(', ')}`)
}

/** Gitignore the env file we just wrote (git repos only; idempotent). Returns true if added. */
export function ensureIgnored(cwd: string, name: string): boolean {
  if (!existsSync(join(cwd, '.git'))) return false
  const gi = join(cwd, '.gitignore')
  const current = existsSync(gi) ? readFileSync(gi, 'utf8') : ''
  if (current.split('\n').some((l) => l.trim() === name)) return false
  appendFileSync(gi, (current.endsWith('\n') || current === '' ? '' : '\n') + name + '\n')
  return true
}
