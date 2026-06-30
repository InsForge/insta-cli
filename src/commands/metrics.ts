import { ApiClient, requireProject } from '../api.js'
import { info, printJson } from '../util.js'

function qs(params: Record<string, string | undefined>): string {
  const u = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') u.set(k, String(v))
  const s = u.toString()
  return s ? `?${s}` : ''
}

// insta metrics <db|compute> [group]
export async function metrics(component: string, group: string | undefined, opts: { branch?: string; from?: string; to?: string; step?: string; json?: boolean }): Promise<void> {
  const api = await ApiClient.load()
  const p = await requireProject()
  const res = await api.request('GET', `/projects/${p.projectId}/metrics${qs({ component, group, branch: opts.branch ?? p.branch, from: opts.from, to: opts.to, step: opts.step })}`)
  if (opts.json) return printJson(res)
  if (res.note) info(`note: ${res.note}`)
  if (!res.series?.length) return info('(no series)')
  for (const s of res.series) {
    const last = s.points?.[s.points.length - 1]
    info(`${s.name}${s.unit ? ` (${s.unit})` : ''}: ${last ? last[1] : 'n/a'}  [${s.points?.length ?? 0} points]`)
  }
}

// insta usage — aggregated usage by meter over a window
export async function usage(opts: { from?: string; to?: string; json?: boolean }): Promise<void> {
  const api = await ApiClient.load()
  const p = await requireProject()
  const res = await api.request('GET', `/projects/${p.projectId}/usage${qs({ from: opts.from, to: opts.to })}`)
  if (opts.json) return printJson(res)
  info(`usage ${new Date(res.from * 1000).toISOString().slice(0, 10)} → ${new Date(res.to * 1000).toISOString().slice(0, 10)}`)
  if (!res.usage?.length) return info('(no usage recorded)')
  let total = 0
  for (const u of res.usage) {
    const dims = u.dimensions && Object.keys(u.dimensions).length ? ` ${JSON.stringify(u.dimensions)}` : ''
    const cost = u.costUsd != null ? `  ($${Number(u.costUsd).toFixed(4)})` : ''
    total += Number(u.costUsd ?? 0)
    info(`${u.meter}${dims}: ${u.quantity} ${u.unit}${cost}`)
  }
  info(`total: $${total.toFixed(4)}`)
}

// insta logs <db|compute> [group]
export async function logs(component: string, group: string | undefined, opts: { branch?: string; limit?: string; region?: string; instance?: string; json?: boolean }): Promise<void> {
  const api = await ApiClient.load()
  const p = await requireProject()
  const res = await api.request('GET', `/projects/${p.projectId}/logs${qs({ component, group, branch: opts.branch ?? p.branch, limit: opts.limit, region: opts.region, instance: opts.instance })}`)
  if (opts.json) return printJson(res)
  if (res.note) info(`note: ${res.note}`)
  if (!res.lines?.length) return info('(no logs)')
  for (const l of res.lines) info(`${l.ts}  ${(l.level ?? '').padEnd(5)} ${l.message}`)
}
