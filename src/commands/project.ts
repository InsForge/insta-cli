import { createInterface } from 'node:readline/promises'
import { ApiClient, requireProject } from '../api.js'
import { writeProject } from '../config.js'
import { info, die, printJson, handleApproval, renderNextActions } from '../util.js'
import { installObserve } from '../observe/install.js'
import { installSkills } from '../ensure-skills.js'

// Interactive name prompt (stderr, so piped stdout stays clean). Enter accepts the default.
async function promptName(question: string, def: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr })
  try { return (await rl.question(`${question} [${def}]: `)).trim() } finally { rl.close() }
}

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

/** Name resolution so the recommended one-liner (`insta project create`, no arg) is paste-and-run:
 *  explicit arg wins; else prompt with the cwd basename as default (TTY); else use the basename. */
export async function resolveProjectName(
  nameArg: string | undefined,
  cwd = process.cwd(),
  prompt?: (question: string, def: string) => Promise<string>,
): Promise<string> {
  const fromDir = slugifyName(cwd.split('/').filter(Boolean).pop() ?? 'app') || 'app'
  if (nameArg) return slugifyName(nameArg)
  if (prompt && process.stdin.isTTY) return slugifyName((await prompt('project name', fromDir)) || fromDir) || fromDir
  return fromDir
}

export async function projectCreate(name: string | undefined, opts: { org?: string }): Promise<void> {
  const api = await ApiClient.load()
  const orgId = await resolveOrg(api, opts.org)
  const resolved = await resolveProjectName(name, process.cwd(), promptName)
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
