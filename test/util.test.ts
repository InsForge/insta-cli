import { describe, it, expect, vi, afterEach, afterAll } from 'vitest'
import { serializeEnv, handleApproval, nextActionsLines, openUrlSpawn } from '../src/util.js'

// The OAuth authorize URL is hostile to BOTH Windows shells: cmd.exe splits an unquoted line at
// every bare `&` (the tester-reported "querystring must have required property 'redirect'"), and
// even inside quotes cmd expands `%…%` sequences — which is all a percent-encoded redirect is.
// So the Windows launch must reach the browser without any shell parsing the URL: PowerShell
// -EncodedCommand, where the whole Start-Process line travels as base64(UTF-16LE).
describe('openUrlSpawn', () => {
  const oauthUrl = 'https://api.instacloud.com/auth/cli/authorize?provider=github&redirect=http%3A%2F%2F127.0.0.1%3A51234%2Fcallback&state=abc123'
  const decodePs = (args: string[]): string => Buffer.from(args[args.length - 1]!, 'base64').toString('utf16le')

  it('win32: base64-encoded Start-Process carries the URL byte-for-byte (& and %XX intact)', () => {
    const { cmd, args } = openUrlSpawn(oauthUrl, 'win32')
    expect(cmd).toBe('powershell')
    expect(args.slice(0, -1)).toEqual(['-NoProfile', '-NonInteractive', '-EncodedCommand'])
    expect(decodePs(args)).toBe(`Start-Process '${oauthUrl}'`)
  })

  it('win32: an embedded single quote is doubled, so it cannot end the PS literal', () => {
    const { args } = openUrlSpawn("https://x.test/?a='b'", 'win32')
    expect(decodePs(args)).toBe("Start-Process 'https://x.test/?a=''b'''")
  })

  it('darwin/linux: plain single-arg launchers', () => {
    expect(openUrlSpawn(oauthUrl, 'darwin')).toEqual({ cmd: 'open', args: [oauthUrl] })
    expect(openUrlSpawn(oauthUrl, 'linux')).toEqual({ cmd: 'xdg-open', args: [oauthUrl] })
  })
})

describe('serializeEnv', () => {
  it('quotes and escapes values; ends with newline', () => {
    const out = serializeEnv({ DATABASE_URL: 'postgres://u:p@h/db', A: 'x"y\\z' })
    expect(out).toContain('DATABASE_URL="postgres://u:p@h/db"')
    expect(out).toContain('A="x\\"y\\\\z"')
    expect(out.endsWith('\n')).toBe(true)
  })

  it('empty bundle still ends with a newline', () => {
    expect(serializeEnv({})).toBe('\n')
  })
})

// A pending gate is a diagnostic, not a result: the hint must go to stderr (stdout may be
// redirected into a creds file or a JSON parser) and the process must exit non-zero — 2, distinct
// from die()'s generic 1, so scripts/agents can branch on "approvable, re-run after approval".
describe('handleApproval', () => {
  const stdout: string[] = []
  const stderr: string[] = []
  const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation((c: any) => { stdout.push(String(c)); return true })
  const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation((c: any) => { stderr.push(String(c)); return true })
  afterEach(() => { stdout.length = 0; stderr.length = 0; process.exitCode = undefined })
  afterAll(() => { outSpy.mockRestore(); errSpy.mockRestore() })

  const gated = { status: 202, body: { status: 'approval_required', action: 'deploy', approvalId: 'a1' } }

  it('202: returns true, hint on stderr, stdout untouched, exit code 2', () => {
    expect(handleApproval(gated)).toBe(true)
    expect(stderr.join('')).toMatch(/approval required for deploy — run: insta approvals approve a1/)
    expect(stdout.join('')).toBe('')
    expect(process.exitCode).toBe(2)
  })

  it('202 + json: raw envelope on stdout, hint still on stderr, exit code 2', () => {
    expect(handleApproval(gated, true)).toBe(true)
    expect(JSON.parse(stdout.join(''))).toEqual(gated.body)
    expect(stdout.join('')).not.toMatch(/approval required for/)
    expect(stderr.join('')).toMatch(/approval required for deploy/)
    expect(process.exitCode).toBe(2)
  })

  it('returns false on a normal response and touches neither stream nor exit code', () => {
    expect(handleApproval({ status: 200, body: { ok: true } })).toBe(false)
    expect(stdout.join('')).toBe('')
    expect(stderr.join('')).toBe('')
    expect(process.exitCode).toBeUndefined()
  })
})

describe('nextActionsLines', () => {
  it('renders a mapped op as an insta command with args, plus its reason', () => {
    const lines = nextActionsLines([{ op: 'service.add', reason: 'Add a service first.', args: { type: 'postgres', name: 'db' } }])
    expect(lines[0]).toBe('Next:')
    expect(lines.join('\n')).toContain('insta services add postgres db')
    expect(lines.join('\n')).toContain('Add a service first.')
  })

  it('degrades to reason-only for an unknown op and never crashes', () => {
    const lines = nextActionsLines([{ op: 'totally.unknown', reason: 'Do the thing.' }])
    expect(lines.join('\n')).toContain('Do the thing.')
  })

  it('marks gated actions', () => {
    const lines = nextActionsLines([{ op: 'deploy', reason: 'Deploy it.', gated: true, args: {} }])
    expect(lines.join('\n')).toContain('needs approval')
  })

  it('returns [] for empty/absent input', () => {
    expect(nextActionsLines(undefined)).toEqual([])
    expect(nextActionsLines([])).toEqual([])
  })

  it('renders metrics/logs hints with the compute target (runnable command)', () => {
    const metricsLines = nextActionsLines([{ op: 'metrics', reason: 'Check metrics.', args: { projectId: 'pr_1' } }])
    expect(metricsLines.join('\n')).toContain('insta metrics compute')

    const logsLines = nextActionsLines([{ op: 'logs', reason: 'Check logs.', args: { projectId: 'pr_1' } }])
    expect(logsLines.join('\n')).toContain('insta logs compute')
  })
})
