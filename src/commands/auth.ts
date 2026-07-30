import { createServer } from 'node:http'
import { randomBytes } from 'node:crypto'
import { ApiClient, linkedProject } from '../api.js'
import { ENVS, ENV_NAMES, envForApiUrl, isEnvName } from '../env.js'
import { info, die, printJson, promptPassword, openUrl } from '../util.js'

/** --api-url and --env both set the target host; --api-url wins (more specific), matching the
 *  INSTA_API_URL > INSTA_ENV precedence in config.ts. Returns the URL to point at, or undefined
 *  to leave whatever is already resolved alone. */
function targetApiUrl(opts: { apiUrl?: string; env?: string }): string | undefined {
  if (opts.apiUrl) return opts.apiUrl
  if (!opts.env) return undefined
  const want = opts.env.trim().toLowerCase()
  if (!isEnvName(want)) die(`unknown --env "${opts.env}" — expected one of: ${ENV_NAMES.join(', ')}`)
  return ENVS[want].api
}

export async function login(opts: { email?: string; password?: string; apiUrl?: string; env?: string; oauth?: string }): Promise<void> {
  if (opts.oauth) return loginOauth(opts.oauth, opts)
  const api = await ApiClient.load()
  const target = targetApiUrl(opts)
  if (target) api.setApiUrl(target)
  if (!opts.email) die('--email is required (or use --oauth <github|google>)')
  const password = opts.password ?? process.env.INSTA_PASSWORD ?? (await promptPassword())
  const res = await api.request('POST', '/auth/login', { email: opts.email, password }, { auth: false })
  api.setSession(res, res.user)
  await api.persist()
  info(`logged in as ${res.user.email ?? res.user.id} @ ${api.apiUrl}`)
}

// Browser OAuth (GitHub/Google) via a loopback listener. We open the platform's CLI-OAuth bridge,
// which runs Better Auth's social flow and bounces the resulting session token back to us.
export async function loginOauth(provider: string, opts: { apiUrl?: string; env?: string }): Promise<void> {
  if (provider !== 'github' && provider !== 'google') die('provider must be github or google')
  const api = await ApiClient.load()
  const target = targetApiUrl(opts)
  if (target) api.setApiUrl(target)
  const token = await browserOauth(api.apiUrl, provider)
  api.setSession({ accessToken: token, refreshToken: token })
  const me = await api.request<{ user: { id: string; email: string | null; name: string | null } }>('GET', '/me')
  api.setSession({ accessToken: token, refreshToken: token }, me.user)
  await api.persist()
  info(`logged in as ${me.user.email ?? me.user.id} @ ${api.apiUrl}`)
}

// Start a loopback server, open the browser at the platform bridge, and await the token.
function browserOauth(apiUrl: string, provider: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const state = randomBytes(16).toString('hex')
    let timer: NodeJS.Timeout
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      if (url.pathname !== '/callback') { res.writeHead(404); res.end(); return }
      const token = url.searchParams.get('token')
      const err = url.searchParams.get('error')
      const ok = !!token && !err && url.searchParams.get('state') === state
      res.writeHead(ok ? 200 : 400, { 'content-type': 'text/html' })
      res.end(`<!doctype html><meta charset=utf-8><body style="font-family:system-ui;text-align:center;margin-top:4rem"><h2>InstaCloud</h2><p>${ok ? '✓ Login complete — you can close this tab.' : '✗ Login failed' + (err ? ` (${err})` : '')}</p></body>`)
      clearTimeout(timer)
      server.close()
      if (err) return reject(new Error(`oauth failed: ${err}`))
      if (!token) return reject(new Error('no token returned'))
      if (url.searchParams.get('state') !== state) return reject(new Error('state mismatch — aborting'))
      resolve(token)
    })
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      const redirect = `http://127.0.0.1:${port}/callback`
      const authorizeUrl = `${apiUrl}/auth/cli/authorize?provider=${encodeURIComponent(provider)}&redirect=${encodeURIComponent(redirect)}&state=${state}`
      info(`opening browser to authorize with ${provider}…`)
      if (!openUrl(authorizeUrl)) info(`open this URL to continue:\n  ${authorizeUrl}`)
      timer = setTimeout(() => { server.close(); reject(new Error('timed out waiting for browser login (2m)')) }, 120_000)
    })
  })
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
  // Surface the environment name alongside the URL: "api: https://api.staging.instacloud.com" is
  // easy to skim past, and mistaking staging for prod is the mistake worth making loud.
  const env = envForApiUrl(api.apiUrl)
  if (opts.json) return printJson({ env, apiUrl: api.apiUrl, user, project })
  info(`env:     ${env ?? '(custom)'}`)
  info(`api:     ${api.apiUrl}`)
  info(`user:    ${user ? (user.email ?? user.id) : '(not logged in)'}`)
  info(`project: ${project ? `${project.projectId} (branch ${project.branch})` : '(none linked)'}`)
}
