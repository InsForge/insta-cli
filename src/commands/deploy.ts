import { resolve, join } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import { ApiClient, requireProject } from '../api.js'
import { info, die, handleApproval } from '../util.js'
import { flyctlBuildAndPush, ensureFlyctl } from '../flyctl-build.js'

type DeployOpts = { image?: string; branch?: string; group?: string; port?: string }

// A port mismatch is the #1 deploy mistake: the app boots "successfully" but the proxy routes to
// the wrong internal port and every request is refused. For source deploys the Dockerfile states
// the truth — use its (last) EXPOSE as the default instead of a blind 8080.
export function dockerfileExposedPort(dockerfile: string): number | undefined {
  let port: number | undefined
  for (const line of dockerfile.split('\n')) {
    const m = /^\s*EXPOSE\s+(\d+)/i.exec(line)
    if (m) port = Number(m[1])
  }
  return port
}

// Deploy either a prebuilt image (`--image`) or a source directory (positional `<dir>`, built
// remotely on Fly and pushed with a short-lived platform-minted token). Exactly one mode.
export async function deploy(dir: string | undefined, opts: DeployOpts): Promise<void> {
  if (dir && opts.image) die('pick one: a source <dir> OR --image <url>, not both')
  if (!dir && !opts.image) die('usage: insta deploy <dir> | --image <url>  [--branch <b>] [--group <g>] [--port <n>]')

  const api = await ApiClient.load()
  const p = await requireProject()
  const branch = opts.branch ?? p.branch

  let port = opts.port ? Number(opts.port) : undefined
  if (dir && port === undefined) {
    const dockerfile = join(resolve(process.cwd(), dir), 'Dockerfile')
    const exposed = existsSync(dockerfile) ? dockerfileExposedPort(readFileSync(dockerfile, 'utf8')) : undefined
    if (exposed) {
      port = exposed
      info(`using port ${exposed} (Dockerfile EXPOSE) — override with --port`)
    }
  }

  const image = dir ? await buildFromSource(api, p.projectId, dir, branch, { ...opts, port: port?.toString() }) : opts.image!
  const res = await api.rawRequest('POST', `/projects/${p.projectId}/deploy`, {
    image,
    branch,
    group: opts.group,
    port,
  })
  if (handleApproval(res)) return
  info(`deployed ${image} -> ${res.body.url} (branch ${res.body.branch}, group ${res.body.group})`)
}

// Source mode: mint a scoped Fly deploy token from the platform, then build+push <dir> (needs a
// Dockerfile) with flyctl's remote builder, returning the pushed image ref to deploy.
async function buildFromSource(api: ApiClient, projectId: string, dir: string, branch: string, opts: DeployOpts): Promise<string> {
  const absDir = resolve(process.cwd(), dir)
  if (!existsSync(join(absDir, 'Dockerfile'))) die(`no Dockerfile at ${join(absDir, 'Dockerfile')} — add one, or use --image <url>`)
  await ensureFlyctl()
  const port = opts.port ? Number(opts.port) : 8080

  const tok = await api.rawRequest('POST', `/projects/${projectId}/deploy-token`, { branch, group: opts.group })
  if (handleApproval(tok)) die('deploy requires approval — get it approved, then re-run')
  const { token, flyApp } = tok.body

  info(`building ${dir} for ${flyApp} (remote builder)…`)
  const { imageRef } = await flyctlBuildAndPush({ dir: absDir, flyApp, imageLabel: `insta-${Date.now()}`, token, port })
  info(`  pushed ${imageRef}`)
  return imageRef
}
