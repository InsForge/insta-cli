// `insta template` — browse the platform template registry and deploy a template (by registry
// code, or from a local directory carrying insta.template.yaml) onto a branch. The deploy is a
// platform-side pipeline (create services → write variables → deploy → health check); the CLI
// submits it and renders progress by polling the deployment resource.
import { randomBytes } from 'node:crypto'
import { join, resolve } from 'node:path'
import { existsSync } from 'node:fs'
import * as clack from '@clack/prompts'
import { ApiClient, ApiError, requireProject } from '../api.js'
import { info, die, printJson, handleApproval, renderNextActions } from '../util.js'
import { MANIFEST_FILE, collectManifestVariables, loadTemplateManifest, type TemplateManifest, type TemplateVar } from '../template-manifest.js'

// ---- pure, unit-tested helpers ----

export type TemplateIndexEntry = {
  code: string; version: string; name: string; tagline?: string; category?: string
  requiredVarCount?: number; deployCount?: number
}

// One aligned row per template; numeric columns right-aligned. Plain padded columns, as the rest
// of the CLI (storage list, compute check-domain) — no table library.
export function templateListLines(templates: TemplateIndexEntry[]): string[] {
  if (!templates.length) return ['(no templates published yet)']
  const head = ['CODE', 'VERSION', 'CATEGORY', 'VARS', 'DEPLOYS', 'NAME']
  const numeric = [false, false, false, true, true, false]
  const rows = templates.map((t) => [
    t.code, t.version ?? '', t.category ?? '-',
    String(t.requiredVarCount ?? 0), String(t.deployCount ?? 0),
    t.tagline ? `${t.name} — ${t.tagline}` : (t.name ?? ''),
  ])
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)))
  return [head, ...rows].map((r) =>
    r.map((c, i) => (i === r.length - 1 ? c : numeric[i] ? c.padStart(widths[i]!) : c.padEnd(widths[i]!))).join('  ').trimEnd(),
  )
}

type InfoService = { name: string; type?: string; port?: number; volumeGib?: number }

// The info endpoint may list services as an array or keep the manifest's map shape — render both.
export function normalizeInfoServices(raw: unknown): InfoService[] {
  if (Array.isArray(raw)) {
    return raw.map((s: any) => ({ name: s.name ?? '?', type: s.type, port: s.port, volumeGib: s.volumeGib ?? s.volume?.size }))
  }
  if (raw && typeof raw === 'object') {
    return Object.entries(raw as Record<string, any>).map(([name, s]) => ({ name, type: s?.type, port: s?.port, volumeGib: s?.volume?.size }))
  }
  return []
}

// Variables may arrive as one array with a `required` flag, or pre-grouped {required, optional}.
// A password-typed variable is generator-backed even without an explicit generate spec.
export function normalizeInfoVariables(raw: unknown): TemplateVar[] {
  const one = (v: any, required: boolean): TemplateVar => ({
    name: v.name, required, description: v.description, default: v.default,
    generate: v.generate ?? (v.type === 'password' ? 'secret:32' : undefined),
  })
  if (Array.isArray(raw)) return raw.map((v: any) => one(v, !!v.required))
  if (raw && typeof raw === 'object') {
    const g = raw as { required?: any[]; optional?: any[] }
    return [...(g.required ?? []).map((v) => one(v, true)), ...(g.optional ?? []).map((v) => one(v, false))]
  }
  return []
}

export type TemplateInfo = {
  code: string; name?: string; tagline?: string; version?: string; maintainer?: string; license?: string
  upstream?: { pinned?: string }
  services?: unknown
  variables?: unknown
}

// `bold` is injected so the renderer stays pure (tests pass identity; the command passes ANSI
// bold on a TTY).
export function templateInfoLines(t: TemplateInfo, bold: (s: string) => string = (s) => s): string[] {
  const lines: string[] = [`${t.code}${t.name ? ` — ${t.name}` : ''}`]
  if (t.tagline) lines.push(`  ${t.tagline}`)
  const field = (label: string, value: string | undefined) => { if (value) lines.push(`  ${label.padEnd(11)} ${value}`) }
  field('version', t.version)
  field('maintainer', t.maintainer)
  field('license', t.license)
  field('upstream', t.upstream?.pinned)
  const services = normalizeInfoServices(t.services)
  if (services.length) {
    const summary = services.map((s) => {
      const bits = [s.type && s.type !== 'compute' ? s.type : undefined, s.port ? `port ${s.port}` : undefined, s.volumeGib ? `${s.volumeGib}Gi volume` : undefined].filter(Boolean)
      return `${s.name}${bits.length ? ` (${bits.join(', ')})` : ''}`
    })
    lines.push(`services (${services.length}): ${summary.join(', ')}`)
  }
  const vars = normalizeInfoVariables(t.variables)
  if (vars.length) {
    lines.push('variables:')
    const render = (v: TemplateVar, emph: (s: string) => string) => {
      const extra = [v.generate ? `generated: ${v.generate}` : undefined, v.default !== undefined ? `default: ${v.default}` : undefined].filter(Boolean)
      lines.push(`    ${emph(v.name.padEnd(24))} ${v.description ?? ''}${extra.length ? ` (${extra.join(', ')})` : ''}`.trimEnd())
    }
    const required = vars.filter((v) => v.required)
    const optional = vars.filter((v) => !v.required)
    if (required.length) { lines.push('  required:'); for (const v of required) render(v, bold) }
    if (optional.length) { lines.push('  optional:'); for (const v of optional) render(v, (s) => s) }
  }
  return lines
}

// Parse repeated --set K=V flags. Names follow env-var rules; a missing '=' is a typo worth
// naming. Later occurrences of a name win (shell-override semantics).
export function parseSetFlags(pairs: string[]): Record<string, string> {
  const values: Record<string, string> = {}
  for (const pair of pairs) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=([\s\S]*)$/.exec(pair)
    if (!m) throw new Error(`--set expects NAME=value, got: ${pair}`)
    values[m[1]!] = m[2]!
  }
  return values
}

// Generator specs: `secret:N` (or bare `secret`, N=32) → N hex chars from the CSPRNG. Anything
// else is a manifest the CLI is too old for — say so rather than inventing a value.
export function generateValue(spec: string, random: (bytes: number) => Buffer = randomBytes): string {
  const m = /^secret(?::(\d+))?$/.exec(spec)
  if (!m) throw new Error(`unknown generator: ${spec} (this CLI knows secret:N — upgrade with \`insta upgrade\`?)`)
  const n = m[1] ? Number(m[1]) : 32
  if (n < 1 || n > 256) throw new Error(`generator length out of range: ${spec} (1-256)`)
  return random(Math.ceil(n / 2)).toString('hex').slice(0, n)
}

export function missingVariablesMessage(missing: TemplateVar[]): string {
  return [
    'missing required template variables:',
    ...missing.map((v) => `  ${v.name.padEnd(24)} ${v.description ?? ''}`.trimEnd()),
    'supply them with --set NAME=value (repeatable)',
  ].join('\n')
}

export type ResolveVarsOpts = {
  yes?: boolean
  tty?: boolean
  ask?: (v: TemplateVar) => Promise<string>
  onGenerated?: (name: string, spec: string) => void
}

/**
 * Decide every deploy-time variable value: --set wins; generator-backed vars are auto-generated
 * (a machine-answerable question is not asked); defaults fill required vars, and optional ones
 * under --yes; remaining required vars are prompted on a TTY and are an error anywhere else.
 * Unknown --set names pass through — the platform's variable set may be newer than local parsing.
 */
export async function resolveVariables(vars: TemplateVar[], given: Record<string, string>, opts: ResolveVarsOpts = {}): Promise<Record<string, string>> {
  const values: Record<string, string> = { ...given }
  const missing: TemplateVar[] = []
  for (const v of vars) {
    if (values[v.name] !== undefined) continue
    if (v.generate) {
      values[v.name] = generateValue(v.generate)
      opts.onGenerated?.(v.name, v.generate)
      continue
    }
    if (!v.required) {
      if (opts.yes && v.default !== undefined) values[v.name] = v.default
      continue
    }
    if (v.default !== undefined) { values[v.name] = v.default; continue }
    if (opts.tty && opts.ask) { values[v.name] = await opts.ask(v); continue }
    missing.push(v)
  }
  if (missing.length) throw new Error(missingVariablesMessage(missing))
  return values
}

// The platform's machine-readable "you forgot these" answer to the POST — turned back into
// promptable variables. null = some other error, not ours to interpret.
export function missingVariablesFrom(body: any): TemplateVar[] | null {
  if ((body?.error ?? body?.code) !== 'missing_variables') return null
  const list = body?.missing ?? body?.variables ?? []
  if (!Array.isArray(list)) return []
  return list.map((v: any) => ({
    name: String(v.name ?? v), required: true, description: v.description,
    default: v.default, generate: v.generate ?? (v.type === 'password' ? 'secret:32' : undefined),
  }))
}

// A deploy target that reads as a filesystem path must resolve as one — a typo'd directory should
// not fall through to a registry lookup that 404s with a confusing "no such template".
export function looksLikePath(target: string): boolean {
  return target.startsWith('.') || target.startsWith('/') || target.startsWith('~') || target.includes('/') || target.includes('\\')
}

// ---- deployment progress ----

export const DEPLOY_STEPS = ['create services', 'write variables', 'deploy', 'health check'] as const
const STEP_KEYS = ['create_services', 'write_variables', 'deploy', 'health_check']
const STATUS_STEP: Record<string, number> = {
  pending: 0, creating_services: 0, writing_variables: 1, deploying: 2, health_check: 3, checking_health: 3,
}

/** The index of the step a deployment is currently on (an explicit step field wins), or null when
 *  the status is one this CLI does not know — the watcher then holds progress instead of guessing. */
export function stepIndexFor(status: string, step?: string): number | null {
  if (step) {
    const i = STEP_KEYS.indexOf(step)
    if (i >= 0) return i
  }
  return STATUS_STEP[status] ?? null
}

/** Success URLs, one line each: bare urls, and per-service `name: url`. */
export function deploymentUrls(dep: any): string[] {
  const lines: string[] = []
  for (const u of dep?.urls ?? []) lines.push(String(u))
  for (const s of dep?.services ?? []) if (s?.url) lines.push(`${s.name ?? 'service'}: ${s.url}`)
  return lines
}

const sleepSeconds = (s: number) => new Promise<void>((r) => setTimeout(r, s * 1000))

/**
 * Poll a template deployment until it settles, emitting each step exactly once as it completes
 * (✓) or becomes active (…). Injectable getter/output/wait keep this testable without a network
 * or real timers (the deviceGrant pattern in auth.ts).
 */
export async function watchDeployment(
  getDeployment: (id: string) => Promise<any>,
  id: string,
  out: (line: string) => void = info,
  wait: (s: number) => Promise<void> = sleepSeconds,
  timeoutMs = 15 * 60_000,
): Promise<any> {
  let done = 0 // steps already reported ✓
  let active = -1 // step already reported …
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const dep = await getDeployment(id)
    const status = String(dep?.status ?? '')
    const idx = stepIndexFor(status, dep?.step)
    const completed = status === 'succeeded' ? DEPLOY_STEPS.length : (idx ?? done)
    for (; done < completed; done++) out(`  ✓ ${DEPLOY_STEPS[done]}`)
    if (status === 'failed') {
      const at = DEPLOY_STEPS[Math.min(idx ?? done, DEPLOY_STEPS.length - 1)]
      throw new Error(`template deployment failed during ${at}${dep?.error ? `: ${dep.error}` : ''}`)
    }
    if (status === 'succeeded') return dep
    const current = Math.min(completed, DEPLOY_STEPS.length - 1)
    if (active !== current) { out(`  … ${DEPLOY_STEPS[current]}`); active = current }
    await wait(2)
  }
  throw new Error(`timed out after ${Math.round(timeoutMs / 60_000)}m waiting for template deployment ${id} — check \`insta events\``)
}

// ---- commands ----

export async function templateList(opts: { json?: boolean }): Promise<void> {
  const api = await ApiClient.load()
  const { templates } = await api.request('GET', '/templates')
  if (opts.json) return printJson(templates)
  for (const line of templateListLines(templates ?? [])) info(line)
}

export async function templateInfo(code: string, opts: { json?: boolean }): Promise<void> {
  const api = await ApiClient.load()
  const tpl = await api.request('GET', `/templates/${encodeURIComponent(code)}`)
  if (opts.json) return printJson(tpl)
  const bold = process.stdout.isTTY ? (s: string) => `\x1b[1m${s}\x1b[0m` : (s: string) => s
  for (const line of templateInfoLines(tpl.template ?? tpl, bold)) info(line)
}

/** Real prompt (clack, as feedback.ts); cancelling exits without deploying anything. */
async function promptVariable(v: TemplateVar): Promise<string> {
  const answer = await clack.text({
    message: `${v.name}${v.description ? ` — ${v.description}` : ''}:`,
    validate: (s) => (s.trim() ? undefined : 'required'),
  })
  if (clack.isCancel(answer)) process.exit(0)
  return answer.trim()
}

export type TemplateDeployOpts = { branch?: string; set?: string[]; yes?: boolean; json?: boolean }

export async function templateDeploy(target: string, opts: TemplateDeployOpts = {}): Promise<void> {
  const given = parseSetFlags(opts.set ?? []) // a typo'd --set fails before any network access
  const api = await ApiClient.load()
  const p = await requireProject()
  const branchName = opts.branch ?? p.branch

  // Local directory mode: the directory carries insta.template.yaml. A path-looking target with
  // no manifest is a mistake here, never a registry code.
  const dir = resolve(process.cwd(), target)
  const local = existsSync(join(dir, MANIFEST_FILE))
  if (!local && looksLikePath(target)) die(`no ${MANIFEST_FILE} at ${join(dir, MANIFEST_FILE)}`)

  let manifest: TemplateManifest | undefined
  let vars: TemplateVar[]
  if (local) {
    manifest = loadTemplateManifest(target) // parse + local validation (pinned images, described vars)
    vars = collectManifestVariables(manifest)
    info(`deploying local template ${manifest.code}@${manifest.version}`)
  } else {
    // Learn the variable set up front from the registry so prompting happens before the POST.
    const tpl = await api.request('GET', `/templates/${encodeURIComponent(target)}`)
    vars = normalizeInfoVariables((tpl.template ?? tpl).variables)
  }

  // --json asked for parseable output, so a caller that happens to own a TTY still gets the error.
  const tty = !opts.json && !opts.yes && !!process.stdin.isTTY && !!process.stdout.isTTY
  const quiet = !!opts.json
  const onGenerated = quiet ? undefined : (name: string, spec: string) => info(`  generated ${name} (${spec})`)
  const variables = await resolveVariables(vars, given, { yes: opts.yes, tty, ask: promptVariable, onGenerated })

  // The pipeline provisions onto a branch by id; resolve the linked/--branch name once, up front.
  const { branches } = await api.request('GET', `/projects/${p.projectId}/branches`)
  const branch = branches.find((b: any) => b.name === branchName || b.id === branchName)
  if (!branch) die(`branch not found: ${branchName}`)

  const body = { ...(manifest ? { manifest } : { templateCode: target }), branchId: branch.id, variables }
  let res
  try {
    res = await api.rawRequest('POST', `/projects/${p.projectId}/template-deployments`, body)
  } catch (e) {
    // The platform's own variable check is the authority; when it names what is missing in a
    // machine-readable way, prompt from that and retry once instead of parroting an opaque 4xx.
    const missing = e instanceof ApiError ? missingVariablesFrom(e.body) : null
    if (!missing?.length) throw e
    Object.assign(variables, await resolveVariables(missing, {}, { yes: opts.yes, tty, ask: promptVariable, onGenerated }))
    res = await api.rawRequest('POST', `/projects/${p.projectId}/template-deployments`, { ...body, variables })
  }
  if (handleApproval(res)) return

  const submitted = res.body.deployment ?? res.body
  const codeLabel = manifest?.code ?? target
  if (!quiet) info(`deploying template ${codeLabel} to branch ${branchName} (${submitted.id})`)
  const dep = await watchDeployment((id) => api.request('GET', `/template-deployments/${id}`), submitted.id, quiet ? () => {} : info)
  if (opts.json) return printJson(dep)
  info(`template ${codeLabel} deployed to branch ${branchName}`)
  for (const u of deploymentUrls(dep)) info(`  ${u}`)
  info('next: run `insta secrets` to refresh .env with the new service credentials')
  renderNextActions(dep.nextActions)
}
