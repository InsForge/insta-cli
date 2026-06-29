import { ApiClient, requireProject } from '../api.js'
import { info, printJson } from '../util.js'

// Agent-legible view of each environment's databases / storage / compute.
export async function manifest(opts: { json?: boolean }): Promise<void> {
  const api = await ApiClient.load()
  const p = await requireProject()
  const detail = await api.request('GET', `/projects/${p.projectId}`)
  if (opts.json) return printJson(detail)
  info(`project ${detail.project.name} (${detail.project.id}) [${detail.project.status}]`)
  for (const b of detail.branches) {
    info(`  branch ${b.name}${b.is_default ? ' *' : ''} [${b.status}]`)
    const rs = detail.resources.filter((r: any) => r.branchId === b.id || (b.is_default && r.branchId === null))
    for (const r of rs) {
      const where = r.ref?.url ?? r.ref?.bucket ?? r.ref?.neonProjectId ?? ''
      info(`    - ${r.kind}${r.name ? `(${r.name})` : ''}  ${where}  [${r.status}]`)
    }
  }
}
