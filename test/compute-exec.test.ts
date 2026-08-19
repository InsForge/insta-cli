// `insta compute exec` — the argv-splitting seam (the only place in the CLI a bare `--` has special
// meaning), the --timeout bounds, and the exec request-body mapping. Mirrors the pure-function test
// pattern used throughout this suite (parseCpu/parseMemoryMb in limits.test.ts, parseVolumeGib in
// volume.test.ts): the network-touching orchestration itself is untested here, same as
// computeStart/computeVolume/computeLimits.
import { describe, it, expect, vi, afterEach, afterAll } from 'vitest'
import { splitExecArgs, parseTimeoutSec, execRequestBody, computeExec, applyExecResult } from '../src/commands/compute.js'

describe('splitExecArgs', () => {
  it('splits the command out at the first literal -- after `compute exec`', () => {
    const argv = ['node', 'insta', 'compute', 'exec', 'myservice', '--branch', 'prod', '--', 'echo', 'hi', '--flag']
    expect(splitExecArgs(argv)).toEqual({
      argv: ['node', 'insta', 'compute', 'exec', 'myservice', '--branch', 'prod'],
      command: ['echo', 'hi', '--flag'],
    })
  })

  it('supports an omitted service name', () => {
    const argv = ['node', 'insta', 'compute', 'exec', '--', 'echo', 'hi']
    expect(splitExecArgs(argv)).toEqual({ argv: ['node', 'insta', 'compute', 'exec'], command: ['echo', 'hi'] })
  })

  it('leaves argv untouched for any other invocation', () => {
    const argv = ['node', 'insta', 'compute', 'start', 'myservice']
    expect(splitExecArgs(argv)).toEqual({ argv })
  })

  it('leaves argv untouched (command undefined) when there is no -- at all', () => {
    const argv = ['node', 'insta', 'compute', 'exec', 'myservice']
    expect(splitExecArgs(argv)).toEqual({ argv })
  })

  it('supports a command that is itself empty after --', () => {
    const argv = ['node', 'insta', 'compute', 'exec', 'myservice', '--']
    expect(splitExecArgs(argv)).toEqual({ argv: ['node', 'insta', 'compute', 'exec', 'myservice'], command: [] })
  })

  it('preserves a command token that itself looks like a flag', () => {
    const argv = ['node', 'insta', 'compute', 'exec', '--', '--help']
    expect(splitExecArgs(argv)).toEqual({ argv: ['node', 'insta', 'compute', 'exec'], command: ['--help'] })
  })
})

describe('parseTimeoutSec', () => {
  it('accepts the documented bounds', () => {
    expect(parseTimeoutSec('1')).toBe(1)
    expect(parseTimeoutSec('180')).toBe(180)
    expect(parseTimeoutSec('30')).toBe(30)
  })
  it('rejects out-of-range and non-integer values locally', () => {
    for (const raw of ['0', '181', '301', '-1', '1.5', 'abc', '']) {
      expect(() => parseTimeoutSec(raw), raw).toThrow(/invalid timeout/)
    }
  })
})

describe('execRequestBody', () => {
  it('omits timeoutSec when not given, so the server applies its own default', () => {
    expect(execRequestBody(['echo', 'hi'])).toEqual({ command: ['echo', 'hi'] })
  })
  it('sends timeoutSec when given', () => {
    expect(execRequestBody(['echo', 'hi'], 60)).toEqual({ command: ['echo', 'hi'], timeoutSec: 60 })
  })
})

describe('computeExec validation (throws before any network/config access)', () => {
  it('rejects an undefined or empty command with a usage message', async () => {
    await expect(computeExec('svc', undefined, {})).rejects.toThrow(/usage: insta compute exec/)
    await expect(computeExec('svc', [], {})).rejects.toThrow(/usage: insta compute exec/)
  })
  it('rejects an invalid --timeout', async () => {
    await expect(computeExec('svc', ['echo'], { timeout: '9999' })).rejects.toThrow(/invalid timeout/)
  })
})

// applyExecResult takes a plain {status, body} — the same shape handleApproval already takes — so
// it's unit-testable without a network mock, same pattern as execRequestBody above.
describe('applyExecResult', () => {
  const stdout: string[] = []
  const stderr: string[] = []
  const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation((c: any) => { stdout.push(String(c)); return true })
  const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation((c: any) => { stderr.push(String(c)); return true })
  afterEach(() => { stdout.length = 0; stderr.length = 0; process.exitCode = undefined })
  afterAll(() => { outSpy.mockRestore(); errSpy.mockRestore() })

  it('202: exits 1 and prints the human approval hint (non-json)', () => {
    applyExecResult({ status: 202, body: { status: 'approval_required', action: 'deploy', approvalId: 'appr_1' } })
    expect(process.exitCode).toBe(1)
    expect(stdout.join('')).toMatch(/approval required for deploy — run: insta approvals approve appr_1/)
  })

  it('202: exits 1 and prints the raw envelope with --json (not the human hint)', () => {
    const body = { status: 'approval_required', action: 'deploy', approvalId: 'appr_1', message: 'needs review' }
    applyExecResult({ status: 202, body }, true)
    expect(process.exitCode).toBe(1)
    expect(JSON.parse(stdout.join(''))).toEqual(body)
    expect(stdout.join('')).not.toMatch(/approval required for/)
  })

  it('200: passes a normal exit code through untouched', () => {
    applyExecResult({ status: 200, body: { exitCode: 0, stdout: 'hi\n', stderr: '' } })
    expect(process.exitCode).toBe(0)
    expect(stdout.join('')).toBe('hi\n')
  })

  it('200: passes exit code through with --json too', () => {
    applyExecResult({ status: 200, body: { exitCode: 7, stdout: '', stderr: 'boom\n' } }, true)
    expect(process.exitCode).toBe(7)
  })

  it('200: clamps the -1 unknown-exit sentinel to 1 with a stderr note', () => {
    applyExecResult({ status: 200, body: { exitCode: -1, stdout: '', stderr: '' } })
    expect(process.exitCode).toBe(1)
    expect(stderr.join('')).toMatch(/note: remote exit code -1 out of range — exiting 1/)
  })

  it('200: clamps an out-of-range positive exit code (256) to 1 with a stderr note', () => {
    applyExecResult({ status: 200, body: { exitCode: 256, stdout: '', stderr: '' } })
    expect(process.exitCode).toBe(1)
    expect(stderr.join('')).toMatch(/note: remote exit code 256 out of range — exiting 1/)
  })

  it('200: 255 is the top of the valid range and passes through untouched', () => {
    applyExecResult({ status: 200, body: { exitCode: 255, stdout: '', stderr: '' } })
    expect(process.exitCode).toBe(255)
  })
})
