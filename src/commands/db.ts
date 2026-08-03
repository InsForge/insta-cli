import { ApiClient, requireProject } from '../api.js'
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
    const r = await api.request('GET', `/projects/${p.projectId}/database/instance${suffix}`).catch(() => null)
    if (opts.json) return printJson(r ?? {})
    if (r?.cpuMilli || r?.memoryMib) {
      info(`postgres ${opts.group ?? 'default'}: ceiling ${(r.cpuMilli / 1000).toFixed(r.cpuMilli % 1000 ? 1 : 0)} vCPU / ${Math.round(r.memoryMib / 1024)} GiB`)
    } else {
      info(`postgres ${opts.group ?? 'default'}: current ceiling unavailable — set one with --cpu/--memory`)
    }
    return
  }

  const body: Record<string, unknown> = {}
  if (opts.cpu) body.cpu = opts.cpu
  if (opts.memory) body.memory = opts.memory
  const res = await api.rawRequest('PATCH', `/projects/${p.projectId}/database/settings${suffix}`, body)
  if (handleApproval(res)) return
  if (opts.json) return printJson(res.body)
  const cpu = res.body?.cpuMilli ? `${res.body.cpuMilli / 1000} vCPU` : (opts.cpu ?? 'unchanged')
  const mem = res.body?.memoryMib ? `${Math.round(res.body.memoryMib / 1024)} GiB` : (opts.memory ?? 'unchanged')
  info(`postgres ${opts.group ?? 'default'}: ceiling set to ${cpu} / ${mem}`)
}
