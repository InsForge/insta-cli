import { homedir } from 'node:os'
import { ApiClient, requireProject } from '../api.js'
import { writeProject } from '../config.js'
import { info, die, printJson, handleApproval, renderNextActions } from '../util.js'
import { installObserve } from '../observe/install.js'
import { installSkills } from '../ensure-skills.js'

// Generic directory names that make a useless project name ("projects", "~", "tmp", …). When the
// cwd basename is one of these we DON'T invent a name — we guide the user to name it (or let their
// skill-equipped agent do it), rather than provisioning real resources under a junk name.
const GENERIC_DIRS = new Set([
  'projects', 'project', 'home', 'tmp', 'temp', 'desktop', 'documents', 'downloads',
  'src', 'source', 'code', 'dev', 'work', 'workspace', 'repos', 'repo', 'git',
  'app', 'apps', 'users', 'user', 'bin', 'new', 'test', 'tests',
])

// Best-effort: wire the credential-audit hook into the project (no-op if assets aren't built).
function tryInstallObserve(): void {
  try {
    const r = installObserve({ cwd: process.cwd() })
    if (r.claude || r.codex) info('  installed observe hook (credential audit) → ./.insta/observe')
  } catch { /* assets missing (dev/unbuilt) — skip silently */ }
}

async function resolveOrg(api: ApiClient, given?: string): Promise<string> {
  if (given) return given
  const { orgs } = await api.request('GET', '/orgs')
  if (!orgs.length) die('no org found — run `insta org create <name>`')
  return orgs[0].id
}

/** A valid project name from a raw string: lowercase, non-alnum → hyphen, trimmed. */
export function slugifyName(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)
}

/** Name resolution — NEVER prompts (a paste-and-run one-liner must not block on input). Returns
 *  the name to create, or `null` meaning "no sensible name; guide the user instead of inventing
 *  one". Explicit arg wins; else the cwd basename when it's a real project-dir name; else null
 *  (generic dir like ~/projects or /tmp, or the home dir itself). Agents pass a name via the skill,
 *  so null is only reached when a human runs bare `insta project create` somewhere generic. */
export function resolveProjectName(nameArg: string | undefined, cwd = process.cwd()): string | null {
  if (nameArg) return slugifyName(nameArg)
  const base = slugifyName(cwd.split('/').filter(Boolean).pop() ?? '')
  const home = slugifyName(homedir().split('/').filter(Boolean).pop() ?? '')
  if (base && base !== home && !GENERIC_DIRS.has(base)) return base
  return null
}

export async function projectCreate(name: string | undefined, opts: { org?: string }): Promise<void> {
  const resolved = resolveProjectName(name, process.cwd())
  if (!resolved) {
    // No name given and the cwd name is generic — don't provision resources under a junk name.
    // Guide instead (no hang, no error): name it explicitly, or just ask the skill-equipped agent.
    info('name your project:  insta project create <name>')
    info('  (or just ask your coding agent — it has the insta skill and will do this for you)')
    return
  }
  const api = await ApiClient.load()
  const orgId = await resolveOrg(api, opts.org)
  const out = await api.request('POST', `/orgs/${orgId}/projects`, { name: resolved })
  await writeProject({ projectId: out.project.id, orgId, branch: out.defaultBranch.name })
  info(`created project ${out.project.id} (${resolved})`)
  info(`  resources: ${out.resources.map((r: any) => r.kind).join(', ')}`)
  info(`  linked ./.insta/project.json (branch ${out.defaultBranch.name})`)
  renderNextActions(out.nextActions)
  tryInstallObserve()
  await installSkills({ cwd: process.cwd() })
}

export async function projectList(opts: { org?: string; json?: boolean }): Promise<void> {
  const api = await ApiClient.load()
  const orgId = await resolveOrg(api, opts.org)
  const { projects } = await api.request('GET', `/orgs/${orgId}/projects`)
  if (opts.json) return printJson(projects)
  if (!projects.length) return info('(no projects)')
  for (const p of projects) info(`${p.id}  ${p.name}  [${p.status}]`)
}

export async function projectLink(id: string): Promise<void> {
  const api = await ApiClient.load()
  const { project } = await api.request('GET', `/projects/${id}`)
  await writeProject({ projectId: project.id, orgId: project.org_id, branch: 'main' })
  info(`linked project ${project.id} (${project.name})`)
  tryInstallObserve()
  await installSkills({ cwd: process.cwd() })
}

export async function projectDelete(opts: { project?: string }): Promise<void> {
  const api = await ApiClient.load()
  const projectId = opts.project ?? (await requireProject()).projectId
  const res = await api.rawRequest('DELETE', `/projects/${projectId}`)
  if (handleApproval(res)) return
  info(`deleted project ${projectId}`)
}
