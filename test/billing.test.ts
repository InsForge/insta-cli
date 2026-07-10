import { describe, it, expect } from 'vitest'
import { billingLines } from '../src/commands/billing.js'

const base = {
  window: { from: 1_686_787_200, to: 1_689_379_200 }, // 2023-06-15 → 2023-07-15 (UTC)
  tier: 'pro', billingStatus: 'active', subscriptionStatus: 'active' as string | null,
  totals: { usedUsd: 45.32, includedUsd: 25, overageUsd: 20.32, creditsUsd: 0, forecastUsd: 97.11 },
  byDimension: [
    { dimension: 'ram', quantity: 660, unit: 'GB·min', costUsd: 6.6 },
    { dimension: 'cpu', quantity: 120, unit: 'vCPU·min', costUsd: 3.2 },
  ],
  byProject: [
    { name: 'Project 1', totalCostUsd: 24 },
    { name: 'Project 2', totalCostUsd: 14.5 },
  ],
}

describe('billingLines', () => {
  it('renders totals incl. credits + forecast, and both breakdowns', () => {
    const out = billingLines(base).join('\n')
    expect(out).toContain('tier:      pro')
    expect(out).toContain('status:    active')
    expect(out).toContain('billing cycle 2023-06-15 → 2023-07-14') // to − 1 day (inclusive last day)
    expect(out).toContain('included:  $25.00')
    expect(out).toContain('used:      $45.3200')
    expect(out).toContain('overage:   $20.3200')
    expect(out).toContain('credits:   $0.00')
    expect(out).toContain('forecast:  $97.1100  (predicted full cycle)')
    expect(out).toContain('subscription: active')
    expect(out).toContain('by dimension:')
    expect(out).toContain('memory: 660 GB·min  ($6.6000)') // ram → memory label
    expect(out).toContain('cpu: 120 vCPU·min  ($3.2000)')
    expect(out).toContain('by project:')
    expect(out).toContain('  Project 1: $24.0000')
    expect(out).toContain('  Project 2: $14.5000')
  })

  it('free tier: credits = wallet balance; no subscription line', () => {
    const out = billingLines({ ...base, tier: 'free', subscriptionStatus: null,
      totals: { usedUsd: 2, includedUsd: 5, overageUsd: 0, creditsUsd: 3, forecastUsd: 4 } }).join('\n')
    expect(out).toContain('included:  $5.00')
    expect(out).toContain('credits:   $3.00')
    expect(out).not.toContain('subscription:')
  })

  it('suspended: prints the warning', () => {
    expect(billingLines({ ...base, billingStatus: 'suspended' }).join('\n')).toContain('org suspended')
  })

  it('empty breakdowns: no breakdown headers', () => {
    const out = billingLines({ ...base, byDimension: [], byProject: [] }).join('\n')
    expect(out).not.toContain('by dimension:')
    expect(out).not.toContain('by project:')
  })
})
