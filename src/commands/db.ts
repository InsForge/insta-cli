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
