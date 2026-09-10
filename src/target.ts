// Where the CLI is pointed, and which setting put it there.
//
// Everything here is DERIVED: nothing is stored, and nothing is asked of the host. That is
// deliberate on both counts. The failure this exists for is a host that does not answer, so an
// answer from the host is exactly what cannot be relied on; and a stored label ("this URL is an
// insta-oss box") goes stale the moment the box is rebuilt or the URL reused, which is worse than
// no label at all. Provenance needs neither: `env use` only ever writes a host from the env table,
// so a persisted apiUrl that is not one of those can only have come from `login --api-url`.
import { DEFAULT_ENV, ENVS, ENV_NAMES, envForApiUrl, normalizeUrl, type EnvName } from './env.js'
import { storedApiUrl } from './config.js'

export type Target = {
  apiUrl: string
  host: string
  /** null for a host no environment name covers: an insta-oss daemon, a preview, a tunnel. */
  env: EnvName | null
  /** The setting that chose apiUrl, phrased to sit after a `source:` label. */
  source: string
  /** The one command that gets back to InstaCloud from here. */
  recovery: string
}

export const hostOf = (url: string): string => {
  try { return new URL(url).host } catch { return url }
}

/** Pure core (unit-tested). `stored` is what the config FILE holds, null when it holds nothing. */
export function buildTarget(i: {
  apiUrl: string
  stored: string | null
  envApiUrl?: string
  envName?: string
}): Target {
  const want = normalizeUrl(i.apiUrl)
  const env = envForApiUrl(i.apiUrl)
  const named = i.envName?.trim().toLowerCase()
  const namedApi = named && (ENV_NAMES as string[]).includes(named) ? ENVS[named as EnvName].api : undefined

  let source: string
  if (i.envApiUrl && normalizeUrl(i.envApiUrl) === want) source = 'INSTA_API_URL'
  else if (namedApi && normalizeUrl(namedApi) === want) source = `INSTA_ENV=${named}`
  else if (i.stored && normalizeUrl(i.stored) === want) {
    // A stored host the env table knows was written by `env use` (or by `login --env`, which
    // writes the same value); anything else was a literal URL the user typed at `login --api-url`.
    source = envForApiUrl(i.stored) ? 'saved by `insta env use`' : 'saved by `insta login --api-url`'
  } else if (i.stored === null && env === DEFAULT_ENV) source = 'built-in default'
  // Nothing in the environment or on disk accounts for this URL, so it came from the flag the
  // running command was given (`login --api-url`, before anything is persisted).
  else source = '--api-url flag'

  const recovery =
    source === 'INSTA_API_URL' ? 'unset INSTA_API_URL'
      : source.startsWith('INSTA_ENV=') ? 'unset INSTA_ENV'
        : 'insta env use prod'

  return { apiUrl: i.apiUrl, host: hostOf(i.apiUrl), env, source, recovery }
}

/** The live target, from the resolved apiUrl plus the config file and the environment. */
export async function describeTarget(apiUrl: string): Promise<Target> {
  return buildTarget({
    apiUrl,
    stored: await storedApiUrl(),
    envApiUrl: process.env.INSTA_API_URL,
    envName: process.env.INSTA_ENV,
  })
}

/** The context an error adds beneath its first line. Empty on the cloud default: the overwhelming
 *  majority of runs are there, and a run that is where it expects to be has nothing to explain. */
export function targetLines(t: Target): string[] {
  if (t.env === DEFAULT_ENV) return []
  const lines = [`  target: ${t.apiUrl} (${t.source})`]
  if (!t.env) lines.push(`  for InstaCloud: ${t.recovery}`)
  return lines
}

// undici reports every transport failure as the same `TypeError: fetch failed`; the code that says
// WHICH failure is on the cause. Anything unmapped falls through to the code, then the message, so
// a new libuv/undici code degrades to a raw-but-present reason rather than to nothing.
const REASONS: Record<string, string> = {
  UND_ERR_CONNECT_TIMEOUT: 'connect timeout',
  UND_ERR_HEADERS_TIMEOUT: 'no response headers',
  UND_ERR_SOCKET: 'socket closed',
  ECONNREFUSED: 'connection refused',
  ECONNRESET: 'connection reset',
  EHOSTUNREACH: 'host unreachable',
  ENETUNREACH: 'network unreachable',
  ETIMEDOUT: 'timed out',
  ENOTFOUND: 'DNS lookup failed',
  EAI_AGAIN: 'DNS temporarily unavailable',
  CERT_HAS_EXPIRED: 'TLS certificate expired',
  DEPTH_ZERO_SELF_SIGNED_CERT: 'self-signed TLS certificate',
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'TLS certificate not trusted',
  ERR_TLS_CERT_ALTNAME_INVALID: 'TLS certificate does not cover this host',
}

/** Why the connection failed, in a few words. Pure (unit-tested). */
export function failureReason(cause: unknown): string | null {
  const c = cause as { code?: string; message?: string } | undefined
  if (!c) return null
  const known = c.code ? REASONS[c.code] : undefined
  return known ?? c.code ?? c.message ?? null
}
