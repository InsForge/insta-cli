import { writeFile } from 'node:fs/promises'
import { ApiClient, requireProject } from '../api.js'
import { info, printJson, serializeEnv, handleApproval } from '../util.js'

function q(branch?: string): string {
  return branch ? `?branch=${encodeURIComponent(branch)}` : ''
}

// Fetch the credential bundle (the secret seam) and write it to .env (or print).
export async function secrets(opts: { branch?: string; output?: string; print?: boolean; json?: boolean }): Promise<void> {
  const api = await ApiClient.load()
  const p = await requireProject()
  const branch = opts.branch ?? p.branch
  const res = await api.rawRequest('GET', `/projects/${p.projectId}/secrets${q(branch)}`)
  if (handleApproval(res)) return
  const bundle: Record<string, string> = res.body.secrets
  if (opts.json) return printJson(bundle)
  if (opts.print) { process.stdout.write(serializeEnv(bundle)); return }
  const out = opts.output ?? '.env'
  await writeFile(out, serializeEnv(bundle))
  info(`wrote ${Object.keys(bundle).length} secrets to ${out} (branch ${branch})`)
}

export async function secretsList(opts: { branch?: string }): Promise<void> {
  const api = await ApiClient.load()
  const p = await requireProject()
  const branch = opts.branch ?? p.branch
  const res = await api.rawRequest('GET', `/projects/${p.projectId}/secrets${q(branch)}`)
  if (handleApproval(res)) return
  for (const name of Object.keys(res.body.secrets)) info(name)
}
