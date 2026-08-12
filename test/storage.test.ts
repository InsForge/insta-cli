// `insta storage` seams — all pure or DI'd, so nothing here reaches a backend.
import { describe, it, expect } from 'vitest'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  parseObjectLimit, objectsPath, objectDownloadPath, objectListLine,
  outputPath, fetchPresigned, saveObject,
} from '../src/commands/storage.js'
import { resolveSoleService } from '../src/commands/services.js'

describe('parseObjectLimit', () => {
  it('accepts the route range', () => {
    expect(parseObjectLimit('1')).toBe(1)
    expect(parseObjectLimit('100')).toBe(100)
    expect(parseObjectLimit('1000')).toBe(1000)
  })
  it('rejects out-of-range and junk locally, before any request', () => {
    for (const raw of ['0', '-1', '1001', '2.5', '', 'lots']) {
      expect(() => parseObjectLimit(raw), raw).toThrow(/1\.\.1000/)
    }
  })
})

describe('objectsPath', () => {
  it('builds the listing query, omitting absent params', () => {
    expect(objectsPath('pr_1', 'svc_1', { branch: 'main', prefix: 'docs/', limit: 50 }))
      .toBe('/projects/pr_1/services/svc_1/objects?branch=main&prefix=docs%2F&limit=50')
    expect(objectsPath('pr_1', 'svc_1', {})).toBe('/projects/pr_1/services/svc_1/objects')
  })
  it('carries the cursor for the next page', () => {
    expect(objectsPath('pr_1', 'svc_1', { cursor: 'tok/en+1' })).toContain('cursor=tok%2Fen%2B1')
  })
  it('is also the DELETE target, with the key in the query — never a path segment', () => {
    const path = objectsPath('pr_1', 'svc_1', { branch: 'main', key: 'a/b/c.txt' })
    expect(path).toBe('/projects/pr_1/services/svc_1/objects?branch=main&key=a%2Fb%2Fc.txt')
  })
  // Keys are arbitrary bytes; an unencoded `&` or `#` would break the query.
  it('encodes awkward keys and prefixes (& # space non-ASCII)', () => {
    expect(objectsPath('pr_1', 'svc_1', { key: 'a&b #1 café.png' }))
      .toBe('/projects/pr_1/services/svc_1/objects?key=a%26b+%231+caf%C3%A9.png')
  })
})

describe('objectDownloadPath', () => {
  it('is a static subpath of the collection, so the listing route cannot shadow it', () => {
    expect(objectDownloadPath('pr_1', 'svc_1', { branch: 'main', key: 'a/b.txt' }))
      .toBe('/projects/pr_1/services/svc_1/objects/download?branch=main&key=a%2Fb.txt')
  })
  it('omits branch when the project default is wanted', () => {
    expect(objectDownloadPath('pr_1', 'svc_1', { key: 'x.txt' }))
      .toBe('/projects/pr_1/services/svc_1/objects/download?key=x.txt')
  })
})

describe('objectListLine', () => {
  it('renders size, modified, key with the fixed-width columns aligned', () => {
    expect(objectListLine({ key: 'docs/a.pdf', size: 8_000_000, lastModified: '2026-08-12T10:00:00.000Z' }))
      .toBe('   7.6 MiB  2026-08-12T10:00:00.000Z  docs/a.pdf')
  })
  it('never fakes a zero for a field the platform omitted', () => {
    expect(objectListLine({ key: 'x' })).toBe('         —  —                         x')
  })
})

describe('outputPath', () => {
  it('defaults to the last segment of the key', () => {
    expect(outputPath('docs/reports/q3.pdf')).toBe('q3.pdf')
    expect(outputPath('flat.txt')).toBe('flat.txt')
  })
  it('-o wins verbatim', () => {
    expect(outputPath('docs/q3.pdf', 'out/other.pdf')).toBe('out/other.pdf')
  })
  // Using only the last segment is what makes a hostile key harmless — nothing escapes cwd.
  it('cannot be steered out of cwd by a traversal key', () => {
    expect(outputPath('../../etc/passwd')).toBe('passwd')
    expect(outputPath('/etc/passwd')).toBe('passwd')
  })
  it('asks for -o when the key has no filename', () => {
    expect(() => outputPath('docs/')).toThrow(/pass -o/)
    expect(() => outputPath('')).toThrow(/pass -o/)
  })
})

describe('fetchPresigned', () => {
  it('returns the provider bytes on 200', async () => {
    const fake = (async () => new Response(new Uint8Array([1, 2, 3]))) as unknown as typeof fetch
    expect(Array.from(await fetchPresigned('https://provider/x', fake))).toEqual([1, 2, 3])
  })
  // A 60s TTL means an expired link is the likely failure, so say what to do about it.
  it('names the expiry as the likely cause when the provider refuses', async () => {
    const fake = (async () => new Response('', { status: 403 })) as unknown as typeof fetch
    await expect(fetchPresigned('https://provider/x', fake)).rejects.toThrow(/presigned URL lives ~60s/)
  })
})

describe('saveObject', () => {
  it('writes the fetched bytes to the given path and reports the size', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'insta-storage-'))
    const out = join(dir, 'q3.pdf')
    const n = await saveObject('https://provider/q3.pdf', out, {
      fetchBytes: async () => new Uint8Array([0x25, 0x50, 0x44, 0x46]),
    })
    expect(n).toBe(4)
    expect(readFileSync(out).toString('latin1')).toBe('%PDF')
  })
  it('writes nothing when the fetch fails', async () => {
    let wrote = false
    await expect(saveObject('https://provider/x', 'x', {
      fetchBytes: async () => { throw new Error('boom') },
      writeImpl: async () => { wrote = true },
    })).rejects.toThrow('boom')
    expect(wrote).toBe(false)
  })
})

describe('resolveSoleService (storage)', () => {
  const one = [{ id: 'a', type: 'postgres', name: 'db' }, { id: 'b', type: 'storage', name: 'files' }]
  const two = [...one, { id: 'c', type: 'storage', name: 'assets' }]
  it('returns the sole storage service when --service is omitted', () => {
    expect(resolveSoleService(one, 'storage').id).toBe('b')
  })
  it('resolves by name and lists the choices when ambiguous', () => {
    expect(resolveSoleService(two, 'storage', 'assets').id).toBe('c')
    expect(() => resolveSoleService(two, 'storage')).toThrow(/multiple storage services — specify one: files, assets/)
  })
  it('errors when the branch has no storage service, pointing at `services add`', () => {
    expect(() => resolveSoleService([one[0]!], 'storage')).toThrow(/insta services add storage <name>/)
    expect(() => resolveSoleService(two, 'storage', 'nope')).toThrow(/storage service not found: nope/)
  })
})
