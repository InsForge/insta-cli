import type { ApiClient } from './api.js'
import { handleApproval } from './util.js'
import type { PackResult } from './pack.js'

// The gateway does NOT fall back to nixpacks when it finds no Dockerfile, it fails. The platform
// never sees the tree, so the side that packed it chooses.
export type ArchiveBuildSpec = { type: 'dockerfile' } | { type: 'nixpacks' }

export function archiveBuildSpec(hasDockerfile: boolean): ArchiveBuildSpec {
  return hasDockerfile ? { type: 'dockerfile' } : { type: 'nixpacks' }
}

// ONE digest, over the uploaded bytes: it is both the id the object is stored under and the value
// the build worker checks the bytes it fetched against. Splitting the two so the id could be
// canonical across runtimes is what let a Node-packed object be claimed by a Bun-packed digest;
// the compressor is deterministic instead, so one digest is canonical AND addresses the bytes.
export type ArchiveRef = { archiveSha256: string; build: ArchiveBuildSpec }

type Api = Pick<ApiClient, 'rawRequest'>
type Opts = { branch?: string; group?: string; json?: boolean }

// Plain fetch, never the api client: the presigned URL carries its own signature and the platform
// bearer must not be sent to a bucket.
export type Uploader = (url: string, body: Buffer) => Promise<void>

const defaultUpload: Uploader = async (url, body) => {
  const res = await fetch(url, { method: 'PUT', body })
  if (!res.ok) throw new Error(`uploading the archive failed: HTTP ${res.status}`)
}

const statusPath = (projectId: string, sha256: string) => `/projects/${projectId}/build-uploads/${sha256}`

// Put an archive where the build gateway can fetch it, and answer what the deploy body needs.
// Returns null when an approval is pending — the caller stops, the user approves and re-runs.
//
// The status read comes FIRST and that ordering is the whole recovery story: it is ungated, the
// packer is deterministic and the upload id is derived from the content, so a re-run after an
// approval finds the object already there, skips the gated mint it no longer needs, and submits a
// byte-identical deploy body. That is why no resumable state is written to disk.
export async function uploadArchive(
  api: Api,
  projectId: string,
  packed: Pick<PackResult, 'archive' | 'sha256' | 'hasDockerfile'>,
  branch: string,
  opts: Opts,
  upload: Uploader = defaultUpload,
): Promise<ArchiveRef | null> {
  const ref: ArchiveRef = { archiveSha256: packed.sha256, build: archiveBuildSpec(packed.hasDockerfile) }

  // The id the platform derives storage from is this digest, so an object that is already there is
  // BYTE-IDENTICAL to the one in hand and the ref describes it truthfully. Keying on the tar digest
  // instead bought cross-runtime dedup and paid for it with a lie: a Bun re-run of a Node upload
  // matched the id, skipped the upload, and sent Bun's digest for Node's bytes, which the worker
  // then rejected on every attempt until the object expired.
  const first = await api.rawRequest('GET', statusPath(projectId, packed.sha256))
  if (first.body?.state === 'valid') return ref

  const minted = await api.rawRequest('POST', `/projects/${projectId}/build-uploads`, {
    branch,
    group: opts.group,
    sha256: packed.sha256,
    size: packed.archive.length,
  })
  if (handleApproval(minted, opts.json)) return null

  await upload(minted.body.uploadUrl, packed.archive)

  // Never let the deploy call be the thing that discovers a failed upload: its grant is spent in
  // the governance preHandler, so a retry would need a NEW approval.
  const after = await api.rawRequest('GET', statusPath(projectId, packed.sha256))
  if (after.body?.state !== 'valid') {
    throw new Error('the archive upload did not land — re-run the deploy to try again')
  }
  return ref
}

// How often to ask, and how long to keep asking. The platform submits the build and returns; the
// WAIT is ours, one short request at a time, because a deploy is answered synchronously and the
// ALB in front of the platform cuts an idle request at 60s while an image build runs minutes.
const POLL_MS = 3000
const BUILD_DEADLINE_MS = 30 * 60 * 1000

export type BuildOutcome = { image: string } | { failed: string }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// Build the uploaded archive and wait it out. Returns null when an approval is pending.
export async function buildArchive(
  api: Api,
  projectId: string,
  ref: ArchiveRef,
  branch: string,
  opts: Opts,
  now: () => number = Date.now,
  wait: (ms: number) => Promise<unknown> = sleep,
): Promise<BuildOutcome | null> {
  const started = await api.rawRequest('POST', `/projects/${projectId}/archive-builds`, {
    branch,
    group: opts.group,
    archive: ref,
  })
  if (handleApproval(started, opts.json)) return null
  const buildId: string = started.body.buildId

  const deadline = now() + BUILD_DEADLINE_MS
  for (;;) {
    const res = await api.rawRequest('GET', `/projects/${projectId}/archive-builds/${encodeURIComponent(buildId)}`)
    const state = res.body?.state
    // A failed build is an ANSWER, not a transport error: the poll worked and the gateway is
    // telling us why the tree did not build, which is the one sentence worth surfacing verbatim.
    if (state === 'failed') return { failed: res.body.message || 'the build failed' }
    if (state === 'succeeded') return { image: res.body.imageRef }
    if (now() > deadline) {
      throw new Error(`the build did not finish within ${Math.round(BUILD_DEADLINE_MS / 60000)} minutes — check \`insta logs\` or re-run`)
    }
    await wait(POLL_MS)
  }
}
