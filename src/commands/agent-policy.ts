import { ApiClient, requireProject } from '../api.js'
import { handleApproval, info, printJson } from '../util.js'

async function current() {
  const api = await ApiClient.load()
  const project = await requireProject()
  const path = `/projects/${project.projectId}/agent-policy`
  const out = await api.request('GET', path)
  return { api, project, path, ...out }
}
export async function get(opts: { json?: boolean }) {
  const { policy, agentSessionEpoch, actions } = await current()
  if (opts.json) return printJson({ policy, agentSessionEpoch, actions })
  info(`agent policy: ${policy.mode}\nprotected branches: ${policy.protectedBranchIds.join(', ') || '(none)'}\nsession epoch: ${agentSessionEpoch}`)
}
async function update(change: (policy: any, state: Awaited<ReturnType<typeof current>>) => Promise<void> | void, opts: { json?: boolean }) {
  const state = await current()
  await change(state.policy, state)
  const result = await state.api.rawRequest('PUT', state.path, state.policy)
  if (handleApproval(result, opts.json)) return
  if (opts.json) return printJson(result.body)
  info(`agent policy updated: ${result.body.policy.mode}`)
}
export async function set(mode: string, opts: { json?: boolean }) {
  const normalized = mode.replace(/-/g, '_')
  if (!['full_access', 'read_only', 'branch_developer'].includes(normalized)) throw new Error('mode must be full-access, read-only, or branch-developer')
  return update(policy => { policy.mode = normalized }, opts)
}
export async function protect(branch: string, enabled: boolean, opts: { json?: boolean }) {
  return update(async (policy, { api, project }) => {
    const { branches } = await api.request('GET', `/projects/${project.projectId}/branches`)
    const found = branches.find((b: any) => b.id === branch || b.name === branch)
    if (!found) throw new Error('branch not found')
    policy.protectedBranchIds = enabled ? [...new Set([...policy.protectedBranchIds, found.id])] : policy.protectedBranchIds.filter((id: string) => id !== found.id)
  }, opts)
}
export async function rule(action: string, decision: string, opts: { json?: boolean }) {
  if (!['allow', 'deny', 'approve'].includes(decision)) throw new Error('decision must be allow, deny, or approve')
  return update(policy => { policy.branchDeveloperRules[action] = decision }, opts)
}
export async function revoke(opts: { json?: boolean }) {
  const api = await ApiClient.load()
  const project = await requireProject()
  const out = await api.request('POST', `/projects/${project.projectId}/agent-sessions/revoke`)
  if (opts.json) return printJson(out)
  info(`all project agent sessions revoked (epoch ${out.agentSessionEpoch})`)
}
