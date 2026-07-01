import { ApiClient, requireProject } from '../api.js'
import { die, info, openUrl, printJson } from '../util.js'

type OrgOpt = { org?: string }

// Resolve the target org: explicit --org, else the linked project's org.
async function resolveOrgId(opts: OrgOpt): Promise<string> {
  if (opts.org) return opts.org
  return (await requireProject()).orgId
}

// insta billing — current cycle summary for the org.
export async function billing(opts: OrgOpt & { json?: boolean }): Promise<void> {
  const api = await ApiClient.load()
  const orgId = await resolveOrgId(opts)
  const s = await api.request('GET', `/orgs/${orgId}/billing`)
  if (opts.json) return printJson(s)
  info(`tier:     ${s.tier}`)
  info(`status:   ${s.status}`)
  info(`cycle:    ${String(s.cycleStart).slice(0, 10)} → ${String(s.cycleEnd).slice(0, 10)}`)
  info(`included: $${Number(s.includedUsd).toFixed(2)}`)
  info(`used:     $${Number(s.usedUsd).toFixed(4)}`)
  info(`overage:  $${Number(s.overageUsd).toFixed(4)}`)
  if (s.status === 'suspended') info('⚠  org suspended — billing limit reached; resumes next cycle (or `insta billing upgrade pro`)')
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

// Print the URL and, unless --no-open, try to open it in the browser.
function presentUrl(url: string, label: string, open?: boolean): void {
  info(label)
  info(`  ${url}`)
  if (open !== false && openUrl(url)) info('(opened in your default browser)')
}
