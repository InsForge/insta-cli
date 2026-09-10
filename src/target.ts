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

/** Which setting chose the target. A stable token, so `--json` consumers (agents, mostly) can
 *  branch on it: the human `source` string is prose and will be reworded. */
export type TargetSource =
  | 'env-api-url'   // $INSTA_API_URL
  | 'env-name'      // $INSTA_ENV
  | 'saved-api-url' // persisted by `insta login --api-url`
  | 'saved-env'     // persisted by `insta env use` / `login --env`
  | 'default'       // nothing was ever chosen
  | 'flag'          // --api-url on the running command, not yet persisted

export type Target = {
  apiUrl: string
  host: string
  /** null for a host no environment name covers: an insta-oss daemon, a preview, a tunnel. */
  env: EnvName | null
  /** Machine-stable; `source` is the same fact as prose. */
  kind: TargetSource
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

  let kind: TargetSource
  if (i.envApiUrl && normalizeUrl(i.envApiUrl) === want) kind = 'env-api-url'
  else if (namedApi && normalizeUrl(namedApi) === want) kind = 'env-name'
  else if (i.stored && normalizeUrl(i.stored) === want) {
    // A stored host the env table knows was written by `env use` (or by `login --env`, which
    // writes the same value); anything else was a literal URL the user typed at `login --api-url`.
    kind = envForApiUrl(i.stored) ? 'saved-env' : 'saved-api-url'
  } else if (i.stored === null && env === DEFAULT_ENV) kind = 'default'
  // Nothing in the environment or on disk accounts for this URL, so it came from the flag the
  // running command was given (`login --api-url`, before anything is persisted).
  else kind = 'flag'

  const source =
    kind === 'env-api-url' ? 'INSTA_API_URL'
      : kind === 'env-name' ? `INSTA_ENV=${named}`
        : kind === 'saved-env' ? 'saved by `insta env use`'
          : kind === 'saved-api-url' ? 'saved by `insta login --api-url`'
            : kind === 'default' ? 'built-in default'
              : '--api-url flag'

  // Undo the thing that actually chose this host, not the thing that usually does. `env use prod`
  // is the right advice only when something is PERSISTED; against a bare `--api-url` on the
  // running command it is a no-op that prints "already on prod" and deepens the confusion.
  const recovery =
    kind === 'env-api-url' ? 'unset INSTA_API_URL'
      : kind === 'env-name' ? 'unset INSTA_ENV'
        : kind === 'flag' ? 'drop --api-url'
          : 'insta env use prod'

  return { apiUrl: i.apiUrl, host: hostOf(i.apiUrl), env, kind, source, recovery }
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

// Two runtimes, two vocabularies, and the shipped artifact is the one that is easy to forget.
//
// On Node (`npm i -g insta`) undici reports every transport failure as the same
// `TypeError: fetch failed`, with the code that says WHICH failure on `.cause`. On Bun (the
// compiled binaries install.sh serves, so: most users) it is a plain `Error` carrying the code on
// the error ITSELF, no cause at all, spelled in Bun's own CamelCase.
//
// Bun is also coarser, and that part needs care rather than a translation. It reports a connect
// TIMEOUT as `ConnectionRefused`, so it cannot tell a terminated box from a refused port from a
// dead DNS name. Rendering that as "connection refused" would be a confident lie about the exact
// host this feature exists for, so it gets the honest, non-committal "could not connect". Node's
// own ECONNREFUSED really does mean refused and keeps the precise wording.
//
// Anything unmapped falls through to the code, then the message, so a new runtime code degrades to
// a raw-but-present reason rather than to nothing.
const REASONS: Record<string, string> = {
  // Bun (the compiled binaries).
  ConnectionRefused: 'could not connect',
  ConnectionClosed: 'connection closed',
  FailedToOpenSocket: 'could not open a socket',
  Timeout: 'timed out',
  // Node / undici (the npm install).
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
