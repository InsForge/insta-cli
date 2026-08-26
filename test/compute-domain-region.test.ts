// `insta compute set-domain / check-domain` — region-aware, and never guessing. A compute service
// lives in ONE region (fixed at creation) and a custom hostname routes in that region's router, so:
// the target service is resolved from the project (sole compute service → bind; several → refuse
// with the list, regions shown, --group required; workers unbindable), the guidance after set-domain
// is the platform's records VERBATIM (never a template), and check-domain renders every stage plus
// where the hostname resolves. Pure-function tests, same pattern as compute-exec.test.ts.
import { describe, it, expect } from 'vitest'
import {
  resolveDomainTarget, computeChoiceLine, domainGuidanceLines, domainStatusLines, domainResolveLine,
  domainConflictMessage, withRow, type ComputeRow, type DomainView,
} from '../src/commands/compute.js'
import { ApiError } from '../src/api.js'

const api: ComputeRow = { id: 's1', type: 'compute', name: 'api', status: 'running', region: 'us-east', domain: 'insta-main-api-1a2b.compute.instacloud.com', port: 8080 }
const web: ComputeRow = { id: 's2', type: 'compute', name: 'web', status: 'running', region: 'us-west', domain: 'insta-main-web-3c4d.compute.instacloud.com', port: 3000 }
const worker: ComputeRow = { id: 's3', type: 'compute', name: 'worker', status: 'running', region: 'eu-central', domain: null, port: 0 }
const pg: ComputeRow = { id: 's4', type: 'postgres', name: 'db', status: 'running', region: 'us-east' }

describe('resolveDomainTarget (selection only where genuinely ambiguous)', () => {
  it('a project with exactly one compute service binds to it without --group', () => {
    expect(resolveDomainTarget([pg, api], 'app.customer.com')).toBe(api)
  })

  it('several compute services: refuses, lists each with its REGION and default URL, requires --group', () => {
    let msg = ''
    try { resolveDomainTarget([pg, api, web, worker], 'app.customer.com') } catch (e) { msg = (e as Error).message }
    const lines = msg.split('\n')
    expect(lines[0]).toBe('this project has 3 compute services; pass --group to choose which one serves app.customer.com:')
    // Columns align to the widest name/region in the list (worker / eu-central here).
    expect(lines[1]).toBe('  api    us-east    https://insta-main-api-1a2b.compute.instacloud.com  (running)')
    expect(lines[2]).toBe('  web    us-west    https://insta-main-web-3c4d.compute.instacloud.com  (running)')
    // The worker is SHOWN (so the user knows it exists) but marked unbindable.
    expect(lines[3]).toBe('  worker eu-central (no HTTP endpoint — worker, cannot serve a domain)')
    expect(lines).toHaveLength(4) // the postgres service is not a candidate
  })

  it('--group picks by name; a worker is refused even when named', () => {
    expect(resolveDomainTarget([api, web, worker], 'app.customer.com', 'web')).toBe(web)
    expect(() => resolveDomainTarget([api, web, worker], 'app.customer.com', 'worker'))
      .toThrow('worker is a worker (port 0) — it has no HTTP endpoint, so app.customer.com cannot serve from it')
    expect(() => resolveDomainTarget([api, web], 'app.customer.com', 'nope')).toThrow('compute service not found: nope (have: api, web)')
  })

  it('the sole compute service being a worker is refused, not bound', () => {
    expect(() => resolveDomainTarget([worker], 'app.customer.com')).toThrow(/worker is a worker \(port 0\)/)
  })

  it('no compute service at all', () => {
    expect(() => resolveDomainTarget([pg], 'app.customer.com')).toThrow(/no compute service in this project/)
  })

  it('computeChoiceLine: a service with no default URL yet says so instead of printing https://null', () => {
    expect(computeChoiceLine({ ...api, domain: null })).toBe('  api      us-east      (no default URL yet)  (running)')
  })
})

const bound: DomainView = {
  hostname: 'app.customer.com', flyApp: 'api-main-1a2b', configured: false, status: 'pending_dns',
  service: 'api', region: 'us-east',
  dns: [
    { type: 'CNAME', name: 'app.customer.com', value: 'cname.instacloud-dns.com', note: 'routes to the service', status: 'missing' },
    { type: 'TXT', name: '_insta-verify.app.customer.com', value: 'insta-verify=tok123', note: 'proves domain ownership', status: 'missing' },
  ],
  ssl: 'initializing',
}

describe('domainGuidanceLines (after set-domain: what to do next, from the platform records)', () => {
  it('renders the adapter records verbatim, region named, then the check-domain step', () => {
    expect(domainGuidanceLines(bound)).toEqual([
      'app.customer.com -> api (us-east)',
      'add these DNS records at your DNS provider:',
      '  CNAME  app.customer.com               -> cname.instacloud-dns.com',
      '  TXT    _insta-verify.app.customer.com -> insta-verify=tok123',
      'then: insta compute check-domain app.customer.com',
    ])
  })

  it('NO records from the platform → says so explicitly; never prints a template value', () => {
    const lines = domainGuidanceLines({ ...bound, dns: [] })
    expect(lines[0]).toBe('app.customer.com -> api (us-east)')
    expect(lines.join('\n')).toMatch(/returned NO DNS records/)
    expect(lines.join('\n')).toMatch(/nothing to publish yet/)
    expect(lines.join('\n')).not.toMatch(/cname\.instacloud-dns\.com|_insta-verify|CNAME {2}|TXT {4}/)
  })

  it('an older platform without service/region: withRow fills them from the resolved row', () => {
    const { service: _s, region: _r, ...legacy } = bound
    expect(domainGuidanceLines(withRow(legacy as DomainView, api))[0]).toBe('app.customer.com -> api (us-east)')
    // ...but the platform's own answer wins when present.
    expect(withRow(bound, web).region).toBe('us-east')
  })
})

describe('domainStatusLines (check-domain: every stage + where it routes)', () => {
  const active: DomainView = {
    ...bound, configured: true, status: 'active', ssl: 'active',
    dns: bound.dns.map((d) => ({ ...d, status: 'ok' })),
    origin: 'prod-use1-origin.instacloud-dns.com', edgeOrigin: 'prod-use1-origin.instacloud-dns.com', originOk: true,
  }

  it('active: ownership verified, cname ok, certificate active, resolves to the region origin, serving', () => {
    expect(domainStatusLines(active)).toEqual([
      'app.customer.com -> api (us-east)',
      '  ownership   verified    (TXT found)',
      '  cname       ok          (points at cname.instacloud-dns.com)',
      '  certificate active      (edge TLS issued)',
      '  resolves to prod-use1-origin.instacloud-dns.com   (us-east router)   ok',
      '  serving     https://app.customer.com',
    ])
  })

  it('pending: each missing stage says what the user must still do', () => {
    const lines = domainStatusLines(bound)
    expect(lines[1]).toBe('  ownership   pending     add TXT _insta-verify.app.customer.com -> insta-verify=tok123')
    expect(lines[2]).toBe('  cname       pending     add CNAME app.customer.com -> cname.instacloud-dns.com')
    expect(lines[3]).toBe('  certificate pending     (initializing — issues once ownership is verified)')
    expect(lines[4]).toBe("  resolves to (edge routing target not reported by the us-east region's daemon)")
    expect(lines[5]).toBe('  serving     not yet     (add the ownership TXT, add the CNAME, certificate)')
  })

  it('mismatch: names the value the record must have', () => {
    const v = { ...bound, dns: bound.dns.map((d) => ({ ...d, status: 'mismatch' })) }
    const lines = domainStatusLines(v)
    expect(lines[1]).toBe('  ownership   mismatch    TXT _insta-verify.app.customer.com has a different value — set it to insta-verify=tok123')
    expect(lines[2]).toBe('  cname       mismatch    CNAME app.customer.com must point at cname.instacloud-dns.com')
  })

  it('failure shape 1 — region has NO edge origin configured (origin ""): NOT READY, operator action named', () => {
    const v = { ...active, origin: '', edgeOrigin: '', originOk: false }
    const lines = domainStatusLines(v)
    expect(lines[4]).toBe('  resolves to NOT READY — us-east has no edge origin configured; app.customer.com would fall to the zone default. Ask an operator to set cf-custom-origin for us-east')
    expect(lines[5]).toBe('  serving     not yet     (fix the routing target above)')
    expect(lines.join('\n')).not.toContain('https://app.customer.com') // active-but-misrouted is not "serving"
  })

  it('failure shape 2 — Cloudflare routes the hostname to ANOTHER region\'s origin: attached elsewhere, remove it there', () => {
    const v = { ...active, edgeOrigin: 'prod-usw2-origin.instacloud-dns.com', originOk: false }
    const lines = domainStatusLines(v)
    expect(lines[4]).toBe('  resolves to prod-usw2-origin.instacloud-dns.com — Cloudflare routes app.customer.com to prod-usw2-origin.instacloud-dns.com, but this service is in us-east (prod-use1-origin.instacloud-dns.com); it is attached elsewhere — remove it there first')
    expect(lines[5]).toBe('  serving     not yet     (fix the routing target above)')
  })

  it('failure shape 3 — the daemon reports no routing target: said explicitly, never invented', () => {
    const { origin: _o, edgeOrigin: _e, originOk: _k, ...noReport } = active
    const lines = domainStatusLines(noReport as DomainView)
    expect(lines[4]).toBe("  resolves to (edge routing target not reported by the us-east region's daemon)")
    expect(lines[5]).toBe('  serving     https://app.customer.com') // active + no report → the plane's word stands
    expect(lines.join('\n')).not.toMatch(/instacloud-dns\.com\s+\(us-east router\)/)
  })

  it('Cloudflare does not hold the hostname yet (edge empty, originOk false): pending, not misrouted', () => {
    expect(domainResolveLine({ ...active, edgeOrigin: '', originOk: false })).toEqual({
      line: '  resolves to prod-use1-origin.instacloud-dns.com   (us-east router)   pending — Cloudflare does not hold this hostname yet',
      ready: false,
    })
  })

  it('error state: the plane\'s reason is shown and the hostname is not reported as serving', () => {
    const lines = domainStatusLines({ ...active, status: 'error', errorReason: 'ownership token changed' })
    expect(lines).toContain('  error       error       ownership token changed')
    expect(lines.at(-1)).toBe('  serving     not yet     (error)')
  })

  it('pre-Cloudflare plane (ssl external): certificate stage says no edge cert is managed', () => {
    expect(domainStatusLines({ ...active, ssl: 'external' })[3]).toBe('  certificate external    (this plane manages no edge certificate for custom domains)')
  })

  it('Fly-backed row (no per-record status, no ssl): stages derive from `configured` and the provider status', () => {
    const fly: DomainView = {
      hostname: 'app.customer.com', flyApp: 'insta-main-api-ab12', configured: false, status: 'Awaiting configuration', service: 'api', region: 'us-east',
      dns: [
        { type: 'CNAME', name: 'app.customer.com', value: 'insta-main-api-ab12.fly.dev', note: 'routes to the Fly app' },
        { type: 'CNAME', name: '_acme-challenge.app.customer.com', value: 'app.customer.com.abc.flydns.net', note: "Let's Encrypt validation" },
      ],
    }
    const lines = domainStatusLines(fly)
    expect(lines[1]).toBe('  cname       unchecked   CNAME app.customer.com -> insta-main-api-ab12.fly.dev')
    expect(lines[2]).toBe("  cname       pending     _acme-challenge.app.customer.com -> app.customer.com.abc.flydns.net  (Let's Encrypt validation)")
    expect(lines[3]).toBe('  certificate pending     (provider status: Awaiting configuration)')
    expect(domainStatusLines({ ...fly, configured: true, status: 'Ready' })).toContain('  serving     https://app.customer.com')
  })

  it('not added: one line pointing at set-domain, region still named', () => {
    expect(domainStatusLines({ ...bound, status: 'not added', dns: [] })).toEqual([
      'app.customer.com is not attached to api (us-east) — attach it with: insta compute set-domain app.customer.com',
    ])
  })
})

describe('domainConflictMessage (bound elsewhere — domains are released, never moved)', () => {
  const conflict = (msg: string) => new ApiError(409, msg, { error: msg })

  it('owner named and in this project: the exact remove-domain command', () => {
    expect(domainConflictMessage('app.customer.com', conflict('app.customer.com is already attached to web in us-west; remove it there first'), [api, web]))
      .toBe('app.customer.com is already attached to web (us-west) — domains are not moved; release it first: insta compute remove-domain app.customer.com --group web, then re-run set-domain')
  })

  it('owner named but not a service here: held by a deleted service → operator must release', () => {
    expect(domainConflictMessage('app.customer.com', conflict('app.customer.com is already attached to old-api in us-east; remove it there first'), [api]))
      .toBe('app.customer.com is already attached to old-api in us-east, which is not a service in this project — it is held by a deleted service (or one in another project); ask an operator to release the hostname before re-binding it')
  })

  it("owner not named (today's plane): generic release instruction, still no 'move'", () => {
    const msg = domainConflictMessage('app.customer.com', conflict('app.customer.com is already attached to another compute service; remove it there first'), [api, web])
    expect(msg).toBe('app.customer.com is already attached to another compute service — domains are not moved; release it there first (insta compute remove-domain app.customer.com --group <that service>) or, if that service was deleted, ask an operator to release the hostname')
    expect(msg).not.toMatch(/move it|transfer/)
  })
})
