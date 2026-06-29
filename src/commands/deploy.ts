import { ApiClient, requireProject } from '../api.js'
import { info, die, handleApproval } from '../util.js'

export async function deploy(opts: { image?: string; branch?: string; group?: string; port?: string }): Promise<void> {
  const api = await ApiClient.load()
  const p = await requireProject()
  if (!opts.image) die('--image is required')
  const res = await api.rawRequest('POST', `/projects/${p.projectId}/deploy`, {
    image: opts.image,
    branch: opts.branch ?? p.branch,
    group: opts.group,
    port: opts.port ? Number(opts.port) : undefined,
  })
  if (handleApproval(res)) return
  info(`deployed ${opts.image} -> ${res.body.url} (branch ${res.body.branch}, group ${res.body.group})`)
}
