import { afterEach, expect, it, vi } from 'vitest'
import { generateKeyPairSync, verify, createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { agentHeaders, configureAgent, detectAgent, loadAgentSession, saveAgentSession } from '../src/agent.js'
import { ApiClient, AgentApprovalRequired } from '../src/api.js'
import { writeProject } from '../src/config.js'
import { splitExecArgs } from '../src/commands/compute.js'

const dirs: string[] = []
afterEach(async () => { configureAgent(null); vi.restoreAllMocks(); await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))) })
it('only deterministic environment signals activate agent mode; explicit flag wins', () => {
  expect(detectAgent(false, { CI: 'true', TERM: 'dumb' })).toBeNull()
  expect(detectAgent(false, { CODEX_THREAD_ID: 'thread' })).toEqual({ source: 'cli-detected', client: 'codex' })
  expect(detectAgent(true, { CLAUDECODE: '1' })).toEqual({ source: 'cli-explicit', client: 'claude-code' })
  expect(detectAgent(false, { CURSOR_AGENT: '1' })?.client).toBe('cursor')
  expect(detectAgent(true, {})?.client).toBe('unknown')
})
it('keeps compute exec argv intact with the root agent option', () => {
  const argv = ['node', 'insta', '--agent', 'compute', 'exec', 'api', '--', 'sh', '-c', 'echo hi', '--agent']
  expect(splitExecArgs(argv).command).toEqual(['sh', '-c', 'echo hi', '--agent'])
})
it('never sends a project request as human when agent session is missing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'insta-agent-')); dirs.push(dir)
  vi.spyOn(process, 'cwd').mockReturnValue(dir)
  configureAgent({ source: 'cli-detected', client: 'codex' })
  const fetcher = vi.fn()
  const api = new ApiClient({ apiUrl: 'https://test.invalid', accessToken: 'user' }, fetcher)
  await expect(api.request('POST', '/projects/p/services', { type: 'compute' })).rejects.toThrow(/insta setup agent/)
  expect(fetcher).not.toHaveBeenCalled()
})
it('stores private material with ignore/permissions and signs exact request fields from nested directories', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'insta-agent-')); dirs.push(dir)
  await writeProject({ projectId: 'p', orgId: 'o', branch: 'main' }, dir)
  const pair = generateKeyPairSync('ed25519')
  const session = { token: 'signed-token', agentSessionId: 'ags_test', projectId: 'p', expiresAt: new Date(Date.now() + 60000).toISOString(),
    privateKey: pair.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(), client: 'codex' as const, apiUrl: 'https://test.invalid' }
  await saveAgentSession(session, dir)
  expect(await readFile(join(dir, '.gitignore'), 'utf8')).toContain('.insta/agent-session.json')
  if (process.platform !== 'win32') expect((await stat(join(dir, '.insta/agent-session.json'))).mode & 0o777).toBe(0o600)
  expect((await loadAgentSession(session.apiUrl, 'p', join(dir, 'nested'))).agentSessionId).toBe('ags_test')
  await expect(loadAgentSession('https://other.invalid', 'p', dir)).rejects.toThrow(/another project\/environment/)
  await expect(loadAgentSession(session.apiUrl, 'other', dir)).rejects.toThrow()
  vi.spyOn(process, 'cwd').mockReturnValue(dir)
  configureAgent({ source: 'cli-explicit', client: 'codex' })
  const raw = '{"value":"a secret"}'
  const path = '/projects/p/secrets/X?branch=dev&x=1&x=2'
  const headers = await agentHeaders({ apiUrl: session.apiUrl, request: vi.fn() }, 'PUT', path, raw)
  const proof = ['PUT', path, createHash('sha256').update(raw).digest('hex'), 'ags_test', headers['Insta-Agent-Timestamp'], headers['Insta-Agent-Nonce'], 'cli-explicit', 'codex'].join('\n')
  expect(verify(null, Buffer.from(proof), pair.publicKey, Buffer.from(headers['Insta-Agent-Signature']!, 'base64url'))).toBe(true)
  expect(verify(null, Buffer.from(proof.replace('dev', 'main')), pair.publicKey, Buffer.from(headers['Insta-Agent-Signature']!, 'base64url'))).toBe(false)
  const fetcher = vi.fn(async () => new Response(JSON.stringify({ status: 'approval_required', approvalId: 'a1', message: 'approve a1' }), { status: 202 }))
  const api = new ApiClient({ apiUrl: session.apiUrl, accessToken: 'user' }, fetcher)
  await expect(api.request('PUT', '/projects/p/secrets/X', { value: 'secret' })).rejects.toBeInstanceOf(AgentApprovalRequired)
  expect(fetcher).toHaveBeenCalledOnce()
})
it('signs a project-owned request that lacks /projects/ in its path with the named project session', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'insta-agent-')); dirs.push(dir)
  const pair = generateKeyPairSync('ed25519')
  const session = { token: 'signed-token', agentSessionId: 'ags_test', projectId: 'p', expiresAt: new Date(Date.now() + 60000).toISOString(),
    privateKey: pair.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(), client: 'codex' as const, apiUrl: 'https://test.invalid' }
  await saveAgentSession(session, dir)
  vi.spyOn(process, 'cwd').mockReturnValue(dir)
  configureAgent({ source: 'cli-detected', client: 'codex' })
  // Without a scope the path decides, and /template-deployments/:id reads as account-level: a
  // bootstrap session is minted (the platform then rejects it as "for a different project").
  const mint = vi.fn(async () => ({ token: 'boot', agentSessionId: 'ags_boot', projectId: null, expiresAt: new Date(Date.now() + 60000).toISOString() }))
  const unscoped = await agentHeaders({ apiUrl: session.apiUrl, request: mint }, 'GET', '/template-deployments/d1', '')
  expect(mint).toHaveBeenCalledWith('POST', '/agent/sessions', expect.objectContaining({ projectId: undefined }))
  expect(unscoped['Insta-Agent-Session']).toBe('ags_boot')
  // Naming the project loads its saved session instead, and never mints.
  mint.mockClear()
  const scoped = await agentHeaders({ apiUrl: session.apiUrl, request: mint }, 'GET', '/template-deployments/d1', '', { projectId: 'p' })
  expect(mint).not.toHaveBeenCalled()
  expect(scoped['Insta-Agent-Session']).toBe('ags_test')
  const proof = ['GET', '/template-deployments/d1', createHash('sha256').update('').digest('hex'), 'ags_test', scoped['Insta-Agent-Timestamp'], scoped['Insta-Agent-Nonce'], 'cli-detected', 'codex'].join('\n')
  expect(verify(null, Buffer.from(proof), pair.publicKey, Buffer.from(scoped['Insta-Agent-Signature']!, 'base64url'))).toBe(true)
  // ...and ApiClient threads the scope through to the wire.
  const fetcher = vi.fn(async () => new Response(JSON.stringify({ status: 'succeeded' }), { status: 200 }))
  const api = new ApiClient({ apiUrl: session.apiUrl, accessToken: 'user' }, fetcher)
  await api.request('GET', '/template-deployments/d1', undefined, { projectId: 'p' })
  expect(fetcher).toHaveBeenCalledOnce()
  expect((fetcher.mock.calls[0] as any[])[1].headers['Insta-Agent-Session']).toBe('ags_test')
  // A session for another project is still refused: the scope is a selector, not a bypass.
  await expect(api.request('GET', '/template-deployments/d1', undefined, { projectId: 'other' })).rejects.toThrow(/insta setup agent/)
})
