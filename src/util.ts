// Output + small pure helpers (env serialization is unit-tested).
import { createInterface } from 'node:readline'
import { spawn } from 'node:child_process'

// Best-effort: open a URL in the user's default browser. Returns false if we couldn't launch.
export function openUrl(url: string): boolean {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open'
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url]
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true })
    child.on('error', () => {})
    child.unref()
    return true
  } catch { return false }
}

export function die(msg: string): never {
  process.stderr.write(`error: ${msg}\n`)
  process.exit(1)
}

export function printJson(v: unknown): void {
  process.stdout.write(JSON.stringify(v, null, 2) + '\n')
}

export function info(msg: string): void {
  process.stdout.write(msg + '\n')
}

// If the platform gated the action (HTTP 202), tell the user how to get it approved. Returns
// true when an approval is pending (caller should stop). The hint goes to STDERR and the exit
// code is set to 2: a pending gate is not success (redirected stdout must never swallow it as
// output), and not a plain error either (die() owns 1) — it's approvable and re-runnable, and
// scripts/agents branch on the distinct code. With json, stdout carries the platform's raw 202
// envelope so a scripted caller can lift approvalId/action.
export function handleApproval(res: { status: number; body: any }, json?: boolean): boolean {
  if (res.status === 202 && res.body?.status === 'approval_required') {
    if (json) printJson(res.body)
    process.stderr.write(`approval required for ${res.body.action} — run: insta approvals approve ${res.body.approvalId}\n`)
    process.exitCode = 2
    return true
  }
  return false
}

export type NextAction = { op: string; reason: string; args?: Record<string, unknown>; gated?: boolean }

// Neutral op → an `insta` command string. Unknown ops fall back to reason-only (no crash).
const OP_COMMAND: Record<string, (a: Record<string, unknown>) => string> = {
  'service.add': (a) => `insta services add ${a.type ?? '<type>'} ${a.name ?? '<name>'}`,
  deploy: (a) => `insta deploy${a.branch ? ` --branch ${a.branch}` : ''}`,
  'secrets.set': (a) => `insta secrets set ${a.name ?? '<NAME>'} ${a.value ?? '<value>'}`,
  metrics: (a) => `insta metrics ${a.target ?? 'compute'}`,
  logs: (a) => `insta logs ${a.target ?? 'compute'}`,
  'approvals.approve': (a) => `insta approvals approve ${a.approvalId ?? '<id>'}`,
}

// Pure — builds the printable lines (unit-tested). Empty input → [].
export function nextActionsLines(actions: NextAction[] | undefined): string[] {
  if (!actions || actions.length === 0) return []
  const lines = ['Next:']
  for (const a of actions) {
    const cmd = OP_COMMAND[a.op]?.(a.args ?? {})
    const gated = a.gated ? '  [needs approval]' : ''
    lines.push(cmd ? `  • ${a.reason}  →  ${cmd}${gated}` : `  • ${a.reason}${gated}`)
  }
  return lines
}

export function renderNextActions(actions: NextAction[] | undefined): void {
  for (const line of nextActionsLines(actions)) info(line)
}

// Serialize a credential bundle to .env text. All values are double-quoted (connection strings
// contain special chars); backslashes and quotes are escaped so dotenv parsers read them back exactly.
export function serializeEnv(bundle: Record<string, string>): string {
  return (
    Object.entries(bundle)
      .map(([k, v]) => `${k}="${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`)
      .join('\n') + '\n'
  )
}

// Hidden password prompt (best-effort: mutes echo on a TTY).
export function promptPassword(label = 'Password: '): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    const stdout = process.stdout as NodeJS.WriteStream & { _writeToOutput?: (s: string) => void }
    process.stdout.write(label)
    let captured = ''
    stdout._writeToOutput = (s: string) => { if (s.includes('\n')) process.stdout.write('\n') }
    rl.on('line', (line) => { captured = line; rl.close() })
    rl.on('close', () => resolve(captured))
  })
}
