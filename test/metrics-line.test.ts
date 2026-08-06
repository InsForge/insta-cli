// `insta metrics` series rendering. The seam exists because compute's egress/ingress series arrive
// as raw bytes per second: printed unscaled, real traffic reads as an 8-digit number nobody can
// size at a glance.
import { describe, it, expect } from 'vitest'
import { metricLine } from '../src/commands/metrics.js'

const pts = (...values: number[]): [number, number][] => values.map((v, i) => [i * 60, v])

describe('metricLine', () => {
  it('scales a byte rate and keeps the /s', () => {
    expect(metricLine({ name: 'egress_bytes_rate', unit: 'bytes/s', points: pts(1024, 20_480_031) }))
      .toBe('egress_bytes_rate: 19.5 MB/s  [2 points]')
  })

  it('scales plain bytes without a /s', () => {
    expect(metricLine({ name: 'db_storage_bytes', unit: 'bytes', points: pts(2048) }))
      .toBe('db_storage_bytes: 2.0 KB  [1 points]')
  })

  it('leaves already-human units alone, keeping the unit in the label', () => {
    expect(metricLine({ name: 'cpu_cores', unit: 'vCPU', points: pts(0.82) }))
      .toBe('cpu_cores (vCPU): 0.82  [1 points]')
  })

  it('reports n/a for an empty series', () => {
    expect(metricLine({ name: 'egress_bytes_rate', unit: 'bytes/s', points: [] }))
      .toBe('egress_bytes_rate: n/a  [0 points]')
  })
})
