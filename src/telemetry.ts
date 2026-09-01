import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import { dirname, join } from 'node:path'
import type { Command } from 'commander'
import { ApiError } from './api.js'
import { readGlobal, readProject, type GlobalConfig, type ProjectConfig } from './config.js'
import { envForApiUrl, type EnvName } from './env.js'
import { clean } from './redact.js'
import { detectChannel } from './commands/upgrade.js'
import { CliExit, lastFailure } from './util.js'

export const POSTHOG_HOST = 'https://us.i.posthog.com'
// The console's project keys (insta-frontend src/lib/analytics.ts), so a CLI event lands on the
// person the console identified. Write-only capture tokens: safe to ship in a public binary.
const PROJECT_KEYS: Record<EnvName, string> = {
  prod: 'phc_yHWfNfkDuQpJ34yKQ4equid3j64zj3tBRtpej3b5i8QH',
  staging: 'phc_BeXdaHFfeaCJFAH26TyEi3LB9xwHj23U6LdfKWP46G4U',
}
// The send is awaited before the process exits, so it gets one bounded attempt and no retry.
const SEND_TIMEOUT_MS = 1500
const MAX_STRING = 200
const REDACTED = '[REDACTED]'

// Option values that are credentials, identity, free text, or object-key space: dropped wholesale, never pattern-scrubbed.
const REDACTED_OPTIONS = new Set(['password', 'apiKey', 'email', 'title', 'detail', 'error', 'expected', 'workaround', 'doc', 'command', 'area', 'prefix', 'cursor'])
// `--set NAME=value`: the name is structure, the value is the user's.
const ASSIGNMENT_OPTIONS = new Set(['set'])
// Positionals from this index on are user payload, not command structure.
const PAYLOAD_ARGS_FROM: Record<string, number> = { 'secrets set': 1, run: 1, 'db query': 1, 'storage get': 0, 'storage delete': 0 }

export function telemetryDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return !!(env.DO_NOT_TRACK || env.INSTA_NO_TELEMETRY)
}

/** The PostHog project of the environment `apiUrl` belongs to; a custom host (insta-oss, a preview
 *  deployment) captures nothing. */
export function telemetryKey(apiUrl: string): string | undefined {
  const name = envForApiUrl(apiUrl)
  return name ? PROJECT_KEYS[name] : undefined
}

const scrub = (v: unknown): unknown => (typeof v === 'string' ? clean(v, MAX_STRING) : v)

export function redactOptions(opts: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(opts)) {
    if (REDACTED_OPTIONS.has(k)) out[k] = REDACTED
    else if (ASSIGNMENT_OPTIONS.has(k)) out[k] = (v as string[]).map((a) => `${a.split('=')[0]}=${REDACTED}`)
    else out[k] = scrub(v)
  }
  return out
}

export function redactArgs(command: string, args: unknown[]): unknown[] {
  const from = PAYLOAD_ARGS_FROM[command]
  return args.map((a, i) => (from !== undefined && i >= from ? REDACTED : scrub(a)))
}

/** `secrets set`, `services add`, … — the subcommand chain without the program name. */
export function commandPath(cmd: Command): string {
  const names: string[] = []
  for (let c: Command | null = cmd; c?.parent; c = c.parent) names.unshift(c.name())
  return names.join(' ')
}

export function detectAgent(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.CLAUDECODE) return 'claude-code'
  if (env.CURSOR_TRACE_ID) return 'cursor'
  return null
}

export type Outcome = { error?: unknown; durationMs: number; exitCode: number }

export type EventContext = {
  cliVersion: string
  channel: string
  config: GlobalConfig
  project: ProjectConfig | null
  anonymousId: string
  env: NodeJS.ProcessEnv
  tty: boolean
}

export type CommandEvent = {
  event: 'cli_command'
  distinct_id: string
  timestamp: string
  properties: Record<string, unknown>
}

function errorProps(error: unknown): Record<string, unknown> {
  if (error === undefined) return {}
  if (error instanceof ApiError) return { error_type: 'api', http_status: error.status, error_message: scrub(error.message) }
  if (error instanceof CliExit) return { error_type: 'cli', error_message: scrub(lastFailure()) }
  const e = error as { name?: string; message?: string; cause?: { code?: string } }
  return {
    error_type: e?.name ?? 'unknown',
    error_message: scrub(String(e?.message ?? error)),
    ...(e?.cause?.code ? { error_code: e.cause.code } : {}),
  }
}

function hostOf(url: string): string | null {
  try { return new URL(url).host } catch { return null }
}

export function buildCommandEvent(
  command: string,
  args: unknown[],
  options: Record<string, unknown>,
  outcome: Outcome,
  ctx: EventContext,
): CommandEvent {
  const token = ctx.config.accessToken
  return {
    event: 'cli_command',
    distinct_id: ctx.config.user?.id ?? ctx.anonymousId,
    timestamp: new Date().toISOString(),
    properties: {
      command,
      args: redactArgs(command, args),
      options: redactOptions(options),
      success: outcome.exitCode === 0,
      exit_code: outcome.exitCode,
      duration_ms: outcome.durationMs,
      ...errorProps(outcome.error),
      cli_version: ctx.cliVersion,
      channel: ctx.channel,
      node_version: process.version,
      os: os.platform(),
      os_release: os.release(),
      arch: os.arch(),
      env: envForApiUrl(ctx.config.apiUrl) ?? 'custom',
      api_host: hostOf(ctx.config.apiUrl),
      logged_in: !!token,
      auth_kind: token ? (token.startsWith('insta_') ? 'api_key' : 'session') : null,
      project_id: ctx.project?.projectId ?? null,
      org_id: ctx.project?.orgId ?? null,
      branch: ctx.project?.branch ?? null,
      tty: ctx.tty,
      ci: !!ctx.env.CI,
      agent: detectAgent(ctx.env),
      term_program: ctx.env.TERM_PROGRAM ?? null,
      $lib: 'insta-cli',
      $lib_version: ctx.cliVersion,
    },
  }
}

export async function anonymousId(file = join(os.homedir(), '.insta', 'telemetry.json')): Promise<string> {
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8')) as { anonymousId?: unknown }
    if (typeof parsed.anonymousId === 'string' && parsed.anonymousId) return parsed.anonymousId
  } catch {}
  const id = randomUUID()
  try {
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, JSON.stringify({ anonymousId: id }, null, 2))
  } catch {}
  return id
}

export async function sendBatch(key: string, batch: object[], fetchImpl: typeof fetch = fetch): Promise<boolean> {
  try {
    const res = await fetchImpl(`${POSTHOG_HOST}/batch/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: key, batch }),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    })
    return res.ok
  } catch {
    return false
  }
}

export type TrackDeps = {
  fetchImpl?: typeof fetch
  env?: NodeJS.ProcessEnv
  loadConfig?: () => Promise<GlobalConfig>
  loadProject?: () => Promise<ProjectConfig | null>
  idFile?: string
  channel?: string
  tty?: boolean
}

/** Report one finished command. Never throws and never changes the exit code: analytics must not
 *  fail the user's actual task. */
export async function trackCommand(cmd: Command, args: unknown[], outcome: Outcome, cliVersion: string, deps: TrackDeps = {}): Promise<void> {
  try {
    const env = deps.env ?? process.env
    if (telemetryDisabled(env)) return
    const command = commandPath(cmd)
    if (command.startsWith('__')) return
    const config = await (deps.loadConfig ?? readGlobal)()
    const key = telemetryKey(config.apiUrl)
    if (!key) return
    const project = await (deps.loadProject ?? readProject)()
    const event = buildCommandEvent(command, args.flat(), cmd.opts(), outcome, {
      cliVersion,
      channel: deps.channel ?? detectChannel(),
      config,
      project,
      anonymousId: await anonymousId(deps.idFile),
      env,
      tty: deps.tty ?? !!process.stdout.isTTY,
    })
    await sendBatch(key, [event], deps.fetchImpl)
  } catch {}
}
