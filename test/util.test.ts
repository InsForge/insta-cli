import { describe, it, expect } from 'vitest'
import { serializeEnv, handleApproval, nextActionsLines } from '../src/util.js'

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

describe('handleApproval', () => {
  it('returns true on a 202 approval_required', () => {
    expect(handleApproval({ status: 202, body: { status: 'approval_required', action: 'deploy', approvalId: 'a1' } })).toBe(true)
  })
  it('returns false on a normal response', () => {
    expect(handleApproval({ status: 200, body: { ok: true } })).toBe(false)
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
