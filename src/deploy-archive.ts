import type { ApiClient } from './api.js'
import { handleApproval } from './util.js'
import type { PackResult } from './pack.js'

// The gateway does NOT fall back to nixpacks when it finds no Dockerfile, it fails. The platform
// never sees the tree, so the side that packed it chooses.
export type ArchiveBuildSpec = { type: 'dockerfile' } | { type: 'nixpacks' }

export function archiveBuildSpec(hasDockerfile: boolean): ArchiveBuildSpec {
  return hasDockerfile ? { type: 'dockerfile' } : { type: 'nixpacks' }
}

// sha256 is the IDENTITY (the canonical tar digest), archiveSha256 the INTEGRITY value the build
// worker checks the bytes it fetched against. They are different digests of the same archive.
export type ArchiveRef = { sha256: string; archiveSha256: string; build: ArchiveBuildSpec }

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
  packed: Pick<PackResult, 'archive' | 'sha256' | 'tarSha256' | 'hasDockerfile'>,
  branch: string,
  opts: Opts,
  upload: Uploader = defaultUpload,
): Promise<ArchiveRef | null> {
  const ref: ArchiveRef = { sha256: packed.tarSha256, archiveSha256: packed.sha256, build: archiveBuildSpec(packed.hasDockerfile) }

  // Keyed on the TAR digest everywhere the platform derives storage from, so a re-run under the
  // other runtime finds the same object instead of uploading a second copy under a second id.
  const first = await api.rawRequest('GET', statusPath(projectId, packed.tarSha256))
  if (first.body?.state === 'valid') return ref

  const minted = await api.rawRequest('POST', `/projects/${projectId}/build-uploads`, {
    branch,
    group: opts.group,
    sha256: packed.tarSha256,
    size: packed.archive.length,
  })
  if (handleApproval(minted, opts.json)) return null

  await upload(minted.body.uploadUrl, packed.archive)

  // Never let the deploy call be the thing that discovers a failed upload: its grant is spent in
  // the governance preHandler, so a retry would need a NEW approval.
  const after = await api.rawRequest('GET', statusPath(projectId, packed.tarSha256))
  if (after.body?.state !== 'valid') {
    throw new Error('the archive upload did not land — re-run the deploy to try again')
  }
  return ref
}
