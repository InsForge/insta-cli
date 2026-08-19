// Local insta.template.yaml parsing + validation for `insta template deploy ./dir`. Everything
// here is pure over the parsed document (unit-tested); only loadTemplateManifest touches disk.
// The platform revalidates on upload — local checks exist to fail fast with a file/line the
// author can act on, before anything travels.
import { join, resolve } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import YAML from 'yaml'

export const MANIFEST_FILE = 'insta.template.yaml'

// A variable spec as authored: full object, or a bare string shorthand for the description.
export type VarSpec = { description?: string; default?: string; generate?: string }

export type ManifestEnv = {
  fixed?: Record<string, string>
  generated?: Record<string, string> // NAME → generator spec, e.g. "secret:32"
  required?: Record<string, VarSpec | string>
  optional?: Record<string, VarSpec | string>
}

export type ManifestService = {
  type?: string
  image?: string
  build?: unknown
  port?: number
  healthcheck?: unknown
  volume?: { size?: number }
  env?: ManifestEnv
}

export type TemplateManifest = {
  code?: string
  version?: string
  maintainer?: string
  upstream?: { pinned?: string }
  generated?: Record<string, string>
  services?: Record<string, ManifestService>
  constraints?: unknown
  meta?: { name?: string; tagline?: string; category?: string; tags?: string[] }
}

// One template variable, flattened out of the manifest (or the registry info endpoint) into the
// shape the deploy prompt/--set resolution works over.
export type TemplateVar = {
  name: string
  description?: string
  required: boolean
  default?: string
  generate?: string
}

const CODE_RE = /^[a-z0-9][a-z0-9-]{0,63}$/

// Why an image must carry a pin: a template is a reproducible deploy, and a tagless ref (implicit
// :latest) or an explicit :latest re-resolves on every deploy — two runs of the same template
// version would ship different bytes. Digest-pinned refs (…@sha256:…) are the strongest pin.
export function imageTagIssue(image: string): string | null {
  if (image.includes('@')) return null // digest-pinned
  const lastSegment = image.split('/').pop() ?? ''
  const tag = lastSegment.includes(':') ? lastSegment.split(':').pop() : undefined
  if (!tag) return `image ${image} has no tag — pin a version (or a @sha256 digest)`
  if (tag === 'latest') return `image ${image} is pinned to :latest, which is not a pin — use a version tag (or a @sha256 digest)`
  return null
}

function asVarSpec(v: VarSpec | string | null | undefined): VarSpec {
  if (typeof v === 'string') return { description: v }
  return v ?? {}
}

// Managed service types need no image; anything else (compute, or an omitted type) must say what
// it runs.
const MANAGED_TYPES = ['postgres', 'redis', 'mysql', 'mongodb', 'storage']

/** All local validation problems, empty when the manifest is deployable. */
export function validateManifest(m: TemplateManifest): string[] {
  const problems: string[] = []
  if (!m || typeof m !== 'object') return ['manifest is not a YAML mapping']
  if (!m.code || typeof m.code !== 'string') problems.push('code is required')
  else if (!CODE_RE.test(m.code)) problems.push(`code must be lower-kebab (a-z, 0-9, -), got: ${m.code}`)
  if (!m.version || typeof m.version !== 'string') problems.push('version is required')
  const services = m.services ?? {}
  const names = Object.keys(services)
  if (names.length === 0) problems.push('services: at least one service is required')
  for (const name of names) {
    const svc = services[name] ?? {}
    const where = `services.${name}`
    const type = svc.type ?? 'compute'
    if (svc.image && svc.build) problems.push(`${where}: image and build are mutually exclusive`)
    if (!svc.image && !svc.build && !MANAGED_TYPES.includes(type)) problems.push(`${where}: an image or a build is required for ${type} services`)
    if (svc.image) {
      const issue = imageTagIssue(svc.image)
      if (issue) problems.push(`${where}: ${issue}`)
    }
    if (svc.port !== undefined && (!Number.isInteger(svc.port) || svc.port < 1 || svc.port > 65535)) {
      problems.push(`${where}: port must be an integer between 1 and 65535, got: ${svc.port}`)
    }
    if (svc.volume?.size !== undefined && (!Number.isInteger(svc.volume.size) || svc.volume.size < 1)) {
      problems.push(`${where}: volume.size must be a whole Gi ≥ 1, got: ${svc.volume.size}`)
    }
    for (const [varName, raw] of Object.entries(svc.env?.required ?? {})) {
      const spec = asVarSpec(raw)
      // A required var is a question put to the deployer — without a description (or a generator
      // that answers it for them) there is nothing to ask with.
      if (!spec.description && !spec.generate) problems.push(`${where}.env.required.${varName}: a description is required (unless generate is set)`)
    }
  }
  return problems
}

/**
 * Flatten the manifest's prompt-relevant variables: every service's env.required and env.optional.
 * env.fixed / env.generated (and top-level `generated`) are filled in by the platform's
 * write-variables step, so they are not deploy-time questions. First mention of a name wins its
 * spec; required anywhere means required.
 */
export function collectManifestVariables(m: TemplateManifest): TemplateVar[] {
  const byName = new Map<string, TemplateVar>()
  const add = (name: string, raw: VarSpec | string | null | undefined, required: boolean) => {
    const spec = asVarSpec(raw)
    const existing = byName.get(name)
    if (existing) { existing.required = existing.required || required; return }
    byName.set(name, { name, required, description: spec.description, default: spec.default, generate: spec.generate })
  }
  for (const svc of Object.values(m.services ?? {})) {
    for (const [name, spec] of Object.entries(svc.env?.required ?? {})) add(name, spec, true)
    for (const [name, spec] of Object.entries(svc.env?.optional ?? {})) add(name, spec, false)
  }
  return [...byName.values()]
}

/** Parse manifest YAML text. Throws with every validation problem listed, not just the first. */
export function parseManifestYaml(text: string, source = MANIFEST_FILE): TemplateManifest {
  let doc: unknown
  try {
    doc = YAML.parse(text)
  } catch (e) {
    throw new Error(`${source}: ${e instanceof Error ? e.message : String(e)}`)
  }
  const manifest = (doc ?? {}) as TemplateManifest
  const problems = validateManifest(manifest)
  if (problems.length) throw new Error(`${source} is not deployable:\n${problems.map((p) => `  - ${p}`).join('\n')}`)
  return manifest
}

/** Read + validate <dir>/insta.template.yaml. */
export function loadTemplateManifest(dir: string): TemplateManifest {
  const path = join(resolve(process.cwd(), dir), MANIFEST_FILE)
  if (!existsSync(path)) throw new Error(`no ${MANIFEST_FILE} at ${path}`)
  return parseManifestYaml(readFileSync(path, 'utf8'), path)
}
