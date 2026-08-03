// `insta compute limits` / `insta db limits` — the ceiling controls that replace spec picking.
// The parsing seam is what these pin: a user types "1gb", the API takes MB, and getting that
// conversion wrong sets a ceiling an order of magnitude off in either direction.
import { describe, it, expect } from 'vitest'
import { parseMemoryMb } from '../src/commands/compute.js'

describe('parseMemoryMb', () => {
  it('treats a bare number as MB', () => {
    expect(parseMemoryMb('512')).toBe(512)
    expect(parseMemoryMb('256')).toBe(256)
  })

  it('accepts MB units in the forms people actually type', () => {
    for (const raw of ['512mb', '512MB', '512m', '512 MB', ' 512mib ']) {
      expect(parseMemoryMb(raw), raw).toBe(512)
    }
  })

  it('converts GB to MB', () => {
    expect(parseMemoryMb('1gb')).toBe(1024)
    expect(parseMemoryMb('2G')).toBe(2048)
    expect(parseMemoryMb('1.5gb')).toBe(1536)
    expect(parseMemoryMb('8Gi')).toBe(8192)
  })

  it('rejects nonsense rather than guessing', () => {
    for (const raw of ['', 'lots', '1tb', '-1gb', '0', 'gb', '1 2gb']) {
      expect(() => parseMemoryMb(raw), raw).toThrow()
    }
  })

  // The error names an example, because the failure mode without one is a user retrying the same
  // invalid string in a different case.
  it('suggests a valid form in the error', () => {
    expect(() => parseMemoryMb('huge')).toThrow(/try 512mb, 1gb, 2gb/)
  })
})
