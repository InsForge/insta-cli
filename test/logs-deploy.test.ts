// `insta logs --deploy` targets /deploy-events and renders each machine event as one line.
import { describe, it, expect } from 'vitest'
import { deployEventsPath, deployEventLine } from '../src/commands/metrics.js'

describe('deployEventsPath', () => {
  it('targets /deploy-events with defined params in order', () => {
    expect(deployEventsPath('p1', { group: 'api', branch: 'main', limit: '50' }))
      .toBe('/projects/p1/deploy-events?group=api&branch=main&limit=50')
  })
  it('omits undefined/empty params', () => {
    expect(deployEventsPath('p1', {})).toBe('/projects/p1/deploy-events')
  })
})

describe('deployEventLine', () => {
  it('renders [origin] type: status with the instance suffix', () => {
    expect(deployEventLine({ ts: 'T', origin: 'flyd', type: 'start', status: 'started', instance: 'm-1' }))
      .toBe('T  [flyd] start: started  (m-1)')
  })
  it('omits the instance suffix when absent', () => {
    expect(deployEventLine({ ts: 'T', origin: 'user', type: 'launch', status: 'created' }))
      .toBe('T  [user] launch: created')
  })
})
