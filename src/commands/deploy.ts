import { resolve, join } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import { ApiClient, ApiError, requireProject } from '../api.js'
import { info, die, printJson, handleApproval, renderNextActions, CliExit } from '../util.js'
import { flyctlBuildAndPush, ensureFlyctl, defaultBuildRunner, stderrBuildRunner, type BuildRunner } from '../flyctl-build.js'

type DeployOpts = { image?: string; branch?: string; group?: string; port?: string; websocket?: boolean; json?: boolean }

// With --json, stdout must carry exactly one JSON document (the deploy result), so every progress
// line moves to stderr.
const note = (opts: DeployOpts) => (opts.json ? (m: string) => void process.stderr.write(m + '\n') : info)

// Map CLI options to the platform deploy request body. Pure, so it's unit-tested. --websocket is only
// sent when set (plain deploys unchanged).
export function deployRequestBody(image: string, branch: string, opts: DeployOpts): Record<string, unknown> {
  return {
    image,
    branch,
    group: opts.group,
    port: opts.port ? Number(opts.port) : undefined,
    websocket: opts.websocket ? true : undefined,
  }
}

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

// A directory deploy builds the Dockerfile IN the directory — there is no no-Dockerfile lane here.
// The nixpacks (no-Dockerfile) lane is real but server-side: it runs on the build gateway for
// GitHub-connected repos only, and nothing reachable from `insta deploy <dir>` can enter it. So the
// dead-end message names every way forward instead of the bare "add one".
//
// It deliberately does NOT say "save the Dockerfile `insta build --explain` prints": that file is
// not standalone — it COPYs `.nixpacks/nixpkgs-<hash>.nix` support files nixpacks writes beside it,
// which the source dir does not have. Pointing at it would swap one false promise for another. The
// detected install/start commands ARE reusable, so the message points at those.
// Pure, so it's unit-tested.
export function noDockerfileMessage(absDir: string): string {
  return [
    `no Dockerfile at ${join(absDir, 'Dockerfile')} — a directory deploy builds the Dockerfile in the directory.`,
    'Options:',
    `  - add a Dockerfile to ${absDir} (\`insta build ${absDir}\` prints the install/start commands nixpacks detected, as a starting point)`,
    '  - deploy a prebuilt image instead: `insta deploy --image <url>`',
    "  - connect the app's GitHub repo in the console — that lane builds Dockerfile-less repos with nixpacks server-side",
  ].join('\n')
}

// Deploy either a prebuilt image (`--image`) or a source directory (positional `<dir>`, built
// remotely on Fly and pushed with a short-lived platform-minted token). Exactly one mode.
export async function deploy(dir: string | undefined, opts: DeployOpts): Promise<void> {
  if (dir && opts.image) die('pick one: a source <dir> OR --image <url>, not both')
  if (!dir && !opts.image) die('usage: insta deploy <dir> | --image <url>  [--branch <b>] [--group <g>] [--port <n>]')

  const api = await ApiClient.load()
  const p = await requireProject()
  const branch = opts.branch ?? p.branch
  const log = note(opts)

  let port = opts.port ? Number(opts.port) : undefined
  if (dir && port === undefined) {
    const dockerfile = join(resolve(process.cwd(), dir), 'Dockerfile')
    const exposed = existsSync(dockerfile) ? dockerfileExposedPort(readFileSync(dockerfile, 'utf8')) : undefined
    if (exposed) {
      port = exposed
      log(`using port ${exposed} (Dockerfile EXPOSE) — override with --port`)
    }
  }

  const effOpts = { ...opts, port: port?.toString() }
  const image = dir ? await buildFromSource(api, p.projectId, dir, branch, effOpts) : opts.image!
  const res = await api.rawRequest('POST', `/projects/${p.projectId}/deploy`, deployRequestBody(image, branch, effOpts))
  if (handleApproval(res, opts.json)) return
  if (opts.json) return printJson({ image, ...res.body })
  info(`deployed ${image} -> ${res.body.url} (branch ${res.body.branch}, group ${res.body.group})`)
  renderNextActions(res.body.nextActions)
}

// The local image tag a daemon-side deploy runs: unique per build so a redeploy replaces, and
// legible in `docker images`. Pure, so it's unit-tested.
export function localImageTag(projectId: string, group: string | undefined, now: number = Date.now()): string {
  return `insta-src-${projectId.slice(0, 8)}-${group ?? 'default'}:${now}`
}

// Local build for a local daemon (insta-oss): the CLI and the daemon share ONE docker, so a
// locally-built tag is directly runnable — no registry, no push. Same injectable-runner pattern
// as flyctl-build.ts.
export async function dockerBuildLocal(absDir: string, tag: string, run: BuildRunner = defaultBuildRunner): Promise<string> {
  const { code } = await run('docker', ['build', '-t', tag, '.'], { cwd: absDir, env: process.env as Record<string, string> })
  if (code !== 0) throw new Error(`docker build failed (exit ${code}). See output above.`)
  return tag
}

// Source mode: mint a scoped Fly deploy token from the platform, then build+push <dir> (needs a
// Dockerfile) with flyctl's remote builder, returning the pushed image ref to deploy. Against a
// local daemon (insta-oss) the token mint answers 501 — build with docker instead, same contract.
// Exported with injectable pieces for tests (the repo's DI pattern; no global mocks).
export async function buildFromSource(
  api: Pick<ApiClient, 'rawRequest'>,
  projectId: string,
  dir: string,
  branch: string,
  opts: DeployOpts,
  run: BuildRunner = opts.json ? stderrBuildRunner : defaultBuildRunner,
): Promise<string> {
  const absDir = resolve(process.cwd(), dir)
  if (!existsSync(join(absDir, 'Dockerfile'))) die(noDockerfileMessage(absDir))
  const log = note(opts)

  let tok
  try {
    tok = await api.rawRequest('POST', `/projects/${projectId}/deploy-token`, { branch, group: opts.group })
  } catch (e) {
    // 501 = no remote builder here (insta-oss is the only deployment that answers it) — the
    // daemon deploys from the SAME docker this shell uses, so build locally and hand it the tag.
    if (!(e instanceof ApiError) || e.status !== 501) throw e
    const tag = localImageTag(projectId, opts.group)
    log(`no remote builder on this daemon — building ${dir} locally with docker…`)
    const built = await dockerBuildLocal(absDir, tag, run)
    log(`  built ${built}`)
    return built
  }
  if (handleApproval(tok, opts.json)) throw new CliExit()
  const { token, flyApp } = tok.body

  await ensureFlyctl() // cloud path only — the local path needs docker, which the daemon requires anyway
  const port = opts.port ? Number(opts.port) : 8080
  log(`building ${dir} for ${flyApp} (remote builder)…`)
  const { imageRef } = await flyctlBuildAndPush({ dir: absDir, flyApp, imageLabel: `insta-${Date.now()}`, token, port }, run)
  log(`  pushed ${imageRef}`)
  return imageRef
}
