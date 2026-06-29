import { describe, it, expect } from 'vitest'
import { serializeEnv, handleApproval } from '../src/util.js'

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
