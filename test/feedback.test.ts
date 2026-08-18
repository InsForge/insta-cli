import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { buildPayload, feedback, submit } from '../src/commands/feedback.js'
import { clean, redactSensitive, truncateMiddle } from '../src/redact.js'

const valid = {
  type: 'bug',
  component: 'cli',
  title: 'deploy drops --branch',
  detail: 'insta deploy --branch feat ignored the flag and deployed to main',
}

function fetchOk(body: unknown, status = 200): { fetchImpl: typeof fetch; calls: Array<{ url: string; init: RequestInit }> } {
  const calls: Array<{ url: string; init: RequestInit }> = []
  const fetchImpl = (async (url: any, init: any) => {
    calls.push({ url: String(url), init })
    return new Response(JSON.stringify(body), { status })
  }) as typeof fetch
  return { fetchImpl, calls }
}

describe('buildPayload', () => {
  it('assembles context and defaults severity', async () => {
    const p = await buildPayload(valid, { cliVersion: '9.9.9' })
    expect(p.severity).toBe('minor')
    expect(p.source).toBe('cli')
    expect(p.client_version).toBe('9.9.9')
    expect(p.node_version).toBe(process.version)
    expect(typeof p.os).toBe('string')
  })

  it('rejects bad enums with a self-teaching message (non-interactive agents read this)', async () => {
    await expect(buildPayload({ ...valid, type: 'complaint' }, { cliVersion: 'x' })).rejects.toThrow(
      /--type must be one of: bug, feature-request, friction, other/,
    )
    await expect(buildPayload({ ...valid, component: 'sdk' }, { cliVersion: 'x' })).rejects.toThrow(
      /--component must be one of: cli, mcp, platform, skills, docs, other/,
    )
    await expect(buildPayload({ ...valid, severity: 'urgent' }, { cliVersion: 'x' })).rejects.toThrow(
      /--severity must be one of/,
    )
  })

  it('requires title and detail', async () => {
    await expect(buildPayload({ ...valid, title: '  ' }, { cliVersion: 'x' })).rejects.toThrow(/--title is required/)
    await expect(buildPayload({ ...valid, detail: undefined }, { cliVersion: 'x' })).rejects.toThrow(
      /--detail \(or --file <path>\) is required/,
    )
  })

  it('redacts PII in free-text fields before they leave the machine', async () => {
    const token = 'insta_' + 'a1b2c3d4'.repeat(4)
    const p = await buildPayload(
      { ...valid, error: `login failed for jane@example.com using ${token} at /Users/jane/repo` },
      { cliVersion: 'x' },
    )
    expect(p.error).not.toContain('jane@example.com')
    expect(p.error).not.toContain(token)
    expect(p.error).toContain('[REDACTED_EMAIL]')
    expect(p.error).toContain('[REDACTED_KEY]')
    expect(p.error).toContain('~/repo')
  })

  it('does NOT redact MCP tool names sharing the insta_ prefix', async () => {
    const p = await buildPayload(
      { ...valid, error: 'insta_feedback and insta_storage_download_url returned invalid_request' },
      { cliVersion: 'x' },
    )
    expect(p.error).toContain('insta_feedback')
    expect(p.error).toContain('insta_storage_download_url')
  })

  it('--file reads text, rejects oversized and binary files', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'insta-feedback-'))
    const textFile = join(dir, 'detail.txt')
    writeFileSync(textFile, 'deploy failed with exit 1')
    const p = await buildPayload({ ...valid, detail: undefined, file: textFile }, { cliVersion: 'x' })
    expect(p.detail).toBe('deploy failed with exit 1')

    const bigFile = join(dir, 'big.log')
    writeFileSync(bigFile, 'x'.repeat(300 * 1024))
    await expect(buildPayload({ ...valid, detail: undefined, file: bigFile }, { cliVersion: 'x' })).rejects.toThrow(
      /max 262144.*trim the file/,
    )

    const binFile = join(dir, 'blob.bin')
    writeFileSync(binFile, Buffer.from([0x50, 0x4b, 0x00, 0x01, 0x02]))
    await expect(buildPayload({ ...valid, detail: undefined, file: binFile }, { cliVersion: 'x' })).rejects.toThrow(
      /looks binary/,
    )
  })

  it('caps over-long fields with middle truncation', async () => {
    const p = await buildPayload({ ...valid, detail: 'a'.repeat(3000) + 'z'.repeat(3000) }, { cliVersion: 'x' })
    const detail = p.detail as string
    expect(detail.length).toBeLessThan(4100)
    expect(detail).toContain('chars truncated')
    expect(detail.startsWith('aaa')).toBe(true)
    expect(detail.endsWith('zzz')).toBe(true)
  })
})

describe('submit', () => {
  it('POSTs the payload with the public ingest token', async () => {
    const { fetchImpl, calls } = fetchOk({ id: 'f-1', status: 'received' })
    const result = await submit({ a: 1 }, fetchImpl)
    expect(result).toEqual({ status: 'received', id: 'f-1' })
    expect(calls).toHaveLength(1)
    expect(calls[0].init.method).toBe('POST')
    expect((calls[0].init.headers as Record<string, string>).Authorization).toMatch(/^Bearer /)
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ a: 1 })
  })

  it('maps duplicate folding', async () => {
    const { fetchImpl } = fetchOk({ id: 'f-1', status: 'duplicate' })
    expect(await submit({}, fetchImpl)).toEqual({ status: 'duplicate', id: 'f-1' })
  })

  it('returns server errors as a result, never throws (429, 500)', async () => {
    const { fetchImpl } = fetchOk({ error: 'rate limit exceeded: max 20 reports per hour' }, 429)
    expect(await submit({}, fetchImpl)).toEqual({
      status: 'error',
      error: 'rate limit exceeded: max 20 reports per hour',
    })
  })

  it('returns network failures as a result, never throws', async () => {
    const fetchImpl = (async () => {
      throw new Error('getaddrinfo ENOTFOUND')
    }) as unknown as typeof fetch
    const result = await submit({}, fetchImpl)
    expect(result.status).toBe('error')
    expect((result as { error: string }).error).toContain('ENOTFOUND')
  })
})

describe('feedback command', () => {
  afterEach(() => {
    process.exitCode = 0
  })

  it('non-interactive + missing required flags throws instead of prompting (agents must never hang)', async () => {
    await expect(feedback({ title: 'x' }, { interactive: false, cliVersion: 'x' })).rejects.toThrow(
      /--type must be one of/,
    )
  })

  it('--json validation errors stay machine-readable: JSON on stdout + exit code 1, no throw', async () => {
    await expect(feedback({ title: 'x', json: true }, { interactive: false, cliVersion: 'x' })).resolves.toBeUndefined()
    expect(process.exitCode).toBe(1)
  })

  it('a failed submission does not throw — feedback must never fail the main task', async () => {
    const fetchImpl = (async () => {
      throw new Error('connect ECONNREFUSED')
    }) as unknown as typeof fetch
    await expect(feedback({ ...valid, json: true }, { interactive: false, cliVersion: 'x', fetchImpl })).resolves.toBeUndefined()
  })
})

describe('redact', () => {
  it('scrubs JWTs, bearer tokens, URL credentials', () => {
    const out = redactSensitive(
      'postgres://admin:hunter2@db.example.com Bearer abc123def456 eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdef',
    )
    expect(out).toContain('postgres://[REDACTED]@')
    expect(out).toContain('Bearer [REDACTED]')
    expect(out).toContain('[REDACTED_JWT]')
    expect(out).not.toContain('hunter2')
  })

  it('redacts real insta_ tokens but keeps insta_* tool names', () => {
    const out = redactSensitive(`insta_deploy failed with token insta_${'x'.repeat(30)}`)
    expect(out).toContain('insta_deploy')
    expect(out).toContain('[REDACTED_KEY]')
    expect(out).not.toContain('x'.repeat(30))
  })

  it('keeps private IPs, redacts public ones', () => {
    const out = redactSensitive('from 127.0.0.1 and 192.168.0.10 to 34.120.9.1')
    expect(out).toContain('127.0.0.1')
    expect(out).toContain('192.168.0.10')
    expect(out).toContain('[REDACTED_IP]')
    expect(out).not.toContain('34.120.9.1')
  })

  it('clean trims, redacts, then truncates in that order', () => {
    expect(clean('   ', 100)).toBeUndefined()
    expect(clean(undefined, 100)).toBeUndefined()
    const long = 'jane@example.com ' + 'x'.repeat(300)
    expect(clean(long, 50)).toContain('[REDACTED_EMAIL]')
  })

  it('truncateMiddle marks the removed span', () => {
    expect(truncateMiddle('abc', 10)).toBe('abc')
    expect(truncateMiddle('a'.repeat(200), 50)).toContain('chars truncated')
  })
})
