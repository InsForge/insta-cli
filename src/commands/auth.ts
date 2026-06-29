import { ApiClient, linkedProject } from '../api.js'
import { info, die, printJson, promptPassword } from '../util.js'

export async function login(opts: { email?: string; password?: string; apiUrl?: string }): Promise<void> {
  const api = await ApiClient.load()
  if (opts.apiUrl) api.setApiUrl(opts.apiUrl)
  if (!opts.email) die('--email is required')
  const password = opts.password ?? process.env.INSTA_PASSWORD ?? (await promptPassword())
  const res = await api.request('POST', '/auth/login', { email: opts.email, password }, { auth: false })
  api.setSession(res, res.user)
  await api.persist()
  info(`logged in as ${res.user.email ?? res.user.id} @ ${api.apiUrl}`)
}

export async function logout(): Promise<void> {
  const api = await ApiClient.load()
  if (api.config.refreshToken) {
    try { await api.request('POST', '/auth/logout', { refreshToken: api.config.refreshToken }, { auth: false }) } catch { /* ignore */ }
  }
  api.clearSession()
  await api.persist()
  info('logged out')
}

export async function status(opts: { json?: boolean }): Promise<void> {
  const api = await ApiClient.load()
  let user: any = null
  try { user = (await api.request('GET', '/me')).user } catch { /* not logged in */ }
  const project = await linkedProject()
  if (opts.json) return printJson({ apiUrl: api.apiUrl, user, project })
  info(`api:     ${api.apiUrl}`)
  info(`user:    ${user ? (user.email ?? user.id) : '(not logged in)'}`)
  info(`project: ${project ? `${project.projectId} (branch ${project.branch})` : '(none linked)'}`)
}
