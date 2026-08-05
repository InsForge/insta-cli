// Volumes — the persistent disk attached to a service (postgres has one by default; compute
// opts in at creation). These pin the volume seams: the size parser (the only place a user-typed
// Gi becomes a wire integer), the create-body mapping (canonical volumeGib), the free-plan UX rule
// (viewing and attaching-at-default are never pre-blocked client-side — only the backend's 403
// speaks for the paid growth gate), and the db read using the CANONICAL volume* names, not the
// deprecated storage* aliases the platform drops next release.
import { describe, it, expect } from 'vitest'
import { parseVolumeGib, servicesAddRequestBody, servicesAdd, serviceListLine } from '../src/commands/services.js'
import { volumeLines } from '../src/commands/compute.js'
import { dbVolumeLines } from '../src/commands/db.js'

describe('parseVolumeGib', () => {
  it('parses whole Gi, with or without a suffix', () => {
    expect(parseVolumeGib('1')).toBe(1)
    expect(parseVolumeGib('10')).toBe(10)
    expect(parseVolumeGib('10Gi')).toBe(10)
    expect(parseVolumeGib(' 10 gi ')).toBe(10)
    expect(parseVolumeGib('10G')).toBe(10)
  })
  it('rejects fractional, Mi, zero, and junk locally with an example', () => {
    for (const raw of ['', '1.5', '500Mi', '0', '-1', 'lots', '10Ti']) {
      expect(() => parseVolumeGib(raw), raw).toThrow(/invalid volume size/)
    }
    expect(() => parseVolumeGib('huge')).toThrow(/try 1 or 10/)
  })
})

describe('servicesAddRequestBody --volume', () => {
  it('sends volumeGib as a wire integer when passed', () => {
    expect(servicesAddRequestBody('compute', 'api', 'main', { volume: '10' })).toMatchObject({ volumeGib: 10 })
    expect(servicesAddRequestBody('compute', 'api', 'main', { volume: '1Gi' })).toMatchObject({ volumeGib: 1 })
  })
  it('omits volumeGib when the flag is absent (no volume attached)', () => {
    expect(servicesAddRequestBody('compute', 'api', 'main', {})).not.toHaveProperty('volumeGib')
  })
  // The free-plan rule: any plan may pass 1 (the default size) — and larger values just forward;
  // the backend enforces paid/cap, so no client-side plan check exists to test against.
  it('forwards any whole size unjudged — the backend owns the paid/cap gate', () => {
    expect(servicesAddRequestBody('compute', 'api', 'main', { volume: '100' })).toMatchObject({ volumeGib: 100 })
  })
})

describe('servicesAdd --volume validation (throws before any network/config access)', () => {
  it('rejects --volume for a non-compute type, pointing at the db command instead', async () => {
    await expect(servicesAdd('postgres', 'db', { volume: '10' })).rejects.toThrow(/--volume is only valid for compute services/)
    await expect(servicesAdd('storage', 'bkt', { volume: '10' })).rejects.toThrow(/insta db volume --size/)
  })
  it('rejects junk sizes locally instead of deferring to the server', async () => {
    await expect(servicesAdd('compute', 'api', { volume: '1.5' })).rejects.toThrow(/invalid volume size/)
  })
})

describe('serviceListLine with a volume', () => {
  it('shows the volume on compute rows', () => {
    const line = serviceListLine({ type: 'compute', name: 'api', status: 'active', id: 'svc_1', machine_count: 1, volume_gib: 10 })
    expect(line).toBe('compute/api  [active]  x1  vol 10Gi  svc_1')
  })
  it('renders volume-less compute rows unchanged (null and absent alike)', () => {
    const line = serviceListLine({ type: 'compute', name: 'api', status: 'active', id: 'svc_1', machine_count: 2, volume_gib: null })
    expect(line).toBe('compute/api  [active]  x2  svc_1')
  })
})

describe('volumeLines (compute read display)', () => {
  it('shows size, mount path, and the plan cap', () => {
    const lines = volumeLines('api', { sizeGib: 10, mountPath: '/data' }, { volumeGib: 50 })
    expect(lines[0]).toBe('compute api: volume 10Gi at /data  (plan max 50Gi)')
    expect(lines[1]).toMatch(/cap, not a price/)
  })
  it('explains the create-time-only attach when no volume exists', () => {
    const lines = volumeLines('api', null, { volumeGib: 50 })
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatch(/no volume attached/)
    expect(lines[0]).toMatch(/insta services add compute <name> --volume <gi>/)
  })
})

describe('dbVolumeLines (postgres read display)', () => {
  it('reads the canonical volumeGib + cap, and shows region when the instance reports one', () => {
    const lines = dbVolumeLines('default', { volumeGib: 10, volumeSize: '10Gi', cap: { volumeGib: 50 }, region: 'us-east' })
    expect(lines[0]).toBe('postgres default: volume 10Gi  (plan max 50Gi)  us-east')
  })
  it('falls back to volumeSize when volumeGib is absent, and omits missing cap/region', () => {
    expect(dbVolumeLines('default', { volumeSize: '10Gi' })[0]).toBe('postgres default: volume 10Gi')
  })
  it('never reads the deprecated storage* aliases (dropped next release)', () => {
    const lines = dbVolumeLines('default', { storageSize: '10Gi', storageGiB: 10 })
    expect(lines[0]).toBe('postgres default: provider reported no volume size')
  })
})
