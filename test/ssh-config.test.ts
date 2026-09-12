import { describe, it, expect } from 'vitest'
import {
  renderConfigBlock, upsertConfigBlock, upsertCertAuthority, BLOCK_BEGIN, BLOCK_END,
} from '../src/commands/ssh-config.js'

const block = () => renderConfigBlock({
  hostPattern: '*.insta',
  identityFile: '/home/dev/.insta/ssh/id_ed25519',
  ensureCertCommand: 'insta compute ssh --ensure-cert %h',
})

describe('ssh_config block', () => {
  // THE test for this file. OpenSSH takes the FIRST obtained value for each
  // keyword, and ssh_config(5) says host-specific declarations belong near the
  // beginning. A block appended at the end loses every keyword to an earlier
  // `Host *` -- silently, with no error, producing a connection that ignores
  // the IdentityFile we just wrote.
  it('goes at the TOP of an existing config, not the end', () => {
    const existing = 'Host *\n  IdentityFile ~/.ssh/id_rsa\n  User root\n'
    const out = upsertConfigBlock(existing, block())
    expect(out.indexOf(BLOCK_BEGIN), 'our block is not first; an earlier Host * would win every keyword').toBe(0)
    expect(out.indexOf(BLOCK_BEGIN)).toBeLessThan(out.indexOf('Host *'))
    // And the user's own config survives intact.
    expect(out).toContain('  IdentityFile ~/.ssh/id_rsa')
    expect(out).toContain('  User root')
  })

  it('replaces its own block rather than stacking copies', () => {
    const once = upsertConfigBlock('Host *\n  User root\n', block())
    const twice = upsertConfigBlock(once, block())
    expect(twice.split(BLOCK_BEGIN).length - 1, 'running setup twice duplicated the block').toBe(1)
    expect(twice.split(BLOCK_END).length - 1).toBe(1)
    expect(twice).toContain('  User root')
    // Repeated runs must not grow the file with blank lines either.
    expect(twice).toBe(once)
  })

  it('carries IdentitiesOnly, without which a full ssh-agent breaks auth at random', () => {
    // SSH offers public keys ONE AT A TIME, so a user with several keys is
    // identified non-deterministically -- exe.dev's heisen-connect. Without
    // this line the server may never see the key carrying our certificate.
    const b = block()
    expect(b).toContain('IdentitiesOnly yes')
    expect(b).toContain('IdentityFile /home/dev/.insta/ssh/id_ed25519')
  })

  it('renews the certificate while OpenSSH parses the config', () => {
    // Without this, "after setup it is just ssh" stops being true the moment
    // the first certificate expires -- which, with a TTL measured in hours, is
    // the same day.
    expect(block()).toContain('Match host *.insta exec "insta compute ssh --ensure-cert %h"')
  })

  it('writes a bare block into an empty config without a leading blank line', () => {
    expect(upsertConfigBlock('', block())).toBe(block())
  })

  it('leaves a hand-edited half-block alone and puts a fresh one on top', () => {
    // A begin marker with no end means someone edited this by hand. Guessing
    // where our block stopped could delete their lines; first-wins means the
    // new block takes effect regardless.
    const mangled = `${BLOCK_BEGIN}\nHost old\n  User someone\n`
    const out = upsertConfigBlock(mangled, block())
    expect(out.indexOf(BLOCK_BEGIN)).toBe(0)
    expect(out).toContain('  User someone')
  })
})

describe('known_hosts trust anchor', () => {
  it('adds the @cert-authority line', () => {
    const out = upsertCertAuthority('', '*.compute.example', 'ssh-ed25519 AAAAC3CA')
    expect(out).toBe('@cert-authority *.compute.example ssh-ed25519 AAAAC3CA\n')
  })

  it('is idempotent on the KEY, so a changed host pattern updates rather than duplicates', () => {
    const first = upsertCertAuthority('', 'ssh.*.old.example', 'ssh-ed25519 AAAAC3CA')
    const second = upsertCertAuthority(first, 'ssh.*.new.example', 'ssh-ed25519 AAAAC3CA')
    const lines = second.trim().split('\n').filter((l) => l.startsWith('@cert-authority'))
    expect(lines, 'a re-run left two anchors for one CA').toHaveLength(1)
    expect(lines[0]).toContain('ssh.*.new.example')
  })

  it("keeps the user's other known_hosts entries", () => {
    const existing = 'github.com ssh-ed25519 AAAAsomething\n'
    const out = upsertCertAuthority(existing, '*.compute.example', 'ssh-ed25519 AAAAC3CA')
    expect(out).toContain('github.com ssh-ed25519 AAAAsomething')
    expect(out).toContain('@cert-authority *.compute.example')
  })

  it('does not need a trailing newline in the existing file to stay well-formed', () => {
    const out = upsertCertAuthority('github.com ssh-ed25519 AAAA', '*.x', 'ssh-ed25519 CA')
    expect(out.split('\n').filter(Boolean)).toHaveLength(2)
  })
})

import { certNeedsRenewal, hostPatternFor } from '../src/commands/compute.js'

describe('certificate renewal', () => {
  // "Cannot confirm it is valid" and "it is valid" must not collapse into the
  // same answer. Every uncertain case renews, because the cost of an
  // unnecessary renewal is one HTTPS call and the cost of the opposite is a
  // login that fails with no explanation.
  it('renews when there is no certificate at all', () => {
    expect(certNeedsRenewal('/nonexistent/path/id_ed25519-cert.pub')).toBe(true)
  })

  it('renews when the file cannot be parsed', () => {
    // ssh-keygen fails on a non-certificate, which is caught and reported as
    // "renew" rather than swallowed into "fine".
    expect(certNeedsRenewal('/etc/hosts')).toBe(true)
  })
})

describe('trust anchor scope', () => {
  // The anchor must cover the SSH names and not the whole domain: a pattern of
  // *.compute.example would also make this CA authoritative for every tenant's
  // service hostname.
  it('widens only the region label', () => {
    expect(hostPatternFor('ssh.us-west-1.compute.example')).toBe('ssh.*.compute.example')
    expect(hostPatternFor('ssh.ap-southeast-1.compute.instacloud.tech')).toBe('ssh.*.compute.instacloud.tech')
  })

  it('leaves a host too short to have a region label alone', () => {
    expect(hostPatternFor('localhost')).toBe('localhost')
    expect(hostPatternFor('a.b')).toBe('a.b')
  })
})
