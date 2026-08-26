// `insta compute exec` — the argv-splitting seam (the only place in the CLI a bare `--` has special
// meaning), the --timeout bounds, and the exec request-body mapping. Mirrors the pure-function test
// pattern used throughout this suite (parseCpu/parseMemoryMb in limits.test.ts, parseVolumeGib in
// volume.test.ts): the network-touching orchestration itself is untested here, same as
// computeStart/computeVolume/computeLimits.
import { describe, it, expect, vi, afterEach, afterAll } from 'vitest'
import { splitExecArgs, resolveExecTarget, parseTimeoutSec, execRequestBody, computeExec, applyExecResult } from '../src/commands/compute.js'

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
    expect(splitExecArgs(argv, 'linux')).toEqual({ argv })
  })

  it('recovers a command after the npm PowerShell shim consumed --', () => {
    const argv = ['node', 'insta', 'compute', 'exec', 'app', 'printenv', 'PORT']
    expect(splitExecArgs(argv, 'win32')).toEqual({
      argv: ['node', 'insta', 'compute', 'exec', 'app'],
      command: ['printenv', 'PORT'],
      windowsFallback: true,
    })
  })

  it('keeps CLI options before the recovered PowerShell command', () => {
    const argv = ['node', 'insta', 'compute', 'exec', '--branch', 'prod', '--timeout=60', 'app', 'echo', '--json']
    expect(splitExecArgs(argv, 'win32')).toEqual({
      argv: ['node', 'insta', 'compute', 'exec', '--branch', 'prod', '--timeout=60', 'app'],
      command: ['echo', '--json'],
      windowsFallback: true,
    })
  })

  it('preserves ambiguous flags after the service and refuses to guess their boundary', () => {
    const argv = ['node', 'insta', 'compute', 'exec', 'app', '--json']
    expect(splitExecArgs(argv, 'win32')).toEqual({
      argv: ['node', 'insta', 'compute', 'exec', 'app'],
      command: ['--json'],
      windowsFallback: true,
      windowsAmbiguous: true,
    })
  })

  it('does not infer the missing separator outside Windows', () => {
    const argv = ['node', 'insta', 'compute', 'exec', 'app', 'echo', 'hi']
    expect(splitExecArgs(argv, 'linux')).toEqual({ argv })
  })

  it('supports a command that is itself empty after --', () => {
    const argv = ['node', 'insta', 'compute', 'exec', 'myservice', '--']
    expect(splitExecArgs(argv)).toEqual({ argv: ['node', 'insta', 'compute', 'exec', 'myservice'], command: [] })
  })

  // The remote command may carry its own `--`, and the PowerShell shim strips only the FIRST one.
  // A surviving `--` is therefore not proof of a separator: splitting on it would drop the real
  // first command token (`echo`) and violate the byte-for-byte remote-argv contract.
  it('preserves a remote literal -- that outlived the PowerShell shim', () => {
    // `insta compute exec app -- echo --` through insta.ps1 reaches node as:
    const argv = ['node', 'insta', 'compute', 'exec', 'app', 'echo', '--']
    expect(splitExecArgs(argv, 'win32')).toEqual({
      argv: ['node', 'insta', 'compute', 'exec', 'app'],
      command: ['echo', '--'],
      windowsFallback: true,
    })
  })

  it('preserves a remote -- in the MIDDLE of a recovered command', () => {
    const argv = ['node', 'insta', 'compute', 'exec', 'app', 'sh', '-c', '--', 'echo hi']
    expect(splitExecArgs(argv, 'win32')).toEqual({
      argv: ['node', 'insta', 'compute', 'exec', 'app'],
      command: ['sh', '-c', '--', 'echo hi'],
      windowsFallback: true,
    })
  })

  // The whole point: both Windows entry points must hand the platform the SAME remote argv.
  it('lands on the same remote argv whether the shim kept the separator or ate it', () => {
    const remote = ['echo', '--', 'hi']
    const viaCmd = ['node', 'insta', 'compute', 'exec', 'app', '--', ...remote] // insta.cmd keeps --
    const viaPowerShell = ['node', 'insta', 'compute', 'exec', 'app', ...remote] // insta.ps1 ate it
    expect(splitExecArgs(viaCmd, 'win32').command).toEqual(remote)
    expect(splitExecArgs(viaPowerShell, 'win32').command).toEqual(remote)
  })

  it('counts option VALUES as options, not operands, when locating the separator', () => {
    // `--branch prod` must not read as two operands, or the real separator below looks remote.
    const kept = ['node', 'insta', 'compute', 'exec', '--branch', 'prod', 'app', '--', 'echo', '--']
    expect(splitExecArgs(kept, 'win32')).toEqual({
      argv: ['node', 'insta', 'compute', 'exec', '--branch', 'prod', 'app'],
      command: ['echo', '--'],
    })
    const eaten = ['node', 'insta', 'compute', 'exec', '--branch', 'prod', 'app', 'echo', '--']
    expect(splitExecArgs(eaten, 'win32')).toEqual({
      argv: ['node', 'insta', 'compute', 'exec', '--branch', 'prod', 'app'],
      command: ['echo', '--'],
      windowsFallback: true,
    })
  })

  // One shape stays irreducibly ambiguous: a single operand followed by `--` parses validly BOTH
  // ways (service `printenv` + command `PORT`, or shim-eaten separator + command `printenv -- PORT`).
  // We take the separator reading, which is what every non-PowerShell shell means. When that
  // reading is wrong, resolveComputeServiceId fails loudly ("compute service not found: printenv")
  // rather than running the wrong command — degradation to an error, never to silent corruption.
  it('takes the separator reading for the one shape that parses both ways', () => {
    const argv = ['node', 'insta', 'compute', 'exec', 'printenv', '--', 'PORT']
    expect(splitExecArgs(argv, 'win32')).toEqual({
      argv: ['node', 'insta', 'compute', 'exec', 'printenv'],
      command: ['PORT'],
    })
  })

  it('preserves a command token that itself looks like a flag', () => {
    const argv = ['node', 'insta', 'compute', 'exec', '--', '--help']
    expect(splitExecArgs(argv)).toEqual({ argv: ['node', 'insta', 'compute', 'exec'], command: ['--help'] })
  })
})

describe('resolveExecTarget', () => {
  const services = [{ id: 'svc_1', type: 'compute', name: 'app' }]

  it('keeps an explicit service that exists', () => {
    expect(resolveExecTarget(services, 'app', ['printenv', 'PORT'], true)).toEqual({
      serviceName: 'app', command: ['printenv', 'PORT'],
    })
  })

  it('recovers an omitted service by restoring the first command token', () => {
    expect(resolveExecTarget(services, 'printenv', ['PORT'], true)).toEqual({
      serviceName: undefined, command: ['printenv', 'PORT'],
    })
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
  it('rejects ambiguous PowerShell flags before any network/config access', async () => {
    await expect(computeExec('svc', ['--json'], {}, { windowsFallback: true, windowsAmbiguous: true }))
      .rejects.toThrow(/PowerShell removed.*insta\.cmd/)
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

  it('202: exits 2 with the human approval hint on stderr, stdout untouched (non-json)', () => {
    applyExecResult({ status: 202, body: { status: 'approval_required', action: 'deploy', approvalId: 'appr_1' } })
    expect(process.exitCode).toBe(2)
    expect(stderr.join('')).toMatch(/approval required for deploy — run: insta approvals approve appr_1/)
    expect(stdout.join('')).toBe('')
  })

  it('202: exits 2 and prints the raw envelope with --json (hint on stderr, never stdout)', () => {
    const body = { status: 'approval_required', action: 'deploy', approvalId: 'appr_1', message: 'needs review' }
    applyExecResult({ status: 202, body }, true)
    expect(process.exitCode).toBe(2)
    expect(JSON.parse(stdout.join(''))).toEqual(body)
    expect(stdout.join('')).not.toMatch(/approval required for/)
    expect(stderr.join('')).toMatch(/approval required for deploy/)
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
