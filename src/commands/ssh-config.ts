// ssh_config and known_hosts editing. Pure string functions, deliberately: the
// two traps here are both about WHERE text lands in a file the user also owns,
// and neither is observable from a function that does its own I/O.

/** The fenced block this CLI owns. Everything between the markers is ours. */
export const BLOCK_BEGIN = '# BEGIN insta compute ssh'
export const BLOCK_END = '# END insta compute ssh'

export type ConfigBlockOpts = {
  /** Host pattern the block matches, e.g. `*.insta`. */
  hostPattern: string
  /** Absolute path to the private key whose certificate we mint. */
  identityFile: string
  /** The renewal hook, run by OpenSSH while parsing the config. */
  ensureCertCommand?: string
}

export function renderConfigBlock(o: ConfigBlockOpts): string {
  const lines = [
    BLOCK_BEGIN,
    `Host ${o.hostPattern}`,
    `  IdentityFile ${o.identityFile}`,
    // IdentitiesOnly is not tidiness. SSH offers public keys ONE AT A TIME,
    // so a user with several keys is identified non-deterministically -- the
    // server sees whichever key happened to be offered first, which may not be
    // the one carrying our certificate. exe.dev calls this heisen-connect.
    // Without this line a developer with a full ssh-agent gets intermittent,
    // unexplainable auth failures.
    '  IdentitiesOnly yes',
    // Collapses scp, an IDE's several connections and a second terminal onto
    // ONE connection. Without it a single developer can reach the per-service
    // session cap in an afternoon without ever opening a second terminal.
    '  ControlMaster auto',
    '  ControlPath ~/.insta/ssh/cm-%r@%h:%p',
    '  ControlPersist 10m',
  ]
  if (o.ensureCertCommand) {
    // Renewal happens while OpenSSH PARSES the config, before it connects, so
    // a certificate that expired since the last login is replaced silently
    // rather than surfacing as a refused login. Without it, "after setup it is
    // just ssh" stops being true the moment the first certificate expires.
    lines.push(`Match host ${o.hostPattern} exec "${o.ensureCertCommand}"`)
  }
  lines.push(BLOCK_END)
  return lines.join('\n') + '\n'
}

/**
 * Insert or replace our block in an ssh_config.
 *
 * AT THE TOP, never appended, and this is the whole reason the function
 * exists. OpenSSH takes the FIRST obtained value for each keyword, and
 * ssh_config(5) says outright that host-specific declarations belong near the
 * beginning of the file. A block appended at the end loses every keyword to an
 * earlier `Host *` -- silently, with no error and no warning, producing a
 * connection that ignores the IdentityFile we just wrote.
 *
 * Idempotent: an existing block is replaced in place rather than duplicated.
 */
export function upsertConfigBlock(existing: string, block: string): string {
  const begin = existing.indexOf(BLOCK_BEGIN)
  if (begin !== -1) {
    const end = existing.indexOf(BLOCK_END, begin)
    if (end !== -1) {
      const after = end + BLOCK_END.length
      // Swallow the newline that followed the end marker, so repeated runs do
      // not accumulate blank lines.
      const tail = existing.slice(after).replace(/^\n/, '')
      return existing.slice(0, begin) + block + tail
    }
    // A begin marker with no end is a file someone edited by hand. Leave it
    // alone rather than guessing where our block stopped, and put a fresh one
    // on top -- first-wins means the new one takes effect either way.
  }
  if (existing === '') return block
  return block + '\n' + existing
}

/** The trust anchor line for known_hosts. */
export function renderCertAuthority(hostPattern: string, caKey: string): string {
  return `@cert-authority ${hostPattern} ${caKey.trim()}\n`
}

/**
 * Add the trust anchor to known_hosts if it is not already there.
 *
 * Appended rather than inserted, unlike the config block: known_hosts has no
 * first-wins rule -- every line is considered -- so position carries no
 * meaning here. Matching is on the KEY, not the whole line, so a re-run with a
 * changed host pattern updates rather than duplicates.
 */
export function upsertCertAuthority(existing: string, hostPattern: string, caKey: string): string {
  const key = caKey.trim()
  const kept = existing
    .split('\n')
    .filter((l) => !(l.startsWith('@cert-authority') && l.includes(key)))
    .join('\n')
  const base = kept === '' ? '' : kept.endsWith('\n') ? kept : kept + '\n'
  return base + renderCertAuthority(hostPattern, key)
}
