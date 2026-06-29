const SEV_LABEL: Record<string, string> = { high: 'HIGH', warn: 'warn', info: 'info' }
const SINK_ORDER = ['network', 'git', 'nonsecret_file', 'stdout']

export function renderReport(rows: Array<Record<string, unknown>>): string {
  if (rows.length === 0) return 'Audit log is empty — nothing recorded yet (install the hook and let an agent run).'

  const exposures = rows.filter((r) => r.kind === 'exposure')
  const touches = rows.filter((r) => r.kind === 'touch')
  const ts = rows.map((r) => String(r.ts ?? '')).filter(Boolean).sort()
  const span = ts.length ? `${ts[0]!.slice(0, 19)}  →  ${ts[ts.length - 1]!.slice(0, 19)}` : 'unknown'
  const uniqueSecrets = new Set(rows.map((r) => r.fingerprint))

  const L: string[] = []
  L.push('='.repeat(64))
  L.push(' InstaCloud Observe — what your agents did to your credentials')
  L.push('='.repeat(64))
  L.push(` window      : ${span}`)
  L.push(` events      : ${rows.length} findings across ${uniqueSecrets.size} distinct secrets`)
  L.push(` exposures   : ${exposures.length}  (secrets that left a safe place)`)
  L.push(` touches     : ${touches.length}  (secrets the agent handled)`)
  L.push('='.repeat(64))

  if (exposures.length) {
    L.push('\n⚠  EXPOSURES (look at these first)\n')
    const bySink = new Map<string, Array<Record<string, unknown>>>()
    for (const r of exposures) {
      const k = String(r.sink ?? '?')
      const group = bySink.get(k)
      if (group) {
        group.push(r)
      } else {
        bySink.set(k, [r])
      }
    }
    const sinks = [...SINK_ORDER, ...[...bySink.keys()].filter((s) => !SINK_ORDER.includes(s))]
    for (const sink of sinks) {
      const group = bySink.get(sink)
      if (!group) continue
      L.push(`  ┌─ sink: ${sink}  (${group.length} finding(s))`)
      for (const r of group) {
        L.push(`  │  [${SEV_LABEL[String(r.severity)] ?? '?'}] ${r.note ?? ''}`)
        L.push(`  │     secret : ${r.fingerprint}`)
        L.push(`  │     where  : ${r.surface}  (tool ${r.tool})`)
        L.push(`  │     when   : ${String(r.ts ?? '').slice(0, 19)}`)
        if (r.snippet) L.push(`  │     context: ${r.snippet}`)
      }
      L.push('  └─')
    }
  } else {
    L.push('\n✓ No exposures recorded.\n')
  }

  if (touches.length) {
    L.push('\n·  TOUCHES (informational)\n')
    const counter = new Map<string, number>()
    for (const r of touches) {
      const k = `${String(r.detector ?? '')}|||${String(r.note ?? '')}`
      counter.set(k, (counter.get(k) ?? 0) + 1)
    }
    for (const [k, count] of [...counter.entries()].sort((a, b) => b[1] - a[1])) {
      const sep = k.indexOf('|||')
      const detector = k.slice(0, sep)
      const note = k.slice(sep + 3)
      L.push(`   ${String(count).padStart(3)}×  ${detector}  — ${note}`)
    }
  }

  L.push('\n(local audit only — nothing in this report has left your machine)')
  return L.join('\n')
}
