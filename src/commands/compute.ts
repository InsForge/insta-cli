import { ApiClient, ApiError, requireProject } from '../api.js'
import { info, printJson, handleApproval } from '../util.js'
import { resolveComputeServiceId, q, parseVolumeGib } from './services.js'

type Opts = { branch?: string; group?: string; json?: boolean }

// Attach a developer-owned custom domain to a branch's compute service. Fly issues the cert + routes
// it; the platform returns the DNS records to set in your OWN zone.
export async function setDomain(host: string, opts: Opts): Promise<void> {
  const api = await ApiClient.load()
  const p = await requireProject()
  const res = await api.rawRequest('POST', `/projects/${p.projectId}/compute/domain`, { hostname: host, branch: opts.branch ?? p.branch, group: opts.group })
  if (handleApproval(res, opts.json)) return
  printDomain(res.body, opts.json)
}

// Re-check a custom domain's cert status + required DNS records.
export async function checkDomain(host: string, opts: Opts): Promise<void> {
  const api = await ApiClient.load()
  const p = await requireProject()
  const qs = new URLSearchParams({ hostname: host })
  if (opts.branch ?? p.branch) qs.set('branch', opts.branch ?? p.branch)
  if (opts.group) qs.set('group', opts.group)
  printDomain(await api.request('GET', `/projects/${p.projectId}/compute/domain?${qs}`), opts.json)
}

export async function removeDomain(host: string, opts: Opts): Promise<void> {
  const api = await ApiClient.load()
  const p = await requireProject()
  const res = await api.rawRequest('DELETE', `/projects/${p.projectId}/compute/domain`, { hostname: host, branch: opts.branch ?? p.branch, group: opts.group })
  if (handleApproval(res, opts.json)) return
  renderRemoveDomain(res.body, opts.json)
}

// Split out (same pattern as applyExecResult) so the --json contract — stdout carries the platform
// response, never prose — is unit-testable without a network mock.
export function renderRemoveDomain(body: any, json?: boolean): void {
  if (json) return printJson(body)
  info(`removed custom domain ${body.hostname} from ${body.flyApp}`)
}

function printDomain(r: any, json?: boolean): void {
  if (json) return printJson(r)
  info(`${r.hostname} → ${r.flyApp}`)
  info(`  status: ${r.status}${r.configured ? ' ✓ configured' : ''}`)
  if (r.dns?.length) {
    info('  set these DNS records at your domain registrar:')
    for (const d of r.dns) info(`    ${String(d.type).padEnd(5)} ${d.name}  →  ${d.value}${d.note ? `   # ${d.note}` : ''}`)
  }
  if (!r.configured) info('  once DNS propagates, Fly issues the cert — re-check with `insta compute check-domain`')
}

// ---- lifecycle (start/stop/suspend/status) ----

type LifeOpts = { json?: boolean; branch?: string }

async function lifecycle(verb: 'start' | 'stop' | 'suspend', serviceName: string | undefined, opts: LifeOpts): Promise<void> {
  const api = await ApiClient.load()
  const p = await requireProject()
  const branch = opts.branch ?? p.branch
  const { services } = await api.request('GET', `/projects/${p.projectId}/services${q(branch)}`)
  const id = resolveComputeServiceId(services, serviceName)
  const res = await api.rawRequest('POST', `/projects/${p.projectId}/services/${id}/${verb}`)
  if (handleApproval(res, opts.json)) return
  if (opts.json) return printJson(res.body)
  info(`compute ${res.body.service?.name ?? id}: ${verb} → desired=${res.body.service?.desired_state} (live: ${res.body.state})`)
}

export const computeStart = (service: string | undefined, opts: LifeOpts) => lifecycle('start', service, opts)
export const computeStop = (service: string | undefined, opts: LifeOpts) => lifecycle('stop', service, opts)
export const computeSuspend = (service: string | undefined, opts: LifeOpts) => lifecycle('suspend', service, opts)

export async function computeStatus(serviceName: string | undefined, opts: LifeOpts): Promise<void> {
  const api = await ApiClient.load()
  const p = await requireProject()
  const branch = opts.branch ?? p.branch
  const { services } = await api.request('GET', `/projects/${p.projectId}/services${q(branch)}`)
  const id = resolveComputeServiceId(services, serviceName)
  const r = await api.request('GET', `/projects/${p.projectId}/services/${id}/state`)
  if (opts.json) return printJson(r)
  info(`compute ${serviceName ?? id}: desired=${r.desiredState}  live=${r.state}`)
}

// ---- exec (one-shot command; no interactive shell/PTY) ----

// `insta compute exec [service] -- <command> [args…]`: the command must reach the platform
// byte-for-byte and can itself contain dashes or another `--`, so it can't be a normal commander
// positional — with `service` optional, commander flattens everything past the literal `--` into
// one operand list and has no way to tell "no service, command starts here" apart from "service IS
// the first command token". Splitting argv on the first literal `--` after `compute exec`
// ourselves, before commander ever parses it, removes the ambiguity; this is the only place in the
// whole CLI a bare `--` has this meaning, so nothing else is affected. Exported for a direct,
// network-free unit test — this split is the seam most likely to regress.
export function splitExecArgs(
  argv: string[],
  platform: NodeJS.Platform = process.platform,
): { argv: string[]; command?: string[]; windowsFallback?: boolean; windowsAmbiguous?: boolean } {
  const i = argv.findIndex((a, idx) => a === 'compute' && argv[idx + 1] === 'exec')
  if (i === -1) return { argv }
  const dash = argv.indexOf('--', i + 2)
  if (dash !== -1) return { argv: argv.slice(0, dash), command: argv.slice(dash + 1) }
  if (platform !== 'win32') return { argv }

  // npm's generated PowerShell shim consumes a bare `--` before forwarding $args to node. When
  // that happens, keep CLI options before the tentative service and split at the next operand.
  // The service candidate is checked against the real service list later, which recovers the
  // omitted-service form. A CLI-looking token after the candidate is inherently ambiguous, so it
  // is preserved and marked for a clear insta.cmd fallback rather than silently dropped.
  let sawService = false
  for (let cursor = i + 2; cursor < argv.length; cursor++) {
    const token = argv[cursor]!
    if (token === '--branch' || token === '--timeout') {
      if (sawService) {
        return { argv: argv.slice(0, cursor), command: argv.slice(cursor), windowsFallback: true, windowsAmbiguous: true }
      }
      cursor++
      continue
    }
    if (token.startsWith('--branch=') || token.startsWith('--timeout=') || token === '--json' || token === '--help' || token === '-h') {
      if (sawService) {
        return { argv: argv.slice(0, cursor), command: argv.slice(cursor), windowsFallback: true, windowsAmbiguous: true }
      }
      continue
    }
    if (!sawService) {
      sawService = true
      continue
    }
    return { argv: argv.slice(0, cursor), command: argv.slice(cursor), windowsFallback: true }
  }
  return sawService ? { argv, windowsFallback: true } : { argv }
}

export function resolveExecTarget(
  services: Array<{ id: string; type: string; name: string }>,
  serviceName: string | undefined,
  command: string[] | undefined,
  windowsFallback = false,
): { serviceName: string | undefined; command: string[] | undefined } {
  if (!windowsFallback || !serviceName) return { serviceName, command }
  const namedService = services.some((service) => service.type === 'compute' && service.name === serviceName)
  return namedService
    ? { serviceName, command }
    : { serviceName: undefined, command: [serviceName, ...(command ?? [])] }
}

// The --timeout override, through a throwing parser like every other user-typed number in this
// repo (parseCpu, parseCount, parsePort): junk must fail locally instead of reaching the server as
// NaN, and the bounds mirror what the platform enforces (1-180s; server default 30 when omitted).
export function parseTimeoutSec(raw: string): number {
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 1 || n > 180) throw new Error(`invalid timeout: ${raw} (1-180 seconds)`)
  return n
}

// Map exec inputs to the platform POST body. Pure, unit-tested without a network mock (mirrors
// deployRequestBody / servicesAddRequestBody). timeoutSec is omitted when not given so the server
// applies its own default (30s) rather than the client picking one on the wire.
export function execRequestBody(command: string[], timeoutSec?: number): Record<string, unknown> {
  return { command, ...(timeoutSec !== undefined ? { timeoutSec } : {}) }
}

type ExecOpts = LifeOpts & { timeout?: string }
type ExecRecovery = { windowsFallback?: boolean; windowsAmbiguous?: boolean }

// Renders the exec response and sets process.exitCode — split out of computeExec as a pure function
// of (res, json) so it's unit-testable without a network mock, same as handleApproval's own
// {status, body} shape.
//
// A 202 means the command has NOT run: handleApproval owns the whole contract (hint on stderr,
// raw envelope on stdout with --json, exit 2), so a caller chaining `insta compute exec … && next`
// can never mistake a pending gate for the command having succeeded — and exit 2 stays
// distinguishable from the remote command's own exit 1.
export function applyExecResult(res: { status: number; body: any }, json?: boolean): void {
  if (handleApproval(res, json)) return
  const { exitCode, stdout, stderr, truncated } = res.body
  if (json) {
    printJson(res.body)
  } else {
    process.stdout.write(stdout)
    process.stderr.write(stderr)
    if (truncated) process.stderr.write('note: output truncated — the platform caps stdout/stderr at 1 MiB each\n')
  }
  // The platform sends -1 as an "unknown exit" sentinel, and nothing outside 0-255 is a valid POSIX
  // exit code. Assigning it straight to process.exitCode risks Node's own DEP0164 (a negative code
  // silently exits 255) — clamp out-of-range codes to 1 instead, with a one-line note so the cause is
  // visible. Normal codes pass through untouched.
  if (exitCode < 0 || exitCode > 255) {
    process.stderr.write(`note: remote exit code ${exitCode} out of range — exiting 1\n`)
    process.exitCode = 1
  } else {
    process.exitCode = exitCode
  }
}

// One HTTP round trip, not a shell session: no PTY, no interactivity, stdout/stderr come back as
// two whole strings (each capped at 1 MiB server-side) rather than a stream. They're written to
// this process's own stdout/stderr verbatim — no prefixes, no added newline — and the remote exit
// code becomes this process's own exit code (--json still passes it through, it just skips the
// split-stream output), since agents scripting this rely on it. Waking a scaled-to-zero machine is
// expected — it adds latency and bills as uptime, it is not an error.
export async function computeExec(
  serviceName: string | undefined,
  command: string[] | undefined,
  opts: ExecOpts,
  recovery: ExecRecovery = {},
): Promise<void> {
  if (recovery.windowsAmbiguous) {
    throw new Error('PowerShell removed the `--` separator and the remaining flags are ambiguous — put CLI options before [service], or run `insta.cmd compute exec [service] -- <command> [args…]`')
  }
  if (!recovery.windowsFallback && (!command || command.length === 0)) {
    throw new Error('usage: insta compute exec [service] -- <command> [args…] (see --help)')
  }
  const timeoutSec = opts.timeout !== undefined ? parseTimeoutSec(opts.timeout) : undefined
  const api = await ApiClient.load()
  const p = await requireProject()
  const branch = opts.branch ?? p.branch
  const { services } = await api.request('GET', `/projects/${p.projectId}/services${q(branch)}`)
  const target = resolveExecTarget(services, serviceName, command, !!recovery.windowsFallback)
  if (!target.command || target.command.length === 0) {
    throw new Error('usage: insta compute exec [service] -- <command> [args…] (see --help)')
  }
  const id = resolveComputeServiceId(services, target.serviceName)
  const res = await api.rawRequest('POST', `/projects/${p.projectId}/services/${id}/exec`, execRequestBody(target.command, timeoutSec))
  applyExecResult(res, opts.json)
}

// ---- always-on (opt out of scale-to-zero; all plans; billing is actual usage either way) ----

export async function computeAlwaysOn(mode: string, serviceName: string | undefined, opts: LifeOpts): Promise<void> {
  if (mode !== 'on' && mode !== 'off') throw new Error('mode must be on|off')
  const api = await ApiClient.load()
  const p = await requireProject()
  const branch = opts.branch ?? p.branch
  const { services } = await api.request('GET', `/projects/${p.projectId}/services${q(branch)}`)
  const id = resolveComputeServiceId(services, serviceName)
  const res = await api.rawRequest('PUT', `/projects/${p.projectId}/services/${id}/always-on`, { enabled: mode === 'on' })
  if (handleApproval(res, opts.json)) return
  if (opts.json) return printJson(res.body)
  const on = res.body.service?.always_on
  info(`compute ${res.body.service?.name ?? id}: always-on ${on ? 'ENABLED — machines stay warm (no cold starts; idle RAM bills at actual usage)' : 'disabled — scales to zero when idle (default)'}`)
}

// ---- limits (the resource ceiling; paid plans) ----

// Parse a human memory value into MB: "512", "512mb", "1gb", "2g", "1.5gb".
// Exported for unit tests — this is the only place a user-typed size becomes a number.
export function parseMemoryMb(raw: string): number {
  const m = /^\s*(\d+(?:\.\d+)?)\s*(g|gb|gi|gib|m|mb|mi|mib)?\s*$/i.exec(raw)
  if (!m) throw new Error(`invalid memory: ${raw} (try 512mb, 1gb, 2gb)`)
  const n = Number(m[1])
  const unit = (m[2] ?? 'mb').toLowerCase()
  const mb = unit.startsWith('g') ? n * 1024 : n
  if (!(mb > 0)) throw new Error(`invalid memory: ${raw}`)
  return Math.round(mb)
}

// Whole and half GB collapse (1536 → "1.5 GB"); anything else stays exact in MB — a display that
// rounds 1536 to "2 GB" claims a ceiling the API did not set.
export const fmtMb = (mb: number) => (mb >= 1024 && mb % 512 === 0 ? `${mb / 1024} GB` : `${mb} MB`)

// The --cpu override, through a throwing parser like every other user-typed number in this repo
// (parseCount, parseMemoryMb). A bare Number() turns a typo into NaN, which JSON.stringify
// serializes as null — the server then sees {cpu: null} instead of the user seeing an error.
// Enforces the provider grid the help text advertises: the server would reject 100 anyway, but a
// value the client KNOWS is invalid should fail locally, matching what --help promises.
const CPU_SIZES = [1, 2, 4, 6, 8]
export function parseCpu(raw: string): number {
  const n = Number(raw)
  if (!CPU_SIZES.includes(n)) throw new Error(`invalid cpu: ${raw} (provider sizes: ${CPU_SIZES.join(', ')})`)
  return n
}

// ---- volume (the persistent /data disk; attach any time, grow-only, deletable; never detach) ----

// Render the volume read. Pure, exported for tests (mirrors serviceListLine). Every plan may view;
// only growth is paid — that gate is the backend's to enforce, so nothing here pre-blocks.
export function volumeLines(name: string, volume: { sizeGib: number; mountPath: string } | null, cap: { volumeGib: number }): string[] {
  if (!volume) return [
    `compute ${name}: no volume attached (attach one: \`insta compute volume ${name} --size <gi>\` — it mounts at /data on the next deploy)`,
  ]
  return [
    `compute ${name}: volume ${volume.sizeGib}Gi at ${volume.mountPath}  (plan max ${cap.volumeGib}Gi)`,
    '  billing is actual data stored — the size is a cap, not a price; grow with --size (grow-only), delete with --delete (destroys the data)',
  ]
}

// Render the PUT result. Pure, exported for tests. `attached` comes from the backend and is what
// tells a FIRST attach (no disk yet — it mounts on the next deploy) apart from a grow (the live
// disk was already extended); the wire size is authoritative in both cases.
export function volumeWriteLine(name: string, body: { volume: { sizeGib: number; mountPath: string }; cap: { volumeGib: number }; attached?: boolean }): string {
  if (body.attached) {
    return `compute ${name}: volume ${body.volume.sizeGib}Gi attached — mounts at ${body.volume.mountPath} on the next deploy  (plan max ${body.cap.volumeGib}Gi)`
  }
  return `compute ${name}: volume grown to ${body.volume.sizeGib}Gi at ${body.volume.mountPath}  (plan max ${body.cap.volumeGib}Gi)`
}

// Render the DELETE result. Pure, exported for tests. Deleting is the only way off the volume
// path (there is no detach), so the line says what came back with it: the two constraints the
// volume imposed.
export function volumeDeleteLine(name: string): string {
  return `compute ${name}: volume deleted — the disk and its data are gone; suspend fast-wake and scale-out are back`
}

// Map a DELETE .../volume failure. Pure, exported for tests (r2d2 review rounds 1+2: this is the
// close-call branch worth pinning). An older backend has no DELETE route, and what its 404 looks
// like depends on who answered: the real platform (Fastify, no custom notFound handler) sends its
// default body {"message":"Route DELETE:/… not found","error":"Not Found"} → ApiError message
// "Not Found"; a proxy or bodyless 404 leaves ApiError's own "HTTP 404" fallback. BOTH are the
// generic route-miss shape and mean version skew, not a bug — parroting them would send the user
// hunting the wrong thing. A backend that HAS the route names the real problem in a DOMAIN
// message ("this service has no volume", …), which must flow verbatim, 404 or not.
const GENERIC_404 = /^(HTTP 404|Not Found)$/i
export function volumeDeleteError(e: unknown): unknown {
  if (e instanceof ApiError && e.status === 404 && GENERIC_404.test(e.message.trim())) {
    return new Error('this backend does not support volume delete yet — update the platform, or delete the service to remove its volume')
  }
  return e
}

type VolumeOpts = LifeOpts & { size?: string; delete?: boolean }

// Show, attach, grow, or delete a compute service's /data volume. No flag: a safe read (size +
// mount path + the plan cap). --size: PUT .../volume — attaches when no volume exists, grows
// otherwise. --delete: DELETE .../volume — destroys the disk and its data immediately (no detach,
// no undo; billing stops now). The paid/cap/machine-count gates all belong to the backend, whose
// 403/400 messages carry the upgrade hints and must reach the user verbatim (the guard prints
// ApiError messages as-is).
export async function computeVolume(serviceName: string | undefined, opts: VolumeOpts): Promise<void> {
  if (opts.delete && opts.size) throw new Error('--delete cannot be combined with --size (one changes the volume, the other destroys it)')
  const api = await ApiClient.load()
  const p = await requireProject()
  const branch = opts.branch ?? p.branch
  const { services } = await api.request('GET', `/projects/${p.projectId}/services${q(branch)}`)
  const id = resolveComputeServiceId(services, serviceName)

  if (opts.delete) {
    let res
    try { res = await api.rawRequest('DELETE', `/projects/${p.projectId}/services/${id}/volume`) }
    catch (e) { throw volumeDeleteError(e) }
    if (handleApproval(res, opts.json)) return
    if (opts.json) return printJson(res.body)
    info(volumeDeleteLine(res.body.service?.name ?? serviceName ?? id))
    return
  }

  if (!opts.size) {
    const r = await api.request('GET', `/projects/${p.projectId}/services/${id}/volume`)
    if (opts.json) return printJson(r)
    for (const line of volumeLines(serviceName ?? id, r.volume, r.cap)) info(line)
    return
  }

  const sizeGib = parseVolumeGib(opts.size)
  const res = await api.rawRequest('PUT', `/projects/${p.projectId}/services/${id}/volume`, { sizeGib })
  if (handleApproval(res, opts.json)) return
  if (opts.json) return printJson(res.body)
  info(volumeWriteLine(res.body.service?.name ?? serviceName ?? id, res.body))
}

type LimitsOpts = LifeOpts & { cpu?: string; memory?: string }

// Show or set a compute service's ceiling. With no --memory it PRINTS the current limits and the
// plan cap (so `insta compute limits` is a safe read), which is also what a UI renders as a slider
// with its plan-limit marker.
export async function computeLimits(serviceName: string | undefined, opts: LimitsOpts): Promise<void> {
  const api = await ApiClient.load()
  const p = await requireProject()
  const branch = opts.branch ?? p.branch
  const { services } = await api.request('GET', `/projects/${p.projectId}/services${q(branch)}`)
  const id = resolveComputeServiceId(services, serviceName)

  if (!opts.memory && !opts.cpu) {
    const r = await api.request('GET', `/projects/${p.projectId}/services/${id}/limits`)
    if (opts.json) return printJson(r)
    info(`compute ${serviceName ?? id}: ceiling ${r.limits.cpu} vCPU / ${fmtMb(r.limits.memoryMb)}  (plan max ${r.cap.cpu} vCPU / ${fmtMb(r.cap.memoryMb)})`)
    info('  billing is actual usage — the ceiling caps what the app may burn, it is not a price')
    return
  }
  if (!opts.memory) throw new Error('--memory is required when setting limits (cpu is derived from it; pass --cpu only to override)')

  const body: Record<string, unknown> = { memoryMb: parseMemoryMb(opts.memory) }
  if (opts.cpu) body.cpu = parseCpu(opts.cpu)
  const res = await api.rawRequest('PUT', `/projects/${p.projectId}/services/${id}/limits`, body)
  if (handleApproval(res, opts.json)) return
  if (opts.json) return printJson(res.body)
  const l = res.body.limits
  info(`compute ${res.body.service?.name ?? id}: ceiling set to ${l.cpu} vCPU / ${fmtMb(l.memoryMb)}`)
}
