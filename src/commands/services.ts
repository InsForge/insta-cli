// `insta services` — manage a project's opt-in services (postgres | storage | compute).
import { ApiClient, requireProject } from '../api.js'
import { info, printJson, handleApproval } from '../util.js'

export const SERVICE_TYPES = ['postgres', 'storage', 'compute'] as const
export type ServiceType = (typeof SERVICE_TYPES)[number]

// ---- pure, unit-tested helpers (throw plain Errors; the CLI guard turns them into clean output) ----

// Validate a service-type argument against the allowed set for a command.
export function assertType(type: string, allowed: readonly string[] = SERVICE_TYPES): asserts type is ServiceType {
  if (!allowed.includes(type)) throw new Error(`type must be ${allowed.join('|')}`)
}

// Parse a positive-integer machine count.
export function parseCount(raw: string): number {
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 1) throw new Error(`count must be a positive integer, got: ${raw}`)
  return n
}

// Resolve a service id from a `services list` result by (type, name).
export function resolveServiceId(services: Array<{ id: string; type: string; name: string }>, type: string, name: string): string {
  const svc = services.find((s) => s.type === type && s.name === name)
  if (!svc) throw new Error(`service not found: ${type} ${name}`)
  return svc.id
}

// Resolve a compute service id: by name, or the sole compute service when name is omitted.
export function resolveComputeServiceId(services: Array<{ id: string; type: string; name: string }>, name?: string): string {
  const compute = services.filter((s) => s.type === 'compute')
  if (name) {
    const svc = compute.find((s) => s.name === name)
    if (!svc) throw new Error(`compute service not found: ${name}`)
    return svc.id
  }
  if (compute.length === 0) throw new Error('no compute service in this project (add one with `insta services add compute <name>`)')
  if (compute.length > 1) throw new Error(`multiple compute services — specify one: ${compute.map((s) => s.name).join(', ')}`)
  return compute[0]!.id
}

// ---- commands ----

export async function servicesAdd(type: string, name: string): Promise<void> {
  assertType(type)
  const api = await ApiClient.load()
  const p = await requireProject()
  const res = await api.rawRequest('POST', `/projects/${p.projectId}/services`, { type, name })
  if (handleApproval(res)) return
  const svc = res.body.service
  info(`added ${type} service ${name} (${svc.id})${svc.domain ? ` — ${svc.domain}` : ''}`)
}

export async function servicesList(opts: { json?: boolean }): Promise<void> {
  const api = await ApiClient.load()
  const p = await requireProject()
  const { services } = await api.request('GET', `/projects/${p.projectId}/services`)
  if (opts.json) return printJson(services)
  if (!services.length) return info('(no services — add one with `insta services add <postgres|storage|compute> <name>`)')
  for (const s of services) {
    const extra = s.type === 'compute' ? `  x${s.machine_count}` : ''
    info(`${s.type}/${s.name}  [${s.status}]${extra}${s.domain ? `  ${s.domain}` : ''}  ${s.id}`)
  }
}

export async function servicesRemove(type: string, name: string): Promise<void> {
  assertType(type)
  const api = await ApiClient.load()
  const p = await requireProject()
  const { services } = await api.request('GET', `/projects/${p.projectId}/services`)
  const id = resolveServiceId(services, type, name)
  const res = await api.rawRequest('DELETE', `/projects/${p.projectId}/services/${id}`)
  if (handleApproval(res)) return
  info(`removed ${type} service ${name}`)
}

// insta services scale compute <name> <number> [region]
export async function servicesScale(type: string, name: string, number: string, region: string | undefined, _opts: { json?: boolean }): Promise<void> {
  assertType(type, ['compute'])
  const machineCount = parseCount(number)
  const api = await ApiClient.load()
  const p = await requireProject()
  const { services } = await api.request('GET', `/projects/${p.projectId}/services`)
  const id = resolveServiceId(services, type, name)
  const res = await api.rawRequest('POST', `/projects/${p.projectId}/services/${id}/scale`, { machineCount, region })
  if (handleApproval(res)) return
  if (_opts.json) return printJson(res.body.service)
  info(`scaled compute ${name} to ${machineCount} machine(s)${region ? ` in ${region}` : ''}`)
}

// insta services upgrade <compute|postgres> <name> <new-spec>
export async function servicesUpgrade(type: string, name: string, spec: string, _opts: { json?: boolean }): Promise<void> {
  assertType(type, ['compute', 'postgres'])
  const api = await ApiClient.load()
  const p = await requireProject()
  const { services } = await api.request('GET', `/projects/${p.projectId}/services`)
  const id = resolveServiceId(services, type, name)
  const res = await api.rawRequest('POST', `/projects/${p.projectId}/services/${id}/upgrade`, { spec })
  if (handleApproval(res)) return
  if (_opts.json) return printJson(res.body.service)
  info(`upgraded ${type} ${name} to ${spec}`)
}
