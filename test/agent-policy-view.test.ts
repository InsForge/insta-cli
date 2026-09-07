import { expect, it } from 'vitest'
import { displayPolicy } from '../src/commands/agent-policy.js'

const response = {
  policy: { mode: 'branch_developer', protectedBranchIds: [], branchDeveloperRules: {} },
  agentSessionEpoch: 0, actions: ['deploy'],
  defaultRules: { unprotectedBranch: { deploy: 'allow' } },
  effectiveRules: { unprotectedBranch: { deploy: 'deny' }, protectedBranch: { deploy: 'deny' }, project: { deploy: 'deny' } },
  bootstrapRules: { 'project.create': 'allow' }, ruleNotes: ['Policy-only guidance, not authorization.'],
}
it('forwards all public rule fields as JSON without client-side evaluation', () => {
  const values: unknown[] = []
  displayPolicy(response, { json: true }, { printJson: value => { values.push(value) }, info: () => { throw Error('unexpected text') } })
  expect(values).toEqual([response])
})
it('shows resolved rules and their authorization boundary in text output', () => {
  const lines: string[] = []
  displayPolicy(response, {}, { info: value => { lines.push(value) }, printJson: () => { throw Error('unexpected JSON') } })
  expect(lines.join('\n')).toContain('unprotectedBranch:')
  expect(lines.join('\n')).toContain('deploy: deny')
  expect(lines.join('\n')).toContain('Policy-only guidance, not authorization.')
})
it('does not invent default rules when talking to an older Platform', () => {
  const lines: string[] = []
  displayPolicy({ policy: response.policy, agentSessionEpoch: 0 }, {}, { info: value => { lines.push(value) }, printJson: () => {} })
  expect(lines.join('\n')).toContain('does not expose resolved rules')
})
