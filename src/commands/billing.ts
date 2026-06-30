import { ApiClient, requireProject } from '../api.js'
import { info, printJson } from '../util.js'

// insta billing — current cycle summary for the linked project's org.
export async function billing(opts: { json?: boolean }): Promise<void> {
  const api = await ApiClient.load()
  const p = await requireProject()
  const s = await api.request('GET', `/orgs/${p.orgId}/billing`)
  if (opts.json) return printJson(s)
  info(`tier:     ${s.tier}`)
  info(`status:   ${s.status}`)
  info(`cycle:    ${String(s.cycleStart).slice(0, 10)} → ${String(s.cycleEnd).slice(0, 10)}`)
  info(`included: $${Number(s.includedUsd).toFixed(2)}`)
  info(`used:     $${Number(s.usedUsd).toFixed(4)}`)
  info(`overage:  $${Number(s.overageUsd).toFixed(4)}`)
  if (s.status === 'suspended') info('⚠  org suspended — billing limit reached; resumes next cycle (or upgrade)')
}
