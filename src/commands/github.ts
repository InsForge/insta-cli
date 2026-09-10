import { ApiClient, requireProject } from '../api.js'
import { info, printJson } from '../util.js'
import { resolveSoleService, parsePort, q } from './services.js'

export type RepoRef = { owner: string; repo: string }

export function parseRepoRef(raw: string): RepoRef {
  const s = raw.trim().replace(/^https?:\/\//i, '').replace(/^(www\.)?github\.com\//i, '').replace(/\/+$/, '').replace(/\.git$/i, '')
  const m = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(s)
  if (!m) throw new Error(`not a GitHub repository reference: ${raw} (use owner/repo or https://github.com/owner/repo)`)
  return { owner: m[1]!, repo: m[2]! }
}

export type Candidate = { rootDir: string | null; builder: string; buildCommand: string | null; startCommand: string | null; port: number }

// "", ".", "/", "./" all mean the repo root, which the platform spells null.
function normalizeRootDir(raw?: string): string | null {
  if (raw === undefined) return null
  const s = raw.trim().replace(/^\.\//, '').replace(/^\/+/, '').replace(/\/+$/, '')
  return s === '' || s === '.' ? null : s
}

export function pickCandidate(candidates: Candidate[], rootDir?: string): Candidate {
  if (candidates.length === 0) throw new Error('no deployable service detected in this repository (no Dockerfile and nothing nixpacks recognises)')
  if (rootDir !== undefined) {
    const want = normalizeRootDir(rootDir)
    const hit = candidates.find((c) => c.rootDir === want)
    if (!hit) throw new Error(`no deployable directory at ${want ?? '(repo root)'} — detected: ${candidates.map((c) => c.rootDir ?? '(repo root)').join(', ')}`)
    return hit
  }
  if (candidates.length === 1) return candidates[0]!
  throw new Error([
    `this repository has ${candidates.length} deployable directories; pass --root-dir to choose which one deploys into the service:`,
    ...candidates.map((c) => `  ${(c.rootDir ?? '(repo root)').padEnd(24)} ${c.builder}${c.startCommand ? `  start: ${c.startCommand}` : ''}`),
  ].join('\n'))
}

export type ConnectSource =
  | { source: 'app'; installationId: number; repoId: number; owner: string; repo: string }
  | { source: 'public'; owner: string; repo: string }

export type ConnectOpts = { public?: boolean; rootDir?: string; port?: string; branch?: string; repoBranch?: string; autoDeploy?: boolean; watchPaths?: string; json?: boolean }

// A comma-separated list, because a shell would glob an unquoted `apps/web/**` into filenames — which
// also means a pattern containing a comma cannot be expressed. The server does the validation.
export function parseWatchPaths(raw: string): string[] {
  const out = raw.split(',').map((p) => p.trim()).filter(Boolean)
  if (!out.length) throw new Error("watch paths need at least one pattern, e.g. 'apps/web/**,packages/ui/**' (quote them, or the shell expands the *)")
  return out
}

// Build/start come from detection only: the platform's nixpacks lane fails a build whose commands differ from it.
// autoDeploy rides along only when switched off: a public repo 400s on autoDeploy: true.
export function sourceBody(src: ConnectSource, c: Candidate, o: ConnectOpts) {
  const repo = src.source === 'app'
    ? { installationId: src.installationId, repoId: src.repoId, owner: src.owner, repo: src.repo }
    : { public: true, owner: src.owner, repo: src.repo }
  return {
    ...repo,
    rootDir: c.rootDir,
    buildCommand: c.buildCommand,
    startCommand: c.startCommand,
    port: o.port !== undefined ? parsePort(o.port) : c.port,
    ...(o.repoBranch ? { branch: o.repoBranch } : {}),
    ...(o.autoDeploy === false ? { autoDeploy: false } : {}),
    ...(o.watchPaths !== undefined ? { watchPaths: parseWatchPaths(o.watchPaths) } : {}),
  }
}

export type SourceView =
  | { type: 'image'; image: string | null }
  | { type: 'github'; owner: string; repo: string; branch: string; root_dir: string | null; auto_deploy: boolean; public: boolean; watch_paths?: string[] | null }

// Named as repo-root paths wherever it is printed: every line that carries this also carries root_dir,
// which the patterns are NOT relative to.
export function watchPathsClause(paths: readonly string[]): string {
  return `, but only when a push changes these repo-root paths: ${paths.join(', ')}`
}

export function repoLine(serviceName: string, s: SourceView): string {
  if (s.type !== 'github') return `compute ${serviceName}: no repository connected${s.image ? ` (runs image ${s.image})` : ''} — connect one with \`insta compute connect-repo <owner/repo> ${serviceName}\``
  const how = s.public
    ? 'public repo, deploys are manual (pushes do not redeploy)'
    : s.auto_deploy ? `every push to ${s.branch} redeploys it` : 'auto-deploy off (pushes do not redeploy)'
  const where = s.root_dir ? ` (${s.root_dir}/)` : ''
  const only = !s.watch_paths?.length ? ''
    : s.auto_deploy ? watchPathsClause(s.watch_paths)
    : `; watch paths ${s.watch_paths.join(', ')} are stored but cannot apply`
  return `compute ${serviceName}: deploys from ${s.owner}/${s.repo}@${s.branch}${where} — ${how}${only}`
}

type InstallationRow = { installation_id: string; account_login?: string }
type RepoRow = { id: number; owner: string; repo: string }

export async function findInstalledRepo(api: ApiClient, orgId: string, ref: RepoRef): Promise<{ installationId: number; repoId: number }> {
  if (!orgId) throw new Error('this directory is linked without an org — set INSTA_ORG_ID alongside INSTA_PROJECT_ID, or link it with `insta project link`')
  const { installations = [] } = await api.request<{ installations?: InstallationRow[] }>('GET', `/github/installations?orgId=${encodeURIComponent(orgId)}`)
  if (installations.length === 0) {
    throw new Error('no GitHub App installation for this org — connect GitHub in the console first (Add Service → GitHub Repo → Connect GitHub), or pass --public for a public repository')
  }
  for (const inst of installations) {
    const { repos = [] } = await api.request<{ repos?: RepoRow[] }>('GET', `/github/installations/${encodeURIComponent(inst.installation_id)}/repos?orgId=${encodeURIComponent(orgId)}`)
    const hit = repos.find((r) => r.owner.toLowerCase() === ref.owner.toLowerCase() && r.repo.toLowerCase() === ref.repo.toLowerCase())
    if (hit) return { installationId: Number(inst.installation_id), repoId: hit.id }
  }
  const accounts = installations.map((i) => i.account_login ?? i.installation_id).join(', ')
  throw new Error(`${ref.owner}/${ref.repo} is not visible to the org's GitHub App installation (installed on: ${accounts}) — grant the App access to it in the console (Configure GitHub app), or pass --public for a public repository`)
}

async function targetService(api: ApiClient, projectId: string, branch: string | undefined, serviceName: string | undefined) {
  const { services } = await api.request('GET', `/projects/${projectId}/services${q(branch)}`)
  return resolveSoleService<{ id: string; type: string; name: string }>(services, 'compute', serviceName)
}

export async function computeRepo(serviceName: string | undefined, opts: { branch?: string; json?: boolean }): Promise<void> {
  const api = await ApiClient.load()
  const p = await requireProject()
  const branch = opts.branch ?? p.branch
  const svc = await targetService(api, p.projectId, branch, serviceName)
  // insta-oss keys compute ids per group, not per branch, so the read carries the branch (the cloud ignores it).
  const { source } = await api.request<{ source: SourceView }>('GET', `/projects/${p.projectId}/services/${svc.id}/source${q(branch)}`)
  if (opts.json) return printJson({ service: { id: svc.id, name: svc.name }, source })
  info(repoLine(svc.name, source))
}

export async function computeConnectRepo(rawRef: string, serviceName: string | undefined, opts: ConnectOpts): Promise<void> {
  const ref = parseRepoRef(rawRef)
  const api = await ApiClient.load()
  const p = await requireProject()
  const svc = await targetService(api, p.projectId, opts.branch ?? p.branch, serviceName)
  const src: ConnectSource = opts.public
    ? { source: 'public', ...ref }
    : { source: 'app', ...(await findInstalledRepo(api, p.orgId, ref)), ...ref }
  // Detection must scan the branch that will be built: the build refuses commands that differ from what it detects there.
  const detected = await api.request<{ services: Candidate[] }>('POST', `/projects/${p.projectId}/github/detect`, { ...src, ...(opts.repoBranch ? { ref: opts.repoBranch } : {}) })
  const candidate = pickCandidate(detected.services, opts.rootDir)
  const res = await api.request<{ source: Extract<SourceView, { type: 'github' }>; build: { buildId: string; queued: boolean } }>('PUT', `/projects/${p.projectId}/services/${svc.id}/source`, sourceBody(src, candidate, opts))
  if (opts.json) return printJson({ ...res, service: { id: svc.id, name: svc.name } })
  const branch = res.source.branch
  const where = candidate.rootDir ? `${candidate.rootDir}/, ${candidate.builder}` : candidate.builder
  const now = res.build.queued ? `building ${branch} now` : `${branch} is already live at this commit`
  // From the server's answer, not from the flag: what it stored is what a push is matched against.
  const filtered = res.source.watch_paths?.length ? watchPathsClause(res.source.watch_paths) : ''
  const how = src.source === 'public' ? 'deploys are manual from here: pushes will not redeploy (public repo)'
    : opts.autoDeploy === false ? 'auto-deploy is off: redeploy with `insta compute connect-repo` again or from the console'
    : `every push to ${branch} redeploys it${filtered}`
  info(`connected ${ref.owner}/${ref.repo} → compute ${svc.name} (${where}): ${now} — ${how}`)
}

// Do not reconnect to change these: watch paths do not change what a build produces, and `connect-repo`
// would rebuild the service.
export async function computeWatchPaths(serviceName: string | undefined, opts: { set?: string; clear?: boolean; branch?: string; json?: boolean }): Promise<void> {
  if (opts.set !== undefined && opts.clear) throw new Error('pass --set or --clear, not both')
  const patch = opts.clear ? { watchPaths: null } : opts.set !== undefined ? { watchPaths: parseWatchPaths(opts.set) } : null
  const api = await ApiClient.load()
  const p = await requireProject()
  const branch = opts.branch ?? p.branch
  const svc = await targetService(api, p.projectId, branch, serviceName)
  const url = `/projects/${p.projectId}/services/${svc.id}/source${q(branch)}`
  const { source } = patch
    ? await api.request<{ source: SourceView }>('PATCH', url, patch)
    : await api.request<{ source: SourceView }>('GET', url)
  if (opts.json) return printJson({ service: { id: svc.id, name: svc.name }, source })
  info(patch ? `updated — ${repoLine(svc.name, source)}` : repoLine(svc.name, source))
}

export async function computeDisconnectRepo(serviceName: string | undefined, opts: { branch?: string; json?: boolean }): Promise<void> {
  const api = await ApiClient.load()
  const p = await requireProject()
  const svc = await targetService(api, p.projectId, opts.branch ?? p.branch, serviceName)
  const res = await api.request<{ ok: boolean; source: SourceView }>('DELETE', `/projects/${p.projectId}/services/${svc.id}/source`)
  if (opts.json) return printJson({ ...res, service: { id: svc.id, name: svc.name } })
  info(`disconnected the repository from compute ${svc.name} — it keeps running its current image; pushes no longer deploy it`)
}
