import { ApiClient, requireProject } from '../api.js'
import { writeProject } from '../config.js'
import { info, die, printJson, handleApproval, renderNextActions } from '../util.js'

export async function branchCreate(name: string, opts: { from?: string }): Promise<void> {
  const api = await ApiClient.load()
  const p = await requireProject()
  const out = await api.request('POST', `/projects/${p.projectId}/branches`, { name, from: opts.from ?? p.branch })
  info(`created branch ${out.branch.name} (${out.branch.id})`)
  renderNextActions(out.nextActions)
}

export async function branchList(opts: { json?: boolean }): Promise<void> {
  const api = await ApiClient.load()
  const p = await requireProject()
  const { branches } = await api.request('GET', `/projects/${p.projectId}/branches`)
  if (opts.json) return printJson(branches)
  for (const b of branches) info(`${b.is_default ? '*' : ' '} ${b.name}  [${b.status}]  ${b.id}`)
}

export async function branchSwitch(name: string): Promise<void> {
  const api = await ApiClient.load()
  const p = await requireProject()
  const { branches } = await api.request('GET', `/projects/${p.projectId}/branches`)
  if (!branches.some((b: any) => b.name === name)) die(`branch not found: ${name}`)
  await writeProject({ ...p, branch: name })
  info(`switched to branch ${name} — run \`insta secrets\` to refresh .env`)
}

export async function branchDelete(name: string): Promise<void> {
  const api = await ApiClient.load()
  const p = await requireProject()
  const { branches } = await api.request('GET', `/projects/${p.projectId}/branches`)
  const b = branches.find((x: any) => x.name === name || x.id === name)
  if (!b) die(`branch not found: ${name}`)
  const res = await api.rawRequest('DELETE', `/projects/${p.projectId}/branches/${b.id}`)
  if (handleApproval(res)) return
  info(`deleted branch ${name}`)
}

// insta branch merge <source> [--into <target>] — structurally merge source's services into target
// (default target: current branch). No data is copied; existing services are left untouched.
export async function branchMerge(source: string, opts: { into?: string } = {}): Promise<void> {
  const api = await ApiClient.load()
  const p = await requireProject()
  const target = opts.into ?? p.branch
  if (!target) throw new Error('no target branch — pass --into <branch> (or link a branch first)')
  const res = await api.rawRequest('POST', `/projects/${p.projectId}/branches/${encodeURIComponent(target)}/merge`, { from: source })
  if (handleApproval(res)) return
  const { created = [], skipped = [] } = (res.body ?? {}) as {
    created?: Array<{ type: string; name: string }>
    skipped?: Array<{ type: string; name: string; reason: string }>
  }
  info(`merged ${source} → ${target}: ${created.length} created, ${skipped.length} skipped`)
  for (const c of created) info(`  + ${c.type}/${c.name}`)
  for (const s of skipped) info(`  = ${s.type}/${s.name} (${s.reason})`)
}
