// `insta compute exec` — the argv-splitting seam (the only place in the CLI a bare `--` has special
// meaning), the --timeout bounds, and the exec request-body mapping. Mirrors the pure-function test
// pattern used throughout this suite (parseCpu/parseMemoryMb in limits.test.ts, parseVolumeGib in
// volume.test.ts): the network-touching orchestration itself is untested here, same as
// computeStart/computeVolume/computeLimits.
import { describe, it, expect } from 'vitest'
import { splitExecArgs, parseTimeoutSec, execRequestBody, computeExec } from '../src/commands/compute.js'

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
    expect(parseTimeoutSec('300')).toBe(300)
    expect(parseTimeoutSec('30')).toBe(30)
  })
  it('rejects out-of-range and non-integer values locally', () => {
    for (const raw of ['0', '301', '-1', '1.5', 'abc', '']) {
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
