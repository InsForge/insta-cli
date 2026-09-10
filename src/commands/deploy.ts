import { resolve, join } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import { ApiClient, ApiError, requireProject } from '../api.js'
import { info, die, printJson, handleApproval, renderNextActions, CliExit } from '../util.js'
import { flyctlBuildAndPush, ensureFlyctl, defaultBuildRunner, stderrBuildRunner, type BuildRunner } from '../flyctl-build.js'
import { packDirectory, windowsModeCaveat, type ArchiveLimits } from '../pack.js'
import { uploadArchive, type ArchiveRef, type Uploader } from '../deploy-archive.js'

type DeployOpts = { image?: string; branch?: string; group?: string; port?: string; websocket?: boolean; replaceSource?: boolean; json?: boolean }

// With --json, stdout must carry exactly one JSON document (the deploy result), so every progress
// line moves to stderr.
const note = (opts: DeployOpts) => (opts.json ? (m: string) => void process.stderr.write(m + '\n') : info)

// Map CLI options to the platform deploy request body. Pure, so it's unit-tested. --websocket is only
// sent when set (plain deploys unchanged). Exactly one of image | archive rides along.
export function deployRequestBody(source: DeploySource, branch: string, opts: DeployOpts): Record<string, unknown> {
  return {
    ...('image' in source ? { image: source.image } : { archive: source.archive }),
    branch,
    group: opts.group,
    port: opts.port ? Number(opts.port) : undefined,
    websocket: opts.websocket ? true : undefined,
    replaceSource: opts.replaceSource ? true : undefined,
  }
}

// What a source directory resolved to: a built image (flyctl or local docker) or an uploaded
// archive the gateway will build.
export type DeploySource = { image: string } | { archive: ArchiveRef }

type Lane =
  | { lane: 'flyctl' }
  | { lane: 'local-docker' }
  | { lane: 'archive'; limits: ArchiveLimits }
  | { lane: 'none'; reason: string }
  | { lane: 'legacy' }

// Ask the platform which lane serves this target, so the CLI stops knowing which provider backs
// its service. A 404 means the platform predates the contract — and because this is a GET, it
// 404s the same way for a human and an agent, which a POST would not.
async function discoverLane(api: Pick<ApiClient, 'rawRequest'>, projectId: string, branch: string, opts: DeployOpts): Promise<Lane> {
  const q = new URLSearchParams({ branch, ...(opts.group ? { group: opts.group } : {}) })
  try {
    const res = await api.rawRequest('GET', `/projects/${projectId}/source-build?${q}`)
    return res.body as Lane
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) return { lane: 'legacy' }
    throw e
  }
}

// Turn a source directory into something deployable. Returns null when an approval is pending.
export async function prepareSource(
  api: Pick<ApiClient, 'rawRequest'>,
  projectId: string,
  dir: string,
  branch: string,
  opts: DeployOpts,
  run: BuildRunner = opts.json ? stderrBuildRunner : defaultBuildRunner,
  upload?: Uploader,
): Promise<DeploySource | null> {
  const lane = await discoverLane(api, projectId, branch, opts)
  if (lane.lane === 'none') die(lane.reason)
  if (lane.lane !== 'archive') {
    // flyctl, local-docker and legacy all end in an image, and all three need a Dockerfile.
    return { image: await buildFromSource(api, projectId, dir, branch, opts, run) }
  }
  const log = note(opts)
  const absDir = resolve(process.cwd(), dir)
  const caveat = windowsModeCaveat()
  if (caveat) log(caveat)
  const packed = packDirectory(absDir, lane.limits)
  log(`packed ${dir}: ${packed.files} files, ${packed.archive.length} bytes`)
  const ref = await uploadArchive(api, projectId, packed, branch, opts, upload)
  return ref && { archive: ref }
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

// This message is for the target that still REQUIRES a Dockerfile: a Fly-backed service, where a
// directory deploy builds the Dockerfile in the directory and dies without one. On insta-compute
// the archive lane carries the directory to the gateway and nixpacks builds it, so this dead end is
// no longer universal. It names every way forward instead of the bare "add one".
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
    '  - connect the GitHub repo to the service (`insta compute connect-repo <owner/repo>`) — that lane builds Dockerfile-less repos with nixpacks server-side',
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
  const source = dir ? await prepareSource(api, p.projectId, dir, branch, effOpts) : { image: opts.image! }
  if (!source) return // an approval is pending; the user approves and re-runs
  const res = await api.rawRequest('POST', `/projects/${p.projectId}/deploy`, deployRequestBody(source, branch, effOpts))
    .catch((e) => { throw e instanceof ApiError && e.status === 409 ? new ApiError(e.status, repoConnectedHint(e.message), e.body) : e })
  if (handleApproval(res, opts.json)) return
  const what = 'image' in source ? source.image : `archive ${source.archive.archiveSha256.slice(0, 12)} (${source.archive.build.type})`
  if (opts.json) return printJson({ ...('image' in source ? { image: source.image } : { archive: source.archive }), ...res.body })
  info(`deployed ${what} -> ${res.body.url} (branch ${res.body.branch}, group ${res.body.group})`)
  renderNextActions(res.body.nextActions)
}

// The platform refuses an image deploy onto a repo-connected service and names the body field it
// wants; a CLI user can only pass the flag. Pure, so it's unit-tested.
export function repoConnectedHint(message: string): string {
  return message.replace(/pass replaceSource: true/g, 'pass --replace-source')
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
