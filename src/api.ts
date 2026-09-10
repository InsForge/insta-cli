// Thin API client over the platform control-plane. Handles bearer auth + one-shot refresh on 401.
// 2xx (including 202 approval_required) returns the parsed body; >=400 throws ApiError.
import { readGlobal, writeGlobal, readProject, writeProject, type GlobalConfig, type ProjectConfig } from './config.js'
import { autoResolveProject, promptChoice, type ProjectItem } from './resolve-project.js'
import { die } from './util.js'
import { USER_AGENT } from './version.js'
import { agentHeaders, agentMode } from './agent.js'
import { describeTarget, failureReason, hostOf, targetLines } from './target.js'

/** Extra lines an error carries under its first line: which host answered (or did not), and what
 *  pointed the CLI there. Attached at throw time, where the target is known; index.ts prints them. */
export type ErrorContext = string[]

export class ApiError extends Error {
  // body carries the parsed error payload for callers that branch on machine-readable errors
  // (e.g. template deploy's missing_variables); the message stays the human line.
  constructor(public status: number, msg: string, public body?: any, public context?: ErrorContext) { super(msg); this.name = 'ApiError' }
}

/** The request never got an answer: DNS, TCP, TLS, or a timeout.
 *
 *  undici collapses all of those into `TypeError: fetch failed`, which the CLI printed verbatim —
 *  no host, no reason, no hint that the target was not the cloud. This names the host it tried and
 *  why it failed, and keeps the original as `cause` so telemetry still lifts `cause.code`. */
export class NetworkError extends Error {
  constructor(public url: string, cause: unknown, public context?: ErrorContext) {
    const reason = failureReason(cause)
    super(`cannot reach ${hostOf(url)}${reason ? ` (${reason})` : ''}`)
    this.name = 'NetworkError'
    this.cause = cause
  }
}
export class AgentApprovalRequired extends Error {
  constructor(public body: any) { super(body.message ?? `approval required: ${body.approvalId}`) }
}

// Store a durable insta_ key as the credential: set it as the bearer and drop any refresh token (an insta_ key never rotates; a stale one would leak to /auth/refresh on a 401).
export function storeApiKeyCredential(cfg: GlobalConfig, token: string, user?: GlobalConfig['user']): void {
  cfg.accessToken = token
  delete cfg.refreshToken
  if (user) cfg.user = user
}

type RawResult = { status: number; body: any }

export class ApiClient {
  constructor(private cfg: GlobalConfig, private readonly fetchImpl: typeof fetch = fetch) {}

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

  // Adopt a durable insta_ key as the credential (non-interactive `login --api-key`).
  setApiKey(token: string, user?: GlobalConfig['user']): void {
    storeApiKeyCredential(this.cfg, token, user)
  }

  clearSession(): void {
    delete this.cfg.accessToken
    delete this.cfg.refreshToken
    delete this.cfg.user
  }

  // Returns parsed body for status < 400 (incl. 202); throws ApiError otherwise.
  async request<T = any>(method: string, path: string, body?: unknown, opts: { auth?: boolean } = {}): Promise<T> {
    const res = await this.raw(method, path, body, opts.auth ?? true)
    if (agentMode() && res.status === 202 && res.body?.status === 'approval_required') throw new AgentApprovalRequired(res.body)
    if (res.status >= 400) throw new ApiError(res.status, res.body?.error ?? `HTTP ${res.status}`, res.body, await this.targetContext())
    return res.body as T
  }

  // Like request but returns {status, body} so callers can branch on 202 (approval_required).
  async rawRequest(method: string, path: string, body?: unknown, opts: { auth?: boolean } = {}): Promise<RawResult> {
    const res = await this.raw(method, path, body, opts.auth ?? true)
    if (res.status >= 400) throw new ApiError(res.status, res.body?.error ?? `HTTP ${res.status}`, res.body, await this.targetContext())
    return res
  }

  // Computed once, and only on the failure path: a run that succeeds pays nothing, and the config
  // file is not re-read per error. Empty on the cloud default, so nothing is added to the common case.
  private noteCache?: ErrorContext
  private async targetContext(): Promise<ErrorContext> {
    if (!this.noteCache) {
      try { this.noteCache = targetLines(await describeTarget(this.apiUrl)) } catch { this.noteCache = [] }
    }
    return this.noteCache
  }

  private async raw(method: string, path: string, body: unknown, auth: boolean): Promise<RawResult> {
    let r = await this.fetch(method, path, body, auth)
    if (r.status === 401 && auth && this.cfg.refreshToken) {
      if (await this.refresh()) r = await this.fetch(method, path, body, auth)
    }
    return r
  }

  private async fetch(method: string, path: string, body: unknown, auth: boolean): Promise<RawResult> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json', 'Insta-Hints': '1', 'User-Agent': USER_AGENT }
    if (auth && this.cfg.accessToken) headers.Authorization = `Bearer ${this.cfg.accessToken}`
    if (auth) Object.assign(headers, await agentHeaders(this, method, path, body === undefined ? '' : JSON.stringify(body)))
    let res: Response
    try {
      res = await this.fetchImpl(this.apiUrl + path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      })
    } catch (e) {
      // A transport failure, not an HTTP status: there is no response to parse and no 401 to
      // refresh past, so it goes straight out as a NetworkError naming the host and the setting.
      throw new NetworkError(this.apiUrl, (e as { cause?: unknown })?.cause ?? e, await this.targetContext())
    }
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
  if (agentMode()) die('agent mode requires a linked project — run `insta setup agent --project <id>`')
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
        // stderr: this is a diagnostic that can precede ANY command's output — under --json,
        // stdout must stay one parseable document.
        process.stderr.write(`auto-linked project ${c.projectId} → ./.insta/project.json\n`)
      },
      tty: !!process.stdin.isTTY && !!process.stderr.isTTY,
    })
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) {
      die('not logged in — run `insta login` (cloud) or point INSTA_API_URL at your insta-oss daemon')
    }
    die(e instanceof Error ? e.message : String(e))
  }
}
