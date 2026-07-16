import { ApiClient, requireProject } from '../api.js'
import { info, printJson, handleApproval } from '../util.js'
import { resolveComputeServiceId } from './services.js'

type Opts = { branch?: string; group?: string; json?: boolean }

// Attach a developer-owned custom domain to a branch's compute service. Fly issues the cert + routes
// it; the platform returns the DNS records to set in your OWN zone.
export async function setDomain(host: string, opts: Opts): Promise<void> {
  const api = await ApiClient.load()
  const p = await requireProject()
  const res = await api.rawRequest('POST', `/projects/${p.projectId}/compute/domain`, { hostname: host, branch: opts.branch ?? p.branch, group: opts.group })
  if (handleApproval(res)) return
  printDomain(res.body, opts.json)
}

// Re-check a custom domain's cert status + required DNS records.
export async function checkDomain(host: string, opts: Opts): Promise<void> {
  const api = await ApiClient.load()
  const p = await requireProject()
  const qs = new URLSearchParams({ hostname: host })
  if (opts.branch ?? p.branch) qs.set('branch', opts.branch ?? p.branch)
  if (opts.group) qs.set('group', opts.group)
  printDomain(await api.request('GET', `/projects/${p.projectId}/compute/domain?${qs}`), opts.json)
}

export async function removeDomain(host: string, opts: Opts): Promise<void> {
  const api = await ApiClient.load()
  const p = await requireProject()
  const res = await api.rawRequest('DELETE', `/projects/${p.projectId}/compute/domain`, { hostname: host, branch: opts.branch ?? p.branch, group: opts.group })
  if (handleApproval(res)) return
  info(`removed custom domain ${res.body.hostname} from ${res.body.flyApp}`)
}

function printDomain(r: any, json?: boolean): void {
  if (json) return printJson(r)
  info(`${r.hostname} → ${r.flyApp}`)
  info(`  status: ${r.status}${r.configured ? ' ✓ configured' : ''}`)
  if (r.dns?.length) {
    info('  set these DNS records at your domain registrar:')
    for (const d of r.dns) info(`    ${String(d.type).padEnd(5)} ${d.name}  →  ${d.value}${d.note ? `   # ${d.note}` : ''}`)
  }
  if (!r.configured) info('  once DNS propagates, Fly issues the cert — re-check with `insta compute check-domain`')
}

// ---- lifecycle (start/stop/suspend/status) ----

type LifeOpts = { json?: boolean; branch?: string }

async function lifecycle(verb: 'start' | 'stop' | 'suspend', serviceName: string | undefined, opts: LifeOpts): Promise<void> {
  const api = await ApiClient.load()
  const p = await requireProject()
  const branch = opts.branch ?? p.branch
  const { services } = await api.request('GET', `/projects/${p.projectId}/services${branch ? `?branch=${encodeURIComponent(branch)}` : ''}`)
  const id = resolveComputeServiceId(services, serviceName)
  const res = await api.rawRequest('POST', `/projects/${p.projectId}/services/${id}/${verb}`)
  if (handleApproval(res)) return
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
  const { services } = await api.request('GET', `/projects/${p.projectId}/services${branch ? `?branch=${encodeURIComponent(branch)}` : ''}`)
  const id = resolveComputeServiceId(services, serviceName)
  const r = await api.request('GET', `/projects/${p.projectId}/services/${id}/state`)
  if (opts.json) return printJson(r)
  info(`compute ${serviceName ?? id}: desired=${r.desiredState}  live=${r.state}`)
}
