import { ApiClient, requireProject } from '../api.js'
import { writeProject } from '../config.js'
import { info, die, printJson, handleApproval } from '../util.js'

async function resolveOrg(api: ApiClient, given?: string): Promise<string> {
  if (given) return given
  const { orgs } = await api.request('GET', '/orgs')
  if (!orgs.length) die('no org found — run `insta org create <name>`')
  return orgs[0].id
}

export async function projectCreate(name: string, opts: { org?: string }): Promise<void> {
  const api = await ApiClient.load()
  const orgId = await resolveOrg(api, opts.org)
  const out = await api.request('POST', `/orgs/${orgId}/projects`, { name })
  await writeProject({ projectId: out.project.id, orgId, branch: out.defaultBranch.name })
  info(`created project ${out.project.id} (${name})`)
  info(`  resources: ${out.resources.map((r: any) => r.kind).join(', ')}`)
  info(`  linked ./.insta/project.json (branch ${out.defaultBranch.name})`)
}

export async function projectList(opts: { org?: string; json?: boolean }): Promise<void> {
  const api = await ApiClient.load()
  const orgId = await resolveOrg(api, opts.org)
  const { projects } = await api.request('GET', `/orgs/${orgId}/projects`)
  if (opts.json) return printJson(projects)
  if (!projects.length) return info('(no projects)')
  for (const p of projects) info(`${p.id}  ${p.name}  [${p.status}]`)
}

export async function projectLink(id: string): Promise<void> {
  const api = await ApiClient.load()
  const { project } = await api.request('GET', `/projects/${id}`)
  await writeProject({ projectId: project.id, orgId: project.org_id, branch: 'main' })
  info(`linked project ${project.id} (${project.name})`)
}

export async function projectDelete(opts: { project?: string }): Promise<void> {
  const api = await ApiClient.load()
  const projectId = opts.project ?? (await requireProject()).projectId
  const res = await api.rawRequest('DELETE', `/projects/${projectId}`)
  if (handleApproval(res)) return
  info(`deleted project ${projectId}`)
}
