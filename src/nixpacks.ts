// nixpacks glue for `insta build`: framework detection (`nixpacks plan`) and Dockerfile
// generation (`nixpacks build --out`) — both static, neither touches a Docker daemon.
// Same injectable-runner pattern as flyctl-build.ts.
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BuildRunner } from './flyctl-build.js'

export type NixpacksPlan = {
  providers: string[]
  installCommand?: string
  buildCommand?: string
  startCommand?: string
}

// Capture-only runner: plan output is parsed (not shown), and a wedged binary must not hang the
// command — kill after 30s and let the caller degrade.
export const quietRunner: BuildRunner = (cmd, args, opts) =>
  new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    const timer = setTimeout(() => child.kill('SIGKILL'), 30_000)
    child.stdout?.on('data', (b) => { output += b.toString() })
    child.stderr?.on('data', (b) => { output += b.toString() })
    child.on('error', (err) => { clearTimeout(timer); resolve({ code: -1, output: `${output}\n${err.message}` }) })
    child.on('close', (code) => { clearTimeout(timer); resolve({ code: code ?? -1, output }) })
  })

export function parseNixpacksPlan(text: string): NixpacksPlan | null {
  try {
    const j = JSON.parse(text)
    // Real plans (nixpacks ≥1.x) leave `providers` empty and name the matched provider(s) in the
    // NIXPACKS_METADATA build variable instead.
    const listed = Array.isArray(j.providers) ? j.providers : []
    const meta = typeof j.variables?.NIXPACKS_METADATA === 'string'
      ? j.variables.NIXPACKS_METADATA.split(',').map((s: string) => s.trim()).filter(Boolean)
      : []
    return {
      providers: listed.length ? listed : meta,
      installCommand: j.phases?.install?.cmds?.join(' && ') || undefined,
      buildCommand: j.phases?.build?.cmds?.join(' && ') || undefined,
      startCommand: j.start?.cmd || undefined,
    }
  } catch {
    return null
  }
}

export async function nixpacksPlan(dir: string, run: BuildRunner = quietRunner): Promise<NixpacksPlan | null> {
  const { code, output } = await run('nixpacks', ['plan', dir], { cwd: dir, env: process.env as Record<string, string> })
  if (code !== 0) return null
  return parseNixpacksPlan(output)
}

// `nixpacks build --out <dir>` generates .nixpacks/Dockerfile and skips Docker entirely. The out
// dir is a temp dir so the user's source tree stays clean (the platform writes into the source
// dir because it builds from a scratch clone — a local verify must not).
export async function nixpacksGeneratedDockerfile(dir: string, run: BuildRunner = quietRunner): Promise<string | null> {
  const out = mkdtempSync(join(tmpdir(), 'insta-nixpacks-'))
  try {
    const { code } = await run('nixpacks', ['build', dir, '--out', out], { cwd: dir, env: process.env as Record<string, string> })
    if (code !== 0) return null
    const generated = join(out, '.nixpacks', 'Dockerfile')
    return existsSync(generated) ? readFileSync(generated, 'utf8') : null
  } finally {
    rmSync(out, { recursive: true, force: true })
  }
}

// Quiet probe — no install, no output. `insta build` advertises itself as local and offline, so
// unlike deploy's ensureFlyctl it must never download anything or write to stdout (which would
// corrupt --json); when nixpacks is missing the command degrades to Dockerfile-only checks and
// the report's nextAction says how to install it.
export async function nixpacksAvailable(run: BuildRunner = quietRunner): Promise<boolean> {
  const { code } = await run('nixpacks', ['--version'], { cwd: '.', env: process.env as Record<string, string> })
  return code === 0
}
