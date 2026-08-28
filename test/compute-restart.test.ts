// `insta compute restart` line rendering. The seam exists because a restart's answer is not the
// other lifecycle verbs': desired_state is a precondition it enforces, not news it reports.
import { describe, it, expect } from 'vitest'
import { lifecycleLine } from '../src/commands/compute.js'

describe('lifecycleLine', () => {
  it('restart names the image that came back and the live state', () => {
    expect(lifecycleLine('restart', 'svc-1', { service: { name: 'api', desired_state: 'running', image: 'nginx:1.27' }, state: 'running' }))
      .toBe('restarted compute api on nginx:1.27 — env re-resolved from the current secrets (live: running)')
  })

  // desired_state is always 'running' on a successful restart (the platform refuses every other
  // state), so echoing it would be noise — this pins that it is NOT in the restart line.
  it('restart does not echo desired_state', () => {
    expect(lifecycleLine('restart', 'svc-1', { service: { name: 'api', desired_state: 'running' }, state: 'running' }))
      .not.toMatch(/desired/)
  })

  it('restart omits the image when the platform did not report one', () => {
    expect(lifecycleLine('restart', 'svc-1', { service: { name: 'api' }, state: 'running' }))
      .toBe('restarted compute api — env re-resolved from the current secrets (live: running)')
  })

  it('start/stop/suspend keep the desired-vs-live line', () => {
    expect(lifecycleLine('stop', 'svc-1', { service: { name: 'api', desired_state: 'stopped' }, state: 'stopped' }))
      .toBe('compute api: stop → desired=stopped (live: stopped)')
    expect(lifecycleLine('start', 'svc-1', { service: { name: 'api', desired_state: 'running' }, state: 'running' }))
      .toBe('compute api: start → desired=running (live: running)')
  })

  // An older platform can answer without the service object; the id the CLI resolved is the
  // fallback, so the line never loses which service it is talking about.
  it('falls back to the resolved service id when the platform omits the service', () => {
    expect(lifecycleLine('restart', 'svc-1', { state: 'running' })).toMatch(/^restarted compute svc-1 —/)
    expect(lifecycleLine('suspend', 'svc-1', { state: 'stopped' })).toMatch(/^compute svc-1: suspend/)
  })
})
