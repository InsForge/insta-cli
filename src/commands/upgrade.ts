// Self-update: `insta upgrade` updates the CLI in place, channel-aware (native binary via the
// release installer; npm via `npm i -g`). A background version check (detached, cached 24h in
// ~/.insta/update-check.json) powers an update nudge — and, since the CLI is young and moves
// fast, AUTO-UPDATE IS ON BY DEFAULT: when a newer version is known, the next invocation spawns
// a quiet detached upgrade. `insta autoupdate off` (or INSTA_NO_AUTOUPDATE=1) disables that,
// leaving just the stderr nudge.
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { readGlobal, writeGlobal } from '../config.js'
import { info } from '../util.js'

const INSTALL_SH = 'https://raw.githubusercontent.com/InsForge/insta-cli/main/install.sh'
const REGISTRY_LATEST = 'https://registry.npmjs.org/insta/latest'
const CHECK_TTL_MS = 24 * 60 * 60 * 1000 // re-check the registry at most once a day
const AUTO_THROTTLE_MS = 60 * 60 * 1000 //  don't respawn a failed auto-upgrade more than hourly

export type Channel = 'binary' | 'npm' | 'source'
export type CheckCache = { checkedAt: number; latest: string; lastAutoAt?: number }

const cachePath = (): string => process.env.INSTA_UPDATE_CACHE ?? join(homedir(), '.insta', 'update-check.json')

// How is this CLI running? Bun standalone → execPath IS the insta binary (not node);
// npm global → the module lives under node_modules; anything else is a source checkout.
export function detectChannel(execPath = process.execPath, moduleUrl = import.meta.url): Channel {
  if (!/node(\.exe)?$/.test(execPath)) return 'binary'
  if (moduleUrl.includes('/node_modules/')) return 'npm'
  return 'source'
}

// -1 / 0 / 1 for a<b / a==b / a>b on dotted numeric versions ("0.0.4" style).
export function cmpSemver(a: string, b: string): number {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0)
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d < 0 ? -1 : 1
  }
  return 0
}

export function readCache(): CheckCache | null {
  try { return JSON.parse(readFileSync(cachePath(), 'utf8')) as CheckCache } catch { return null }
}

export function writeCache(c: CheckCache): void {
  mkdirSync(dirname(cachePath()), { recursive: true })
  writeFileSync(cachePath(), JSON.stringify(c))
}

// Pure decision for what start-up should do given the cache. Exported for tests.
export function decideAction(
  cache: CheckCache | null,
  current: string,
  autoUpdate: boolean,
  channel: Channel,
  now = Date.now(),
): 'none' | 'nudge' | 'auto' {
  if (!cache || cmpSemver(cache.latest, current) <= 0) return 'none'
  if (!autoUpdate || channel === 'source') return 'nudge'
  if (cache.lastAutoAt && now - cache.lastAutoAt < AUTO_THROTTLE_MS) return 'nudge'
  return 'auto'
}

// `insta upgrade` — synchronous, visible self-update on the detected channel.
export async function upgrade(): Promise<void> {
  const channel = detectChannel()
  if (channel === 'source') { info('running from a source checkout — `git pull` to update'); return }
  info(`upgrading insta via ${channel} …`)
  let cmd: string
  let args: string[]
  let env: NodeJS.ProcessEnv = process.env
  if (channel === 'binary') {
    cmd = 'sh'
    args = ['-c', `curl -fsSL ${INSTALL_SH} | sh`]
    env = { ...process.env, INSTA_INSTALL_DIR: dirname(process.execPath) }
  } else {
    cmd = 'npm'
    args = ['install', '-g', 'insta@latest']
  }
  await new Promise<void>((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: 'inherit', env })
    p.on('error', reject)
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`upgrade failed (exit ${code})`))))
  })
}

// Hidden `insta __update-check` — runs detached in the background: fetch latest, refresh cache.
export async function backgroundCheck(): Promise<void> {
  try {
    const ctl = new AbortController()
    const t = setTimeout(() => ctl.abort(), 5000)
    const res = await fetch(REGISTRY_LATEST, { signal: ctl.signal })
    clearTimeout(t)
    if (!res.ok) return
    const { version } = (await res.json()) as { version?: string }
    if (version) writeCache({ ...(readCache() ?? { checkedAt: 0, latest: '0.0.0' }), checkedAt: Date.now(), latest: version })
  } catch { /* offline / registry down — try again next TTL */ }
}

// `insta autoupdate [on|off]` — toggle / show the auto-update preference (default: on).
export async function autoupdate(mode?: string): Promise<void> {
  const cfg = await readGlobal()
  if (mode === 'on' || mode === 'off') {
    await writeGlobal({ ...cfg, autoUpdate: mode === 'on' })
    info(`autoupdate ${mode}`)
    return
  }
  const enabled = cfg.autoUpdate !== false && !process.env.INSTA_NO_AUTOUPDATE
  info(`autoupdate: ${enabled ? 'on' : 'off'} (default on while the CLI is pre-1.0 — \`insta autoupdate off\` to disable)`)
}

// Called once at CLI start-up. Never blocks: reads the cache synchronously, prints at most one
// stderr line, and (when due) spawns detached children for the registry check / quiet upgrade.
export function maybeUpdate(current: string, argv: string[]): void {
  const cmd = argv[2]
  if (cmd === 'upgrade' || cmd === 'autoupdate' || cmd === '__update-check') return
  const channel = detectChannel()
  const cache = readCache()

  // keep the cache fresh (detached; survives this process exiting)
  if (!cache || Date.now() - cache.checkedAt > CHECK_TTL_MS) {
    respawnDetached(['__update-check'])
  }

  let auto = !process.env.INSTA_NO_AUTOUPDATE
  try { // config read is async elsewhere; a tiny sync read keeps start-up non-blocking
    const raw = JSON.parse(readFileSync(join(homedir(), '.insta', 'config.json'), 'utf8')) as { autoUpdate?: boolean }
    if (raw.autoUpdate === false) auto = false
  } catch { /* no config yet */ }

  const action = decideAction(cache, current, auto, channel)
  if (action === 'nudge') {
    console.error(`↑ insta ${cache!.latest} is available (you have ${current}) — run \`insta upgrade\``)
  } else if (action === 'auto') {
    writeCache({ ...cache!, lastAutoAt: Date.now() })
    respawnDetached(['upgrade'])
    console.error(`↑ auto-updating insta ${current} → ${cache!.latest} in the background (\`insta autoupdate off\` to disable)`)
  }
}

// Re-invoke this same CLI (binary or node+script) detached, output discarded.
function respawnDetached(args: string[]): void {
  try {
    const script = process.argv[1]
    const argv = /node(\.exe)?$/.test(process.execPath) && script ? [script, ...args] : args
    const p = spawn(process.execPath, argv, { detached: true, stdio: 'ignore' })
    p.unref()
  } catch { /* best-effort */ }
}
