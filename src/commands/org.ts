import { ApiClient } from '../api.js'
import { info, printJson } from '../util.js'

export async function orgList(opts: { json?: boolean }): Promise<void> {
  const api = await ApiClient.load()
  const { orgs } = await api.request('GET', '/orgs')
  if (opts.json) return printJson(orgs)
  for (const o of orgs) info(`${o.id}  ${o.name}${o.is_personal ? ' (personal)' : ''}  [${o.role}]`)
}

export async function orgCreate(name: string): Promise<void> {
  const api = await ApiClient.load()
  const { org } = await api.request('POST', '/orgs', { name })
  info(`created org ${org.id} (${org.name})`)
}
