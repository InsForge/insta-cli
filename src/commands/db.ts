import { ApiClient, ApiError, requireProject } from '../api.js'
import { info, printJson, handleApproval } from '../util.js'

type Opts = { branch?: string; group?: string; json?: boolean }

// Toggle a postgres service between scale-to-zero (the default: instance suspends when idle,
// cold-starts on the next connection) and always-on (instance stays warm; idle RAM bills at
// actual usage). Thin wrapper over PATCH /database/settings {scaleToZero} — insta-db-backed
// postgres only; Neon-backed services manage their own autosuspend and the platform returns an
// error for them.
export async function dbAlwaysOn(mode: string, opts: Opts): Promise<void> {
  if (mode !== 'on' && mode !== 'off') throw new Error('mode must be on|off')
  const api = await ApiClient.load()
  const p = await requireProject()
  const qs = new URLSearchParams()
  const branch = opts.branch ?? p.branch
  if (branch) qs.set('branch', branch)
  if (opts.group) qs.set('group', opts.group)
  const res = await api.rawRequest('PATCH', `/projects/${p.projectId}/database/settings${qs.toString() ? `?${qs}` : ''}`, { scaleToZero: mode !== 'on' })
  if (handleApproval(res)) return
  if (opts.json) return printJson(res.body)
  const s2z = res.body?.scaleToZero
  info(`postgres ${opts.group ?? 'default'}: always-on ${s2z === false ? 'ENABLED — instance stays warm (no cold starts; idle RAM bills at actual usage)' : 'disabled — scales to zero when idle (default; first connection after idle cold-starts)'}`)
}

// Validated pass-throughs for the provider's quantity strings. The insta-db resize API takes
// k8s-style quantities (cpu: "2", "2500m"; memory: "4Gi", "2048Mi"), so unlike the compute path
// there is no unit conversion here — but junk must still fail LOCALLY with an example, not travel
// to the server as-is. CASE-EXACT deliberately: k8s quantities are case-sensitive ("4gi" is
// rejected server-side), and local validation that accepts a form the backend refuses would
// defeat its own purpose.
export function parseDbCpu(raw: string): string {
  if (!/^\d+(\.\d+)?m?$/.test(raw.trim())) throw new Error(`invalid cpu: ${raw} (try 2, 4, or 2500m)`)
  return raw.trim()
}
export function parseDbMemory(raw: string): string {
  if (!/^\d+(\.\d+)?(Gi|Mi|G|M)$/.test(raw.trim())) throw new Error(`invalid memory: ${raw} (try 4Gi or 8Gi)`)
  return raw.trim()
}

// MiB → display without lying: whole/half GiB collapse, anything else stays exact in MiB
// (1536 MiB is "1.5 GiB", 1300 MiB is "1300 MiB" — never "1 GiB").
export function fmtMib(mib: number): string {
  return mib >= 1024 && mib % 512 === 0 ? `${mib / 1024} GiB` : `${mib} MiB`
}

// The read outcome, as a seam. rawRequest THROWS ApiError on any status >= 400 (api.ts — it only
// differs from request in returning {status,body} below 400, for 202 branching), so the Neon case
// and the friendly wrapping must live in a catch, not in status branching on the return value —
// branches on res.status >= 400 after rawRequest are unreachable. Takes the client as an argument
// so tests drive it with a stub, per this repo's pure-seam convention.
export type DbInstanceRead = { kind: 'ok'; body: any } | { kind: 'no-instance' }

export async function fetchDbInstance(
  api: { rawRequest: (m: string, p: string) => Promise<{ status: number; body: any }> },
  projectId: string,
  suffix: string,
): Promise<DbInstanceRead> {
  try {
    const res = await api.rawRequest('GET', `/projects/${projectId}/database/instance${suffix}`)
    return { kind: 'ok', body: res.body }
  } catch (e) {
    // The platform answers a provider-shaped 502 for services with no manageable instance
    // (Neon-backed): a soft case, not a failure. Everything else stays an error — an expired
    // token must not render as "no ceiling set" — but wrapped so the user sees what failed.
    if (e instanceof ApiError && e.status === 502) return { kind: 'no-instance' }
    if (e instanceof ApiError) throw new Error(`reading the instance failed (${e.status}): ${e.message}`)
    throw e
  }
}

// Show or set a postgres service's resource ceiling (insta-db-backed only). Paid plans — the
// ceiling is the tier lever now that billing follows actual usage. Moves both directions:
// unlike storage it is a cgroup limit, not a provisioned volume.
export async function dbLimits(opts: Opts & { cpu?: string; memory?: string }): Promise<void> {
  const api = await ApiClient.load()
  const p = await requireProject()
  const qs = new URLSearchParams()
  const branch = opts.branch ?? p.branch
  if (branch) qs.set('branch', branch)
  if (opts.group) qs.set('group', opts.group)
  const suffix = qs.toString() ? `?${qs}` : ''

  if (!opts.cpu && !opts.memory) {
    const read = await fetchDbInstance(api, p.projectId, suffix)
    if (read.kind === 'no-instance') {
      info(`postgres ${opts.group ?? 'default'}: no manageable instance (Neon-backed services manage their own resources)`)
      return
    }
    if (opts.json) return printJson(read.body)
    const cpuMilli = read.body?.cpuMilli
    const mib = read.body?.memoryMib
    if (typeof cpuMilli === 'number' && typeof mib === 'number') {
      const cpu = cpuMilli % 1000 === 0 ? `${cpuMilli / 1000}` : `${cpuMilli}m`
      info(`postgres ${opts.group ?? 'default'}: ceiling ${cpu} vCPU / ${fmtMib(mib)}`)
      info('  billing is actual usage — the ceiling caps what the database may burn, it is not a price')
    } else {
      info(`postgres ${opts.group ?? 'default'}: provider reported no ceiling — set one with --cpu/--memory`)
    }
    return
  }

  const body: Record<string, unknown> = {}
  if (opts.cpu) body.cpu = parseDbCpu(opts.cpu)
  if (opts.memory) body.memory = parseDbMemory(opts.memory)
  let res
  try {
    res = await api.rawRequest('PATCH', `/projects/${p.projectId}/database/settings${suffix}`, body)
  } catch (e) {
    if (e instanceof ApiError) throw new Error(`setting the ceiling failed (${e.status}): ${e.message}`)
    throw e
  }
  if (handleApproval(res)) return
  if (opts.json) return printJson(res.body)
  const cpu = typeof res.body?.cpuMilli === 'number' ? `${res.body.cpuMilli / 1000} vCPU` : (opts.cpu ?? 'unchanged')
  const mem = typeof res.body?.memoryMib === 'number' ? fmtMib(res.body.memoryMib) : (opts.memory ?? 'unchanged')
  info(`postgres ${opts.group ?? 'default'}: ceiling set to ${cpu} / ${mem}`)
}
