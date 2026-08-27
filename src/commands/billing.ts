import { ApiClient, requireProject } from '../api.js'
import { die, info, openUrl, printJson } from '../util.js'
import { cycleLine, dimensionLines } from './metrics.js'

type OrgOpt = { org?: string }

// Resolve the target org: explicit --org, else the linked project's org.
async function resolveOrgId(opts: OrgOpt): Promise<string> {
  if (opts.org) return opts.org
  return (await requireProject()).orgId
}

export type BillingOverview = {
  window: { from: number; to: number }
  tier: string; billingStatus: string; subscriptionStatus: string | null
  totals: { usedUsd: number; includedUsd: number; overageUsd: number; creditsUsd: number; forecastUsd: number }
  byDimension: Array<{ dimension: string; quantity: number; unit: string; costUsd?: number }>
  byProject: Array<{ name: string; totalCostUsd: number }>
}

// Format the billing overview into printable lines (pure, so it's unit-testable).
export function billingLines(s: BillingOverview): string[] {
  const t = s.totals
  const lines = [
    `tier:      ${s.tier}`,
    `status:    ${s.billingStatus}`,
    cycleLine(s.window),
    `included:  $${Number(t.includedUsd).toFixed(2)}`,
    `used:      $${Number(t.usedUsd).toFixed(4)}`,
    `overage:   $${Number(t.overageUsd).toFixed(4)}`,
    `credits:   $${Number(t.creditsUsd).toFixed(2)}`,
    `forecast:  $${Number(t.forecastUsd).toFixed(4)}  (predicted full cycle)`,
  ]
  if (s.subscriptionStatus) lines.push(`subscription: ${s.subscriptionStatus}`)
  if (s.billingStatus === 'suspended') {
    // Three states, and the advice for each is a dead end for the others. Tier first: only a free
    // org can spend a prepaid wallet, and waiting for the next cycle genuinely fixes that one.
    // (Tier, not subscriptionStatus, because rows written before non-payment suspended carry
    // `unpaid` beside tier 'free' and survive with no migration.) Within a paid org, the status
    // then separates a lapse — where settling the invoice is the fix — from a suspension that
    // outlived its cause, which is what a recovery whose compute failed to restart looks like:
    // telling that customer to pay again would send them to re-settle a paid invoice.
    const lapsed = s.subscriptionStatus === 'past_due' || s.subscriptionStatus === 'unpaid'
    lines.push(
      s.tier === 'free'
        ? '⚠  org suspended — billing limit reached; resumes next cycle (or `insta billing upgrade pro`)'
        : lapsed
          ? '⚠  org suspended — subscription payment did not go through; settle it in `insta billing portal`'
          : '⚠  org suspended — the subscription is current, so this needs a hand; contact support',
    )
  }
  if (s.byDimension?.length) {
    lines.push('by dimension:')
    for (const l of dimensionLines(s.byDimension)) lines.push(`  ${l}`)
  }
  if (s.byProject?.length) {
    lines.push('by project:')
    for (const pr of s.byProject) lines.push(`  ${pr.name}: $${Number(pr.totalCostUsd ?? 0).toFixed(4)}`)
  }
  return lines
}

// insta billing — current cycle overview for the org (totals, credits, forecast, breakdowns).
export async function billing(opts: OrgOpt & { json?: boolean }): Promise<void> {
  const api = await ApiClient.load()
  const orgId = await resolveOrgId(opts)
  const s = await api.request<BillingOverview>('GET', `/orgs/${orgId}/billing/overview`)
  if (opts.json) return printJson(s)
  for (const l of billingLines(s)) info(l)
}

// insta billing upgrade <tier> — start a Stripe Checkout to subscribe the org to a paid tier.
export async function billingUpgrade(tier: string, opts: OrgOpt & { open?: boolean; json?: boolean }): Promise<void> {
  if (tier !== 'pro' && tier !== 'enterprise') die('tier must be pro|enterprise')
  const api = await ApiClient.load()
  const orgId = await resolveOrgId(opts)
  const { url } = await api.request<{ url: string }>('POST', `/orgs/${orgId}/billing/checkout`, { tier })
  if (opts.json) return printJson({ url })
  presentUrl(url, `Subscribe to ${tier} — complete checkout in your browser:`, opts.open)
}

// insta billing portal — open the Stripe Customer Portal (change plan / card / cancel).
export async function billingPortal(opts: OrgOpt & { open?: boolean; json?: boolean }): Promise<void> {
  const api = await ApiClient.load()
  const orgId = await resolveOrgId(opts)
  const { url } = await api.request<{ url: string }>('POST', `/orgs/${orgId}/billing/portal`)
  if (opts.json) return printJson({ url })
  presentUrl(url, 'Manage billing in your browser:', opts.open)
}

// Print the URL and, unless --no-open, try to open it in the browser. The message says
// "opening", not "opened": a launcher that starts and then fails reports it asynchronously,
// so openUrl's true return is an attempt, not a confirmation (see util.ts) — and the URL is
// already printed above for exactly that case.
function presentUrl(url: string, label: string, open?: boolean): void {
  info(label)
  info(`  ${url}`)
  if (open !== false && openUrl(url)) info('(opening in your default browser…)')
}
