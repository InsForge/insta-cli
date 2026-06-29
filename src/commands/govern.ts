import { ApiClient, requireProject } from '../api.js'
import { info, printJson } from '../util.js'

export async function events(opts: { branch?: string; limit?: string; json?: boolean }): Promise<void> {
  const api = await ApiClient.load()
  const p = await requireProject()
  const qs: string[] = []
  if (opts.branch) qs.push(`branch=${encodeURIComponent(opts.branch)}`)
  if (opts.limit) qs.push(`limit=${opts.limit}`)
  const { events } = await api.request('GET', `/projects/${p.projectId}/events${qs.length ? `?${qs.join('&')}` : ''}`)
  if (opts.json) return printJson(events)
  for (const e of events) info(`${e.created_at}  [${e.source}] ${e.kind}`)
}

export async function approvalsList(opts: { status?: string; json?: boolean }): Promise<void> {
  const api = await ApiClient.load()
  const p = await requireProject()
  const { approvals } = await api.request('GET', `/projects/${p.projectId}/approvals${opts.status ? `?status=${opts.status}` : ''}`)
  if (opts.json) return printJson(approvals)
  if (!approvals.length) return info('(no approvals)')
  for (const a of approvals) info(`${a.id}  ${a.action}  [${a.status}]  ${a.requested_at}`)
}

export async function approvalsApprove(id: string, opts: { always?: boolean }): Promise<void> {
  const api = await ApiClient.load()
  const p = await requireProject()
  const out = await api.request('POST', `/projects/${p.projectId}/approvals/${id}/approve`, { always: !!opts.always })
  info(`approved ${out.approval.action} (${id})${opts.always ? ' — policy set to allow' : ''}`)
}

export async function approvalsDeny(id: string): Promise<void> {
  const api = await ApiClient.load()
  const p = await requireProject()
  const out = await api.request('POST', `/projects/${p.projectId}/approvals/${id}/deny`)
  info(`denied ${out.approval.action} (${id})`)
}

export async function policyGet(opts: { json?: boolean }): Promise<void> {
  const api = await ApiClient.load()
  const p = await requireProject()
  const { policy } = await api.request('GET', `/projects/${p.projectId}/policy`)
  if (opts.json) return printJson(policy)
  for (const [action, decision] of Object.entries(policy)) info(`${action}: ${decision}`)
}

export async function policySet(action: string, decision: string): Promise<void> {
  const api = await ApiClient.load()
  const p = await requireProject()
  await api.request('PUT', `/projects/${p.projectId}/policy/${action}`, { decision })
  info(`policy ${action} = ${decision}`)
}
