// Thin API client over the platform control-plane. Handles bearer auth + one-shot refresh on 401.
// 2xx (including 202 approval_required) returns the parsed body; >=400 throws ApiError.
import { readGlobal, writeGlobal, readProject, writeProject, type GlobalConfig, type ProjectConfig } from './config.js'
import { autoResolveProject, promptChoice, type ProjectItem } from './resolve-project.js'
import { die, info } from './util.js'

export class ApiError extends Error {
  constructor(public status: number, msg: string) { super(msg); this.name = 'ApiError' }
}

type RawResult = { status: number; body: any }

export class ApiClient {
  constructor(private cfg: GlobalConfig) {}

  static async load(): Promise<ApiClient> { return new ApiClient(await readGlobal()) }

  get apiUrl(): string { return this.cfg.apiUrl }
  get config(): GlobalConfig { return this.cfg }

  async persist(): Promise<void> { await writeGlobal(this.cfg) }

  setApiUrl(url: string): void { this.cfg.apiUrl = url }

  setSession(tokens: { accessToken: string; refreshToken: string }, user?: GlobalConfig['user']): void {
    this.cfg.accessToken = tokens.accessToken
    this.cfg.refreshToken = tokens.refreshToken
    if (user) this.cfg.user = user
  }

  clearSession(): void {
    delete this.cfg.accessToken
    delete this.cfg.refreshToken
    delete this.cfg.user
  }

  // Returns parsed body for status < 400 (incl. 202); throws ApiError otherwise.
  async request<T = any>(method: string, path: string, body?: unknown, opts: { auth?: boolean } = {}): Promise<T> {
    const res = await this.raw(method, path, body, opts.auth ?? true)
    if (res.status >= 400) throw new ApiError(res.status, res.body?.error ?? `HTTP ${res.status}`)
    return res.body as T
  }

  // Like request but returns {status, body} so callers can branch on 202 (approval_required).
  async rawRequest(method: string, path: string, body?: unknown, opts: { auth?: boolean } = {}): Promise<RawResult> {
    const res = await this.raw(method, path, body, opts.auth ?? true)
    if (res.status >= 400) throw new ApiError(res.status, res.body?.error ?? `HTTP ${res.status}`)
    return res
  }

  private async raw(method: string, path: string, body: unknown, auth: boolean): Promise<RawResult> {
    let r = await this.fetch(method, path, body, auth)
    if (r.status === 401 && auth && this.cfg.refreshToken) {
      if (await this.refresh()) r = await this.fetch(method, path, body, auth)
    }
    return r
  }

  private async fetch(method: string, path: string, body: unknown, auth: boolean): Promise<RawResult> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json', 'Insta-Hints': '1' }
    if (auth && this.cfg.accessToken) headers.Authorization = `Bearer ${this.cfg.accessToken}`
    const res = await fetch(this.apiUrl + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const text = await res.text()
    let parsed: any = null
    try { parsed = text ? JSON.parse(text) : null } catch { parsed = { raw: text } }
    return { status: res.status, body: parsed }
  }

  private async refresh(): Promise<boolean> {
    try {
      const res = await this.fetch('POST', '/auth/refresh', { refreshToken: this.cfg.refreshToken }, false)
      if (res.status >= 400) return false
      this.cfg.accessToken = res.body.accessToken
      this.cfg.refreshToken = res.body.refreshToken
      await this.persist()
      return true
    } catch {
      return false
    }
  }
}

// Resolve the linked project (./.insta/project.json), or null.
export async function linkedProject(): Promise<ProjectConfig | null> { return readProject() }

// Resolve the linked project or exit with guidance.
export async function requireProject(): Promise<ProjectConfig> {
  const p = await readProject()
  if (p) return p
  // One command, just works: unlinked ≠ error. Resolve the project (auto when there's one,
  // one-keystroke picker when several) and persist the choice so this happens once per dir.
  const api = await ApiClient.load()
  try {
    const orgs = (await api.request<{ orgs: Array<{ id: string }> }>('GET', '/orgs')).orgs
    const orgId = orgs[0]?.id ?? 'local'
    return await autoResolveProject(orgId, {
      listProjects: async () =>
        (await api.request<{ projects: ProjectItem[] }>('GET', `/orgs/${orgId}/projects`)).projects,
      promptChoice,
      save: async (c) => {
        await writeProject(c)
        info(`auto-linked project ${c.projectId} → ./.insta/project.json`)
      },
      tty: !!process.stdin.isTTY && !!process.stderr.isTTY,
    })
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) {
      die('not logged in — run `insta login --oauth github` (cloud) or point INSTA_API_URL at your insta-oss daemon')
    }
    die(e instanceof Error ? e.message : String(e))
  }
}
