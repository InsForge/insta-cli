import { ApiClient, ApiError, requireProject } from '../api.js'
import { info, printJson, handleApproval } from '../util.js'
import { resolveComputeServiceId, q, parseVolumeGib } from './services.js'

type Opts = { branch?: string; group?: string; json?: boolean }

// ---- custom domains (bring your own hostname) ----
//
// A compute service's region is fixed at creation (`insta services add compute --region`), and a
// custom hostname routes in the router of the region that OWNS the service. So the region is
// DETECTED from the service, never chosen for the domain — the customer's DNS is one region-agnostic
// CNAME target either way — and every line below names it so the user knows where traffic lands.

// The `services list` row fields these commands read. `port === 0` is a worker: no HTTP endpoint,
// so no hostname can ever serve from it.
export type ComputeRow = { id: string; type: string; name: string; status?: string; region?: string | null; domain?: string | null; port?: number | null }

export const isWorker = (s: ComputeRow): boolean => s.port === 0

// One line per compute service for the disambiguation error: name, region, default URL, status —
// enough to pick one without a second command. Pure, exported for tests.
export function computeChoiceLine(s: ComputeRow, w = { name: 8, region: 12 }): string {
  const target = isWorker(s)
    ? '(no HTTP endpoint — worker, cannot serve a domain)'
    : `${s.domain ? `https://${s.domain}` : '(no default URL yet)'}${s.status ? `  (${s.status})` : ''}`
  return `  ${s.name.padEnd(w.name)} ${(s.region ?? '-').padEnd(w.region)} ${target}`
}

// Which compute service a hostname binds to. Exactly one compute service → it, no flag needed.
// Several → never guess (a wrong pick routes the customer's hostname to the wrong app in the wrong
// region): refuse with the list and require --group. With --group: must exist and must not be a
// worker. Pure, exported for tests.
export function resolveDomainTarget(services: ComputeRow[], host: string, group?: string): ComputeRow {
  const compute = services.filter((s) => s.type === 'compute')
  if (group) {
    const svc = compute.find((s) => s.name === group)
    if (!svc) throw new Error(`compute service not found: ${group}${compute.length ? ` (have: ${compute.map((s) => s.name).join(', ')})` : ''}`)
    if (isWorker(svc)) throw new Error(`${svc.name} is a worker (port 0) — it has no HTTP endpoint, so ${host} cannot serve from it`)
    return svc
  }
  if (compute.length === 0) throw new Error('no compute service in this project (add one with `insta services add compute <name>`)')
  if (compute.length === 1) {
    const only = compute[0]!
    if (isWorker(only)) throw new Error(`${only.name} is a worker (port 0) — it has no HTTP endpoint, so ${host} cannot serve from it`)
    return only
  }
  const w = { name: Math.max(4, ...compute.map((s) => s.name.length)), region: Math.max(6, ...compute.map((s) => (s.region ?? '-').length)) }
  throw new Error([
    `this project has ${compute.length} compute services; pass --group to choose which one serves ${host}:`,
    ...compute.map((s) => computeChoiceLine(s, w)),
  ].join('\n'))
}

// The platform's /compute/domain answer. `service`/`region` are the platform's own row; `ssl`,
// `dns[].status` and the origin trio are the compute plane's report and are ABSENT when its daemon
// does not report them (older builds) — the renderers say so rather than inventing a value.
export type DomainView = {
  hostname: string; flyApp: string; configured: boolean; status: string
  dns: Array<{ type: string; name: string; value: string; note?: string; status?: string }>
  service?: string | null; region?: string | null
  ssl?: string; errorReason?: string
  origin?: string; edgeOrigin?: string; originOk?: boolean
}

const targetOf = (r: DomainView) => `${r.service ?? r.flyApp}${r.region ? ` (${r.region})` : ''}`
const pad = (s: string, n: number) => s.padEnd(n)
// An older platform may omit `dns` entirely; every reader treats that as "no records", not a crash.
const recordsOf = (r: DomainView) => r.dns ?? []

// How a printed follow-up command must be spelled so it reaches the SAME service on the SAME
// branch the user just acted on. Without these, a suggested command run in a multi-service project
// dies on the very ambiguity error this feature exists to raise, and a --branch invocation would
// silently check the linked branch instead (cubic P2 ×2).
export type DomainCmdCtx = { group?: string; branch?: string }
const flags = (c: DomainCmdCtx = {}) =>
  `${c.group ? ` --group ${c.group}` : ''}${c.branch ? ` --branch ${c.branch}` : ''}`

// After set-domain: exactly what to do next, from the records the platform returned — never a
// hand-built template. No records = say so; a template here would send the customer publishing
// values the plane never issued. Pure, exported for tests.
export function domainGuidanceLines(r: DomainView, ctx: DomainCmdCtx = {}): string[] {
  const records = recordsOf(r)
  const out = [`${r.hostname} -> ${targetOf(r)}`]
  if (!records.length) {
    out.push('  the platform returned NO DNS records for this domain — the compute plane has no custom-domain CNAME target configured (or is misconfigured)')
    out.push('  nothing to publish yet: ask an operator before adding any DNS record')
    return out
  }
  const nameW = Math.max(...records.map((d) => d.name.length))
  out.push('add these DNS records at your DNS provider:')
  for (const d of records) out.push(`  ${pad(d.type, 6)} ${pad(d.name, nameW)} -> ${d.value}`)
  out.push(`then: insta compute check-domain ${r.hostname}${flags(ctx)}`)
  return out
}

// Whether this provider reports an edge routing target AT ALL. The compute plane's domain view
// always carries an `ssl` status, so a plane answer without `origin` is a daemon too old to report
// where the hostname resolves — we cannot confirm routing, and must not call it serving. A Fly
// answer carries no `ssl` and has no per-hostname origin concept, so its own verdict stands
// (r2d2 round 1 Critical: "no target reported" was previously treated as ready for both).
const reportsOrigin = (r: DomainView) => r.ssl !== undefined

// Where the hostname actually resolves — the region-specific origin the plane requested vs what
// Cloudflare holds. Each shape carries its action; absent fields are reported as absent.
export function domainResolveLine(r: DomainView): { line: string; ready: boolean } {
  const region = r.region ?? 'this region'
  if (r.origin === undefined) {
    if (reportsOrigin(r)) {
      return {
        line: `  ${pad('resolves to', 12)}UNCONFIRMED — ${region}'s daemon does not report the edge routing target, so where ${r.hostname} lands cannot be verified from here (update the region's daemon)`,
        ready: false,
      }
    }
    return { line: `  ${pad('resolves to', 12)}(this provider does not report an edge routing target)`, ready: true }
  }
  if (r.origin === '') {
    return {
      line: `  ${pad('resolves to', 12)}NOT READY — ${region} has no edge origin configured; ${r.hostname} would fall to the zone default. Ask an operator to set cf-custom-origin for ${region}`,
      ready: false,
    }
  }
  if (r.edgeOrigin && r.edgeOrigin !== r.origin) {
    return {
      line: `  ${pad('resolves to', 12)}${r.edgeOrigin} — Cloudflare routes ${r.hostname} to ${r.edgeOrigin}, but this service is in ${region} (${r.origin}); it is attached elsewhere — remove it there first`,
      ready: false,
    }
  }
  if (r.originOk === false) {
    return { line: `  ${pad('resolves to', 12)}${r.origin}   (${region} router)   pending — Cloudflare does not hold this hostname yet`, ready: false }
  }
  return { line: `  ${pad('resolves to', 12)}${r.origin}   (${region} router)   ok`, ready: true }
}

// check-domain: every stage, what each still needs, and where it routes. Pure, exported for tests.
export function domainStatusLines(r: DomainView, ctx: DomainCmdCtx = {}): string[] {
  if (r.status === 'not added') {
    return [`${r.hostname} is not attached to ${targetOf(r)} — attach it with: insta compute set-domain ${r.hostname}${flags(ctx)}`]
  }
  const records = recordsOf(r)
  const out = [`${r.hostname} -> ${targetOf(r)}`]
  const txt = records.find((d) => d.type === 'TXT')
  // The ROUTING records for the hostname, whatever type they take: a CNAME for a subdomain, or the
  // A/AAAA PAIR an apex needs (Fly's apex path emits both). All of them, not the first one —
  // a correct A beside a missing AAAA is not "routing is fine".
  const isRouting = (d: DomainView['dns'][number]) => d.type !== 'TXT' && d.name === r.hostname
  const routing = records.filter(isRouting)
  const blockers: string[] = []
  const stage = (label: string, state: string, detail: string) => out.push(`  ${pad(label, 12)}${pad(state, 10)}${detail ? `  ${detail}` : ''}`)

  // The ONE verdict rule, applied to EVERY record the platform returned regardless of its role.
  // A record is settled only when the platform says `ok` — or, for a provider that reports no
  // per-record status at all (Fly), when it vouched for the whole set with `configured`. missing,
  // mismatch and never-checked are each outstanding and each add a blocker. Applying this to only
  // the ownership TXT and the FIRST routing record was the bug (r2d2 round 3): every other record
  // rendered from `configured` alone and blocked nothing, so an apex whose AAAA was missing, or a
  // still-pending validation record, could ride under a `serving https://…` line.
  const verdictOf = (d: DomainView['dns'][number]) => d.status ?? (r.configured ? 'ok' : 'unchecked')

  if (txt) {
    const st = verdictOf(txt)
    if (st === 'ok') stage('ownership', 'verified', '(TXT found)')
    else if (st === 'mismatch') { stage('ownership', 'mismatch', `TXT ${txt.name} has a different value — set it to ${txt.value}`); blockers.push('fix the ownership TXT') }
    else if (st === 'missing') { stage('ownership', 'pending', `add TXT ${txt.name} -> ${txt.value}`); blockers.push('add the ownership TXT') }
    else { stage('ownership', 'unchecked', `TXT ${txt.name} -> ${txt.value} (the plane has not checked it yet — re-run check-domain)`); blockers.push('ownership unchecked') }
  } else if (reportsOrigin(r)) {
    // The stage is drawn even with no record to draw it from: an omitted stage reads as "not
    // required", when in fact the platform told us nothing to publish (cubic P2). Only the plane
    // proves ownership by TXT, so only a plane answer missing one is a problem.
    stage('ownership', 'unknown', 'the platform returned no ownership TXT for this domain — nothing to publish yet; ask an operator')
    blockers.push('no ownership TXT from the platform')
  } else {
    stage('ownership', 'n/a', '(this provider does not use an ownership TXT)')
  }

  if (routing.length === 0) {
    // No routing record for the hostname — whatever ELSE came back. Keying this on an entirely
    // empty record set was the bug (r2d2 round 2): a payload carrying only the ownership TXT
    // skipped the stage and added no blocker, so a `configured: true` answer with a live cert and
    // a confirmed origin printed `serving` for a hostname with nothing pointing at us.
    stage('cname', 'unknown', 'the platform returned no routing record for this domain — nothing to publish yet; ask an operator')
    blockers.push('no routing record from the platform')
  }
  for (const d of routing) {
    const st = verdictOf(d)
    // The stage is named for the record the platform actually issued, so an apex's A record is not
    // described to the user as a CNAME they cannot create.
    const lbl = d.type.toLowerCase()
    if (st === 'ok') stage(lbl, 'ok', `(points at ${d.value})`)
    else if (st === 'mismatch') { stage(lbl, 'mismatch', `${d.type} ${d.name} must point at ${d.value}`); blockers.push(`fix the ${d.type}`) }
    else if (st === 'missing') { stage(lbl, 'pending', `add ${d.type} ${d.name} -> ${d.value}`); blockers.push(`add the ${d.type}`) }
    else { stage(lbl, 'unchecked', `${d.type} ${d.name} -> ${d.value} (not checked yet — re-run check-domain)`); blockers.push(`${d.type} unchecked`) }
  }

  // Everything else the platform returned — a Let's Encrypt validation CNAME, any extra record.
  // Same rule, no exemption: an outstanding record is outstanding whatever its role.
  for (const d of records) {
    if (d === txt || isRouting(d)) continue
    const st = verdictOf(d)
    const lbl = d.type.toLowerCase()
    const where = `${d.name} -> ${d.value}${d.note ? `  (${d.note})` : ''}`
    if (st === 'ok') stage(lbl, 'ok', where)
    else if (st === 'mismatch') { stage(lbl, 'mismatch', `${d.type} ${d.name} must point at ${d.value}`); blockers.push(`fix the ${d.type} ${d.name}`) }
    else if (st === 'missing') { stage(lbl, 'pending', `add ${where}`); blockers.push(`add the ${d.type} ${d.name}`) }
    else { stage(lbl, 'unchecked', `${where} (not checked yet — re-run check-domain)`); blockers.push(`${d.type} ${d.name} unchecked`) }
  }

  const ssl = r.ssl ?? (r.configured ? 'active' : undefined)
  if (ssl === 'active') stage('certificate', 'active', '(edge TLS issued)')
  else if (ssl === 'external') stage('certificate', 'external', '(this plane manages no edge certificate for custom domains)')
  else if (ssl === undefined) { stage('certificate', 'pending', `(provider status: ${r.status})`); blockers.push('certificate') }
  else { stage('certificate', 'pending', `(${ssl} — issues once ownership is verified)`); blockers.push('certificate') }

  const resolve = domainResolveLine(r)
  out.push(resolve.line)
  // An error STATE is a blocker whether or not the plane sent a reason with it (cubic P2): a row
  // that says `error` has not been observed serving, and saying otherwise is the blackhole lie.
  if (r.status === 'error') {
    stage('error', r.status, r.errorReason || '(the plane reported an error state with no reason)')
    blockers.push('the plane reports an error state')
  } else if (r.errorReason) {
    stage('error', r.status, r.errorReason)
    blockers.push(r.errorReason)
  }

  // An unconfirmed routing target is one blocker among the others, not a headline that hides them:
  // a user fixing their DNS needs the whole outstanding list, not whichever item sorted first.
  if (!resolve.ready) blockers.push('confirm the routing target above')

  // `serving` is claimed only when every stage above agreed: the provider says configured, the
  // routing target is confirmed, and NOTHING is outstanding. A blocker beside a `configured: true`
  // answer means the record set and the verdict disagree — report the disagreement, never paper
  // over it with a URL the user would then trust (cubic P1).
  if (r.configured && blockers.length === 0) stage('serving', `https://${r.hostname}`, '')
  else stage('serving', 'not yet', blockers.length ? `(${blockers.join(', ')})` : `(${r.status})`)
  return out
}

// The platform's 409: the hostname is already bound elsewhere. Domains are never MOVED — the only
// path is unbind there, then bind here — so the hint names the release step. Three shapes:
//   owner named and present in this project → the exact remove-domain command;
//   owner named but NOT in this project's services → it is held by a deleted (or other-project)
//     service: an operator must release it (the plane has no self-serve orphan release yet);
//   owner not named (today's plane) → the generic release instruction.
// Pure, exported for tests.
export function domainConflictMessage(host: string, e: ApiError, services: ComputeRow[], ctx: DomainCmdCtx = {}): string {
  const m = /already attached to (\S+)(?: in (\S+))?;/.exec(e.message)
  const owner = m?.[1] && m[1] !== 'another' ? m[1] : undefined
  const region = m?.[2]
  // The release command must name the OWNER's group, and the branch the user is working on — a
  // command that defaults back to the linked branch would release nothing (cubic P2).
  const release = (group: string) => `insta compute remove-domain ${host}${flags({ group, branch: ctx.branch })}`
  if (owner) {
    const here = services.find((s) => s.type === 'compute' && s.name === owner)
    if (here) return `${host} is already attached to ${owner}${region ? ` (${region})` : here.region ? ` (${here.region})` : ''} — domains are not moved; release it first: ${release(owner)}, then re-run set-domain`
    return `${host} is already attached to ${owner}${region ? ` in ${region}` : ''}, which is not a service in this project — it is held by a deleted service (or one in another project); ask an operator to release the hostname before re-binding it`
  }
  return `${host} is already attached to another compute service — domains are not moved; release it there first (${release('<that service>')}) or, if that service was deleted, ask an operator to release the hostname`
}

// Resolve branch + target service, so every domain verb names the service AND its region, and an
// ambiguous project is refused with the list instead of the platform's `default` fallback picking
// one silently.
async function domainTarget(api: DomainApi, projectId: string, branch: string | undefined, host: string, group?: string): Promise<{ target: ComputeRow; services: ComputeRow[] }> {
  const { services } = await api.request('GET', `/projects/${projectId}/services${q(branch)}`)
  return { target: resolveDomainTarget(services, host, group), services }
}

// The API surface these three verbs use, so the command-level flow — preflight service lookup,
// explicit `group` on every call, --json passthrough, 409 mapping — is testable without a network
// mock (r2d2 round 1 Suggestion). Production passes a real ApiClient.
export type DomainApi = Pick<ApiClient, 'request' | 'rawRequest'>
export type DomainDeps = { api: DomainApi; project: { projectId: string; branch?: string } }
async function domainDeps(deps?: DomainDeps): Promise<DomainDeps> {
  if (deps) return deps
  const [api, project] = [await ApiClient.load(), await requireProject()]
  return { api, project }
}

// Attach a developer-owned custom domain to a branch's compute service. The plane issues the edge
// cert + routes the hostname in the service's region; the platform returns the DNS records to set
// in your OWN zone, which are printed verbatim as the next step.
export async function setDomain(host: string, opts: Opts, deps?: DomainDeps): Promise<void> {
  const { api, project: p } = await domainDeps(deps)
  const branch = opts.branch ?? p.branch
  const { target, services } = await domainTarget(api, p.projectId, branch, host, opts.group)
  const ctx: DomainCmdCtx = { group: target.name, branch: opts.branch }
  let res
  try { res = await api.rawRequest('POST', `/projects/${p.projectId}/compute/domain`, { hostname: host, branch, group: target.name }) }
  catch (e) { throw e instanceof ApiError && e.status === 409 ? new Error(domainConflictMessage(host, e, services, ctx)) : e }
  if (handleApproval(res, opts.json)) return
  if (opts.json) return printJson(res.body)
  for (const line of domainGuidanceLines(withRow(res.body, target), ctx)) info(line)
}

// Re-check a custom domain: every stage (ownership TXT, routing CNAME, edge certificate, where it
// resolves) and what each still needs.
export async function checkDomain(host: string, opts: Opts, deps?: DomainDeps): Promise<void> {
  const { api, project: p } = await domainDeps(deps)
  const branch = opts.branch ?? p.branch
  const { target, services } = await domainTarget(api, p.projectId, branch, host, opts.group)
  const ctx: DomainCmdCtx = { group: target.name, branch: opts.branch }
  const qs = new URLSearchParams({ hostname: host, group: target.name })
  if (branch) qs.set('branch', branch)
  let r
  try { r = await api.request('GET', `/projects/${p.projectId}/compute/domain?${qs}`) }
  catch (e) { throw e instanceof ApiError && e.status === 409 ? new Error(domainConflictMessage(host, e, services, ctx)) : e }
  if (opts.json) return printJson(r)
  for (const line of domainStatusLines(withRow(r, target), ctx)) info(line)
}

export async function removeDomain(host: string, opts: Opts, deps?: DomainDeps): Promise<void> {
  const { api, project: p } = await domainDeps(deps)
  const branch = opts.branch ?? p.branch
  const { target } = await domainTarget(api, p.projectId, branch, host, opts.group)
  const res = await api.rawRequest('DELETE', `/projects/${p.projectId}/compute/domain`, { hostname: host, branch, group: target.name })
  if (handleApproval(res, opts.json)) return
  renderRemoveDomain(res.body, opts.json, target)
}

// An older platform answers without service/region; the CLI already holds the row it resolved the
// target from, so the human lines never lose the region. --json stays the platform body verbatim.
export function withRow(r: DomainView, row: ComputeRow): DomainView {
  return { ...r, service: r.service ?? row.name, region: r.region ?? row.region ?? null }
}

// Split out (same pattern as applyExecResult) so the --json contract — stdout carries the platform
// response, never prose — is unit-testable without a network mock.
export function renderRemoveDomain(body: any, json?: boolean, row?: ComputeRow): void {
  if (json) return printJson(body)
  const region = body.region ?? row?.region
  info(`removed custom domain ${body.hostname} from ${body.service ?? row?.name ?? body.flyApp}${region ? ` (${region})` : ''}`)
}

// ---- lifecycle (start/stop/suspend/status) ----

type LifeOpts = { json?: boolean; branch?: string }

async function lifecycle(verb: 'start' | 'stop' | 'suspend', serviceName: string | undefined, opts: LifeOpts): Promise<void> {
  const api = await ApiClient.load()
  const p = await requireProject()
  const branch = opts.branch ?? p.branch
  const { services } = await api.request('GET', `/projects/${p.projectId}/services${q(branch)}`)
  const id = resolveComputeServiceId(services, serviceName)
  const res = await api.rawRequest('POST', `/projects/${p.projectId}/services/${id}/${verb}`)
  if (handleApproval(res, opts.json)) return
  if (opts.json) return printJson(res.body)
  info(`compute ${res.body.service?.name ?? id}: ${verb} → desired=${res.body.service?.desired_state} (live: ${res.body.state})`)
}

export const computeStart = (service: string | undefined, opts: LifeOpts) => lifecycle('start', service, opts)
export const computeStop = (service: string | undefined, opts: LifeOpts) => lifecycle('stop', service, opts)
export const computeSuspend = (service: string | undefined, opts: LifeOpts) => lifecycle('suspend', service, opts)

export async function computeStatus(serviceName: string | undefined, opts: LifeOpts): Promise<void> {
  const api = await ApiClient.load()
  const p = await requireProject()
  const branch = opts.branch ?? p.branch
  const { services } = await api.request('GET', `/projects/${p.projectId}/services${q(branch)}`)
  const id = resolveComputeServiceId(services, serviceName)
  const r = await api.request('GET', `/projects/${p.projectId}/services/${id}/state`)
  if (opts.json) return printJson(r)
  info(`compute ${serviceName ?? id}: desired=${r.desiredState}  live=${r.state}`)
}

// ---- exec (one-shot command; no interactive shell/PTY) ----

// `insta compute exec [service] -- <command> [args…]`: the command must reach the platform
// byte-for-byte and can itself contain dashes or another `--`, so it can't be a normal commander
// positional — with `service` optional, commander flattens everything past the literal `--` into
// one operand list and has no way to tell "no service, command starts here" apart from "service IS
// the first command token". Splitting argv on the first literal `--` after `compute exec`
// ourselves, before commander ever parses it, removes the ambiguity; this is the only place in the
// whole CLI a bare `--` has this meaning, so nothing else is affected. Exported for a direct,
// network-free unit test — this split is the seam most likely to regress.
/** The options `insta compute exec` declares — the one source of truth. index.ts builds the
 *  commander command from this list, and the payload scan below uses it to know where the CLI's
 *  own arguments stop. Adding an option here reaches both. */
export const EXEC_OPTIONS: ReadonlyArray<readonly [flags: string, description?: string]> = [
  ['--branch <b>'],
  ['--timeout <sec>', 'command timeout in seconds, 1-180 (platform default: 30)'],
  ['--json'],
]

const names = (flags: string) => flags.split(/[ ,|]+/).filter((t) => t.startsWith('-'))
const TAKES_VALUE = new Set(EXEC_OPTIONS.filter(([f]) => /[<[]/.test(f)).flatMap(([f]) => names(f)))
const BARE = new Set(EXEC_OPTIONS.filter(([f]) => !/[<[]/.test(f)).flatMap(([f]) => names(f)))

// Index of the first token that is not one of `compute exec`'s own options. Everything from there
// on is PAYLOAD — the optional service plus the remote command — and nothing inside it is ever
// interpreted, so the remote command keeps its own flags (`ls -la`, `sh -c …`) untouched.
function payloadStart(argv: string[], from: number): number {
  for (let cursor = from; cursor < argv.length; cursor++) {
    const token = argv[cursor]!
    if (TAKES_VALUE.has(token)) { cursor++; continue }
    if (BARE.has(token) || (token.includes('=') && TAKES_VALUE.has(token.slice(0, token.indexOf('='))))) continue
    return cursor
  }
  return argv.length
}

// Where does THIS process's `compute exec` command start? Only the command path counts: `compute`
// and `exec` appearing later are payload for something else — `insta run -- compute exec app echo`
// hands those words to a LOCAL child, and rewriting argv there would eat the child's last
// argument. argv[0] and argv[1] are the runtime and this script, verified to hold for the released
// Bun standalone binary too (its `process.argv` is `["bun", "/$bunfs/root/insta", …]`), which is
// the offset commander's own parse assumes. Returns -1 for "not ours".
function execCommandIndex(argv: string[]): number {
  for (let cursor = 2; cursor < argv.length; cursor++) {
    const token = argv[cursor]!
    if (token.startsWith('-')) return -1 // a global flag, or `--`: either way not our command path
    return token === 'compute' && argv[cursor + 1] === 'exec' ? cursor : -1
  }
  return -1
}

// `insta compute exec [service] -- <command> [args…]`: the command must reach the platform
// byte-for-byte and can itself contain dashes or another `--`, so it cannot be a normal commander
// positional — with `service` optional, commander cannot tell "no service, command starts here"
// from "service IS the first command token". Splitting argv ourselves, before commander parses,
// removes the ambiguity. Exported for a direct, network-free unit test.
export function splitExecArgs(
  argv: string[],
  platform: NodeJS.Platform = process.platform,
): { argv: string[]; command?: string[]; windowsFallback?: boolean } {
  const i = execCommandIndex(argv)
  if (i === -1) return { argv }
  const dash = argv.indexOf('--', i + 2)
  const start = payloadStart(argv, i + 2)
  // A separator that survived is the payload's first token (service omitted) or its second
  // (service given) — nowhere else. Deeper than that it is the remote command's OWN `--`: npm's
  // PowerShell shim strips only the first one, so the real separator is already gone.
  if (dash !== -1 && (platform !== 'win32' || dash <= start + 1)) {
    return { argv: argv.slice(0, dash), command: argv.slice(dash + 1) }
  }
  if (platform !== 'win32') return { argv }
  // Nothing to recover, and `--help` is local: neither should cost the service-list round-trip the
  // fallback needs. Help also wins over recovery — it is what this command's own usage error
  // points at; the cost is that a remote command taking `--help` as an argument needs `insta.cmd`
  // (or the `sh -c` form) on PowerShell.
  const payload = argv.slice(start)
  if (payload.length === 0 || payload.some((t) => t === '--help' || t === '-h')) return { argv }
  return { argv: argv.slice(0, start), command: payload, windowsFallback: true }
}

// The separator is gone, so the payload arrives undivided and only the service list can split it:
// `insta compute exec -- printenv PORT` and `insta compute exec printenv PORT` are byte-identical
// by the time they reach us. The reading taken is STATED on stderr — stdout stays clean for
// --json — because it is a guess in both directions: a service named `echo` would swallow the
// executable, and a mistyped service name is demoted to argv[0] and run remotely.
export function resolveExecFallback(
  services: Array<{ id: string; type: string; name: string }>,
  payload: string[],
  note: (msg: string) => void = (msg) => process.stderr.write(`${msg}\n`),
): { serviceName: string | undefined; command: string[] } {
  const [head, ...rest] = payload
  if (head === undefined) return { serviceName: undefined, command: [] }
  if (!services.some((service) => service.type === 'compute' && service.name === head)) {
    note(`note: no \`--\` separator was found and \`${head}\` is not a compute service, so it was read as the command. If it was the service, check the name with \`insta services list\`.`)
    return { serviceName: undefined, command: payload }
  }
  // `head` really is a service, so a flag right behind it cannot be the command — it is a CLI
  // option that landed on the wrong side of a separator that is not there. Say so instead of
  // waking a machine to run `--brnach` as a program. Only the observable fact is stated: cmd.exe
  // and the released .exe reach this too, with no shim involved and no `insta.cmd` on disk.
  if (rest[0]?.startsWith('-')) {
    throw new Error(`no \`--\` separator was found before \`${rest[0]}\` — put CLI options ahead of [service], or add \`--\` before the command: insta compute exec ${head} -- <command> [args…]`)
  }
  if (rest.length > 0) {
    const quoted = payload.map((a) => (/[\s"^&|<>()]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a)).join(' ')
    note(`note: no \`--\` separator was found; read \`${head}\` as the compute service. If it was the command, run: insta compute exec -- ${quoted}`)
  }
  return { serviceName: head, command: rest }
}

// The --timeout override, through a throwing parser like every other user-typed number in this
// repo (parseCpu, parseCount, parsePort): junk must fail locally instead of reaching the server as
// NaN, and the bounds mirror what the platform enforces (1-180s; server default 30 when omitted).
export function parseTimeoutSec(raw: string): number {
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 1 || n > 180) throw new Error(`invalid timeout: ${raw} (1-180 seconds)`)
  return n
}

// Map exec inputs to the platform POST body. Pure, unit-tested without a network mock (mirrors
// deployRequestBody / servicesAddRequestBody). timeoutSec is omitted when not given so the server
// applies its own default (30s) rather than the client picking one on the wire.
export function execRequestBody(command: string[], timeoutSec?: number): Record<string, unknown> {
  return { command, ...(timeoutSec !== undefined ? { timeoutSec } : {}) }
}

type ExecOpts = LifeOpts & { timeout?: string }
type ExecRecovery = { windowsFallback?: boolean }

// Renders the exec response and sets process.exitCode — split out of computeExec as a pure function
// of (res, json) so it's unit-testable without a network mock, same as handleApproval's own
// {status, body} shape.
//
// A 202 means the command has NOT run: handleApproval owns the whole contract (hint on stderr,
// raw envelope on stdout with --json, exit 2), so a caller chaining `insta compute exec … && next`
// can never mistake a pending gate for the command having succeeded — and exit 2 stays
// distinguishable from the remote command's own exit 1.
export function applyExecResult(res: { status: number; body: any }, json?: boolean): void {
  if (handleApproval(res, json)) return
  const { exitCode, stdout, stderr, truncated } = res.body
  if (json) {
    printJson(res.body)
  } else {
    process.stdout.write(stdout)
    process.stderr.write(stderr)
    if (truncated) process.stderr.write('note: output truncated — the platform caps stdout/stderr at 1 MiB each\n')
  }
  // The platform sends -1 as an "unknown exit" sentinel, and nothing outside 0-255 is a valid POSIX
  // exit code. Assigning it straight to process.exitCode risks Node's own DEP0164 (a negative code
  // silently exits 255) — clamp out-of-range codes to 1 instead, with a one-line note so the cause is
  // visible. Normal codes pass through untouched.
  if (exitCode < 0 || exitCode > 255) {
    process.stderr.write(`note: remote exit code ${exitCode} out of range — exiting 1\n`)
    process.exitCode = 1
  } else {
    process.exitCode = exitCode
  }
}

// One HTTP round trip, not a shell session: no PTY, no interactivity, stdout/stderr come back as
// two whole strings (each capped at 1 MiB server-side) rather than a stream. They're written to
// this process's own stdout/stderr verbatim — no prefixes, no added newline — and the remote exit
// code becomes this process's own exit code (--json still passes it through, it just skips the
// split-stream output), since agents scripting this rely on it. Waking a scaled-to-zero machine is
// expected — it adds latency and bills as uptime, it is not an error.
export async function computeExec(
  serviceName: string | undefined,
  command: string[] | undefined,
  opts: ExecOpts,
  recovery: ExecRecovery = {},
): Promise<void> {
  if (!recovery.windowsFallback && (!command || command.length === 0)) {
    throw new Error('usage: insta compute exec [service] -- <command> [args…] (see --help)')
  }
  const timeoutSec = opts.timeout !== undefined ? parseTimeoutSec(opts.timeout) : undefined
  const api = await ApiClient.load()
  const p = await requireProject()
  const branch = opts.branch ?? p.branch
  const { services } = await api.request('GET', `/projects/${p.projectId}/services${q(branch)}`)
  const target = recovery.windowsFallback
    ? resolveExecFallback(services, command ?? [])
    : { serviceName, command }
  if (!target.command || target.command.length === 0) {
    throw new Error('usage: insta compute exec [service] -- <command> [args…] (see --help)')
  }
  const id = resolveComputeServiceId(services, target.serviceName)
  const res = await api.rawRequest('POST', `/projects/${p.projectId}/services/${id}/exec`, execRequestBody(target.command, timeoutSec))
  applyExecResult(res, opts.json)
}

// ---- always-on (opt out of scale-to-zero; all plans; billing is actual usage either way) ----

export async function computeAlwaysOn(mode: string, serviceName: string | undefined, opts: LifeOpts): Promise<void> {
  if (mode !== 'on' && mode !== 'off') throw new Error('mode must be on|off')
  const api = await ApiClient.load()
  const p = await requireProject()
  const branch = opts.branch ?? p.branch
  const { services } = await api.request('GET', `/projects/${p.projectId}/services${q(branch)}`)
  const id = resolveComputeServiceId(services, serviceName)
  const res = await api.rawRequest('PUT', `/projects/${p.projectId}/services/${id}/always-on`, { enabled: mode === 'on' })
  if (handleApproval(res, opts.json)) return
  if (opts.json) return printJson(res.body)
  const on = res.body.service?.always_on
  info(`compute ${res.body.service?.name ?? id}: always-on ${on ? 'ENABLED — machines stay warm (no cold starts; idle RAM bills at actual usage)' : 'disabled — scales to zero when idle (default)'}`)
}

// ---- limits (the resource ceiling; paid plans) ----

// Parse a human memory value into MB: "512", "512mb", "1gb", "2g", "1.5gb".
// Exported for unit tests — this is the only place a user-typed size becomes a number.
export function parseMemoryMb(raw: string): number {
  const m = /^\s*(\d+(?:\.\d+)?)\s*(g|gb|gi|gib|m|mb|mi|mib)?\s*$/i.exec(raw)
  if (!m) throw new Error(`invalid memory: ${raw} (try 512mb, 1gb, 2gb)`)
  const n = Number(m[1])
  const unit = (m[2] ?? 'mb').toLowerCase()
  const mb = unit.startsWith('g') ? n * 1024 : n
  if (!(mb > 0)) throw new Error(`invalid memory: ${raw}`)
  return Math.round(mb)
}

// Whole and half GB collapse (1536 → "1.5 GB"); anything else stays exact in MB — a display that
// rounds 1536 to "2 GB" claims a ceiling the API did not set.
export const fmtMb = (mb: number) => (mb >= 1024 && mb % 512 === 0 ? `${mb / 1024} GB` : `${mb} MB`)

// The --cpu override, through a throwing parser like every other user-typed number in this repo
// (parseCount, parseMemoryMb). A bare Number() turns a typo into NaN, which JSON.stringify
// serializes as null — the server then sees {cpu: null} instead of the user seeing an error.
// Enforces the provider grid the help text advertises: the server would reject 100 anyway, but a
// value the client KNOWS is invalid should fail locally, matching what --help promises.
const CPU_SIZES = [1, 2, 4, 6, 8]
export function parseCpu(raw: string): number {
  const n = Number(raw)
  if (!CPU_SIZES.includes(n)) throw new Error(`invalid cpu: ${raw} (provider sizes: ${CPU_SIZES.join(', ')})`)
  return n
}

// ---- volume (the persistent /data disk; attach any time, grow-only, deletable; never detach) ----

// Render the volume read. Pure, exported for tests (mirrors serviceListLine). Every plan may view;
// only growth is paid — that gate is the backend's to enforce, so nothing here pre-blocks.
export function volumeLines(name: string, volume: { sizeGib: number; mountPath: string } | null, cap: { volumeGib: number }): string[] {
  if (!volume) return [
    `compute ${name}: no volume attached (attach one: \`insta compute volume ${name} --size <gi>\` — it mounts at /data on the next deploy)`,
  ]
  return [
    `compute ${name}: volume ${volume.sizeGib}Gi at ${volume.mountPath}  (plan max ${cap.volumeGib}Gi)`,
    '  billing is actual data stored — the size is a cap, not a price; grow with --size (grow-only), delete with --delete (destroys the data)',
  ]
}

// Render the PUT result. Pure, exported for tests. `attached` comes from the backend and is what
// tells a FIRST attach (no disk yet — it mounts on the next deploy) apart from a grow (the live
// disk was already extended); the wire size is authoritative in both cases.
export function volumeWriteLine(name: string, body: { volume: { sizeGib: number; mountPath: string }; cap: { volumeGib: number }; attached?: boolean }): string {
  if (body.attached) {
    return `compute ${name}: volume ${body.volume.sizeGib}Gi attached — mounts at ${body.volume.mountPath} on the next deploy  (plan max ${body.cap.volumeGib}Gi)`
  }
  return `compute ${name}: volume grown to ${body.volume.sizeGib}Gi at ${body.volume.mountPath}  (plan max ${body.cap.volumeGib}Gi)`
}

// Render the DELETE result. Pure, exported for tests. Deleting is the only way off the volume
// path (there is no detach), so the line says what came back with it: the two constraints the
// volume imposed.
export function volumeDeleteLine(name: string): string {
  return `compute ${name}: volume deleted — the disk and its data are gone; suspend fast-wake and scale-out are back`
}

// Map a DELETE .../volume failure. Pure, exported for tests (r2d2 review rounds 1+2: this is the
// close-call branch worth pinning). An older backend has no DELETE route, and what its 404 looks
// like depends on who answered: the real platform (Fastify, no custom notFound handler) sends its
// default body {"message":"Route DELETE:/… not found","error":"Not Found"} → ApiError message
// "Not Found"; a proxy or bodyless 404 leaves ApiError's own "HTTP 404" fallback. BOTH are the
// generic route-miss shape and mean version skew, not a bug — parroting them would send the user
// hunting the wrong thing. A backend that HAS the route names the real problem in a DOMAIN
// message ("this service has no volume", …), which must flow verbatim, 404 or not.
const GENERIC_404 = /^(HTTP 404|Not Found)$/i
export function volumeDeleteError(e: unknown): unknown {
  if (e instanceof ApiError && e.status === 404 && GENERIC_404.test(e.message.trim())) {
    return new Error('this backend does not support volume delete yet — update the platform, or delete the service to remove its volume')
  }
  return e
}

type VolumeOpts = LifeOpts & { size?: string; delete?: boolean }

// Show, attach, grow, or delete a compute service's /data volume. No flag: a safe read (size +
// mount path + the plan cap). --size: PUT .../volume — attaches when no volume exists, grows
// otherwise. --delete: DELETE .../volume — destroys the disk and its data immediately (no detach,
// no undo; billing stops now). The paid/cap/machine-count gates all belong to the backend, whose
// 403/400 messages carry the upgrade hints and must reach the user verbatim (the guard prints
// ApiError messages as-is).
export async function computeVolume(serviceName: string | undefined, opts: VolumeOpts): Promise<void> {
  if (opts.delete && opts.size) throw new Error('--delete cannot be combined with --size (one changes the volume, the other destroys it)')
  const api = await ApiClient.load()
  const p = await requireProject()
  const branch = opts.branch ?? p.branch
  const { services } = await api.request('GET', `/projects/${p.projectId}/services${q(branch)}`)
  const id = resolveComputeServiceId(services, serviceName)

  if (opts.delete) {
    let res
    try { res = await api.rawRequest('DELETE', `/projects/${p.projectId}/services/${id}/volume`) }
    catch (e) { throw volumeDeleteError(e) }
    if (handleApproval(res, opts.json)) return
    if (opts.json) return printJson(res.body)
    info(volumeDeleteLine(res.body.service?.name ?? serviceName ?? id))
    return
  }

  if (!opts.size) {
    const r = await api.request('GET', `/projects/${p.projectId}/services/${id}/volume`)
    if (opts.json) return printJson(r)
    for (const line of volumeLines(serviceName ?? id, r.volume, r.cap)) info(line)
    return
  }

  const sizeGib = parseVolumeGib(opts.size)
  const res = await api.rawRequest('PUT', `/projects/${p.projectId}/services/${id}/volume`, { sizeGib })
  if (handleApproval(res, opts.json)) return
  if (opts.json) return printJson(res.body)
  info(volumeWriteLine(res.body.service?.name ?? serviceName ?? id, res.body))
}

type LimitsOpts = LifeOpts & { cpu?: string; memory?: string }

// Show or set a compute service's ceiling. With no --memory it PRINTS the current limits and the
// plan cap (so `insta compute limits` is a safe read), which is also what a UI renders as a slider
// with its plan-limit marker.
export async function computeLimits(serviceName: string | undefined, opts: LimitsOpts): Promise<void> {
  const api = await ApiClient.load()
  const p = await requireProject()
  const branch = opts.branch ?? p.branch
  const { services } = await api.request('GET', `/projects/${p.projectId}/services${q(branch)}`)
  const id = resolveComputeServiceId(services, serviceName)

  if (!opts.memory && !opts.cpu) {
    const r = await api.request('GET', `/projects/${p.projectId}/services/${id}/limits`)
    if (opts.json) return printJson(r)
    info(`compute ${serviceName ?? id}: ceiling ${r.limits.cpu} vCPU / ${fmtMb(r.limits.memoryMb)}  (plan max ${r.cap.cpu} vCPU / ${fmtMb(r.cap.memoryMb)})`)
    info('  billing is actual usage — the ceiling caps what the app may burn, it is not a price')
    return
  }
  if (!opts.memory) throw new Error('--memory is required when setting limits (cpu is derived from it; pass --cpu only to override)')

  const body: Record<string, unknown> = { memoryMb: parseMemoryMb(opts.memory) }
  if (opts.cpu) body.cpu = parseCpu(opts.cpu)
  const res = await api.rawRequest('PUT', `/projects/${p.projectId}/services/${id}/limits`, body)
  if (handleApproval(res, opts.json)) return
  if (opts.json) return printJson(res.body)
  const l = res.body.limits
  info(`compute ${res.body.service?.name ?? id}: ceiling set to ${l.cpu} vCPU / ${fmtMb(l.memoryMb)}`)
}
