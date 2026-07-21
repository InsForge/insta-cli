import { writeFile } from 'node:fs/promises'
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ApiClient, requireProject } from '../api.js'
import { info, printJson, serializeEnv, handleApproval, die } from '../util.js'

function q(branch?: string): string {
  return branch ? `?branch=${encodeURIComponent(branch)}` : ''
}

// Fetch the credential bundle (the secret seam) and write it to .env (or print).
export async function secrets(opts: { branch?: string; output?: string; print?: boolean; json?: boolean }): Promise<void> {
  const api = await ApiClient.load()
  const p = await requireProject()
  const branch = opts.branch ?? p.branch
  const res = await api.rawRequest('GET', `/projects/${p.projectId}/secrets${q(branch)}`)
  if (handleApproval(res)) return
  const bundle: Record<string, string> = res.body.secrets
  if (opts.json) return printJson(bundle)
  if (opts.print) { process.stdout.write(serializeEnv(bundle)); return }
  const out = opts.output ?? '.env'
  await writeFile(out, serializeEnv(bundle))
  info(`wrote ${Object.keys(bundle).length} secrets to ${out} (branch ${branch})`)
  if (ensureIgnored(process.cwd(), out)) info(`  .gitignore += ${out} (credentials must never be committed)`)
  info('  tip: `insta run -- <cmd>` injects these per-run with nothing written to disk')
}

// Shape of GET /secrets/tree: the whole binding picture — project-wide secrets, then per-branch
// service groupings plus any branch-level (unbound) secrets.
type Tree = {
  projectWide: string[]
  branches: { name: string; isDefault: boolean; services: { type: string; name: string; secrets: string[] }[]; unbound: string[] }[]
}

// Render one branch's service-grouped secrets, then its unbound (branch-level) secrets.
function renderBranch(b: Tree['branches'][number]): void {
  for (const s of b.services) if (s.secrets.length) { info(`  ${s.type}/${s.name}`); for (const n of s.secrets) info(`    ${n}`) }
  if (b.unbound.length) { info('  (branch-level)'); for (const n of b.unbound) info(`    ${n}`) }
}

// Show the full binding tree: project-wide, then every branch grouped by service.
export async function secretsTree(opts: { json?: boolean }): Promise<void> {
  const api = await ApiClient.load()
  const p = await requireProject()
  const res = await api.rawRequest('GET', `/projects/${p.projectId}/secrets/tree`)
  if (handleApproval(res)) return
  const tree: Tree = res.body
  if (opts.json) return printJson(tree)
  if (tree.projectWide.length) { info('(project-wide)'); for (const n of tree.projectWide) info(`  ${n}`) }
  for (const b of tree.branches) { info(`${b.name}${b.isDefault ? ' *' : ''}`); renderBranch(b) }
}

// List secret names for the current (or given) branch, grouped by service.
export async function secretsList(opts: { branch?: string; json?: boolean }): Promise<void> {
  const api = await ApiClient.load()
  const p = await requireProject()
  const branch = opts.branch ?? p.branch
  const res = await api.rawRequest('GET', `/projects/${p.projectId}/secrets/tree`)
  if (handleApproval(res)) return
  const tree: Tree = res.body
  const b = tree.branches.find((x) => x.name === branch)
  if (opts.json) return printJson({ projectWide: tree.projectWide, branch: b })
  if (tree.projectWide.length) { info('(project-wide)'); for (const n of tree.projectWide) info(`  ${n}`) }
  if (b) { info(`${b.name}`); renderBranch(b) }
}

async function readStdin(): Promise<string> {
  let data = ''
  for await (const chunk of process.stdin) data += chunk
  return data.trim()
}

// Set a user secret. Project-wide by default; --branch scopes it to one branch. --service binds
// it to a branch service instead, which implies the current branch (binding requires one). Value
// comes from the argument, or stdin when omitted (keeps secret values out of shell history).
export async function secretsSet(name: string, value: string | undefined, opts: { branch?: string; service?: string }): Promise<void> {
  const api = await ApiClient.load()
  const p = await requireProject()
  const v = value ?? (await readStdin())
  if (!v) die('value is required (pass as an argument or on stdin)')
  const branch = opts.service ? (opts.branch ?? p.branch) : opts.branch
  const payload: Record<string, string> = { value: v, ...(branch ? { branch } : {}), ...(opts.service ? { service: opts.service } : {}) }
  const res = await api.rawRequest('PUT', `/projects/${p.projectId}/secrets/${encodeURIComponent(name)}`, payload)
  if (handleApproval(res)) return
  info(`set ${name}${opts.service ? ` → ${opts.service}` : ''} (${branch ? `branch ${branch}` : 'project-wide'})`)
}

export async function secretsUnset(name: string, opts: { branch?: string }): Promise<void> {
  const api = await ApiClient.load()
  const p = await requireProject()
  const qs = opts.branch ? `?branch=${encodeURIComponent(opts.branch)}` : ''
  const res = await api.rawRequest('DELETE', `/projects/${p.projectId}/secrets/${encodeURIComponent(name)}${qs}`)
  if (handleApproval(res)) return
  info(`unset ${name} (${opts.branch ? `branch ${opts.branch}` : 'project-wide'})`)
}

/** Gitignore the env file we just wrote (git repos only; idempotent). Returns true if added. */
export function ensureIgnored(cwd: string, name: string): boolean {
  if (!existsSync(join(cwd, '.git'))) return false
  const gi = join(cwd, '.gitignore')
  const current = existsSync(gi) ? readFileSync(gi, 'utf8') : ''
  if (current.split('\n').some((l) => l.trim() === name)) return false
  appendFileSync(gi, (current.endsWith('\n') || current === '' ? '' : '\n') + name + '\n')
  return true
}
