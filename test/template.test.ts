import { describe, it, expect } from 'vitest'
import {
  imageTagIssue, validateManifest, collectManifestVariables, parseManifestYaml,
  type TemplateManifest, type TemplateVar,
} from '../src/template-manifest.js'
import {
  templateListLines, templateInfoLines, normalizeInfoServices, normalizeInfoVariables,
  parseSetFlags, generateValue, resolveVariables, missingVariablesFrom, looksLikePath,
  stepIndexFor, deploymentUrls, watchDeployment, DEPLOY_STEPS,
} from '../src/commands/template.js'

const MANIFEST: TemplateManifest = {
  code: 'plausible',
  version: '2.1.1',
  maintainer: 'insforge',
  upstream: { pinned: 'ghcr.io/plausible/community-edition:v2.1.1' },
  services: {
    app: {
      image: 'ghcr.io/plausible/community-edition:v2.1.1',
      port: 8000,
      env: {
        fixed: { DISABLE_REGISTRATION: 'true' },
        generated: { SECRET_KEY_BASE: 'secret:64' },
        required: { BASE_URL: { description: 'public URL the app is served at' } },
        optional: { SMTP_HOST: 'SMTP relay host' },
      },
    },
    db: { type: 'postgres', volume: { size: 10 } },
  },
}

describe('imageTagIssue', () => {
  it('accepts version tags and digest pins', () => {
    expect(imageTagIssue('nginx:1.27')).toBeNull()
    expect(imageTagIssue('ghcr.io/a/b:v2')).toBeNull()
    expect(imageTagIssue('nginx@sha256:abc')).toBeNull()
  })
  it('rejects tagless and :latest images', () => {
    expect(imageTagIssue('nginx')).toMatch(/no tag/)
    expect(imageTagIssue('nginx:latest')).toMatch(/not a pin/)
  })
  // The registry host carries a port colon — only the last segment names the tag.
  it('is not fooled by a registry port', () => {
    expect(imageTagIssue('registry.local:5000/app')).toMatch(/no tag/)
    expect(imageTagIssue('registry.local:5000/app:1.0')).toBeNull()
  })
})

describe('validateManifest', () => {
  it('accepts a well-formed manifest', () => {
    expect(validateManifest(MANIFEST)).toEqual([])
  })
  it('requires code, version and at least one service', () => {
    const problems = validateManifest({} as TemplateManifest)
    expect(problems.join('\n')).toMatch(/code is required/)
    expect(problems.join('\n')).toMatch(/version is required/)
    expect(problems.join('\n')).toMatch(/at least one service/)
  })
  it('rejects unpinned images', () => {
    const m = { ...MANIFEST, services: { app: { image: 'nginx:latest' } } }
    expect(validateManifest(m).join('\n')).toMatch(/not a pin/)
  })
  it('requires an image or build for compute services, but not managed types', () => {
    const m = { ...MANIFEST, services: { app: {}, db: { type: 'postgres' } } }
    expect(validateManifest(m)).toEqual(['services.app: an image or a build is required for compute services'])
  })
  it('requires a description on required vars unless a generator answers for the user', () => {
    const m = {
      ...MANIFEST,
      services: { app: { image: 'a:1', env: { required: { PLAIN: {}, GEN: { generate: 'secret:16' } } } } },
    }
    expect(validateManifest(m)).toEqual(['services.app.env.required.PLAIN: a description is required (unless generate is set)'])
  })
  it('rejects out-of-range ports and fractional volumes', () => {
    const m = { ...MANIFEST, services: { app: { image: 'a:1', port: 70000, volume: { size: 1.5 } } } }
    const problems = validateManifest(m).join('\n')
    expect(problems).toMatch(/port must be an integer/)
    expect(problems).toMatch(/volume.size must be a whole Gi/)
  })
})

describe('parseManifestYaml', () => {
  it('parses and validates YAML text', () => {
    const m = parseManifestYaml(['code: demo', 'version: "1.0"', 'services:', '  app:', '    image: nginx:1.27'].join('\n'))
    expect(m.code).toBe('demo')
  })
  it('lists every problem, prefixed with the source file', () => {
    expect(() => parseManifestYaml('code: demo\n', 'x/insta.template.yaml')).toThrow(/x\/insta\.template\.yaml is not deployable:[\s\S]*version is required[\s\S]*at least one service/)
  })
  it('reports YAML syntax errors with the source file', () => {
    expect(() => parseManifestYaml('a: [', 'bad.yaml')).toThrow(/^bad\.yaml:/)
  })
})

describe('collectManifestVariables', () => {
  it('flattens required + optional vars across services (fixed/generated are not questions)', () => {
    const vars = collectManifestVariables(MANIFEST)
    expect(vars).toEqual([
      { name: 'BASE_URL', required: true, description: 'public URL the app is served at', default: undefined, generate: undefined },
      { name: 'SMTP_HOST', required: false, description: 'SMTP relay host', default: undefined, generate: undefined },
    ])
  })
  it('merges duplicates: required anywhere wins', () => {
    const m: TemplateManifest = {
      code: 'x', version: '1', services: {
        a: { image: 'a:1', env: { optional: { K: 'desc' } } },
        b: { image: 'b:1', env: { required: { K: { description: 'desc' } } } },
      },
    }
    const vars = collectManifestVariables(m)
    expect(vars).toHaveLength(1)
    expect(vars[0]).toMatchObject({ name: 'K', required: true })
  })
})

describe('templateListLines', () => {
  it('renders an aligned table with numeric columns right-aligned', () => {
    const lines = templateListLines([
      { code: 'plausible', version: '2.1.1', name: 'Plausible', tagline: 'web analytics', category: 'analytics', requiredVarCount: 1, deployCount: 120 },
      { code: 'n8n', version: '1.64.0', name: 'n8n', category: 'automation', requiredVarCount: 0, deployCount: 7 },
    ])
    expect(lines[0]).toMatch(/^CODE\s+VERSION\s+CATEGORY\s+VARS\s+DEPLOYS\s+NAME$/)
    expect(lines[1]).toBe('plausible  2.1.1    analytics      1      120  Plausible — web analytics')
    expect(lines[2]).toBe('n8n        1.64.0   automation     0        7  n8n')
  })
  it('says so when the registry is empty', () => {
    expect(templateListLines([])).toEqual(['(no templates published yet)'])
  })
})

describe('templateInfoLines', () => {
  const tpl = {
    code: 'plausible', name: 'Plausible', tagline: 'self-hosted web analytics', version: '2.1.1',
    maintainer: 'insforge', license: 'AGPL-3.0', upstream: { pinned: 'ghcr.io/plausible/community-edition:v2.1.1' },
    services: [
      { name: 'app', type: 'compute', port: 8000 },
      { name: 'db', type: 'postgres', volumeGib: 10 },
    ],
    variables: [
      { name: 'BASE_URL', required: true, description: 'public URL' },
      { name: 'ADMIN_PWD', required: true, type: 'password' },
      { name: 'SMTP_HOST', required: false, description: 'SMTP relay', default: 'localhost' },
    ],
  }
  it('renders header fields, a services summary, and grouped variables', () => {
    const lines = templateInfoLines(tpl)
    expect(lines[0]).toBe('plausible — Plausible')
    expect(lines).toContain('  version     2.1.1')
    expect(lines).toContain('  upstream    ghcr.io/plausible/community-edition:v2.1.1')
    expect(lines).toContain('services (2): app (port 8000), db (postgres, 10Gi volume)')
    const text = lines.join('\n')
    expect(text).toMatch(/required:\n\s+BASE_URL\s+public URL\n\s+ADMIN_PWD\s+\(generated: secret:32\)/)
    expect(text).toMatch(/optional:\n\s+SMTP_HOST\s+SMTP relay \(default: localhost\)/)
  })
  it('bolds required variable names with the injected emphasis', () => {
    const lines = templateInfoLines(tpl, (s) => `<b>${s}</b>`)
    expect(lines.join('\n')).toContain('<b>BASE_URL')
    expect(lines.join('\n')).not.toContain('<b>SMTP_HOST')
  })
  it('renders manifest-shaped (map) services too', () => {
    expect(normalizeInfoServices({ app: { port: 80 }, db: { type: 'postgres', volume: { size: 5 } } })).toEqual([
      { name: 'app', type: undefined, port: 80, volumeGib: undefined },
      { name: 'db', type: 'postgres', port: undefined, volumeGib: 5 },
    ])
  })
  it('accepts pre-grouped variables', () => {
    const vars = normalizeInfoVariables({ required: [{ name: 'A', description: 'a' }], optional: [{ name: 'B' }] })
    expect(vars).toMatchObject([{ name: 'A', required: true }, { name: 'B', required: false }])
  })
})

describe('parseSetFlags', () => {
  it('parses NAME=value pairs, last occurrence winning; values may contain =', () => {
    expect(parseSetFlags(['A=1', 'B=x=y', 'A=2'])).toEqual({ A: '2', B: 'x=y' })
  })
  it('rejects pairs without =, and names that are not env-var shaped', () => {
    expect(() => parseSetFlags(['JUNK'])).toThrow(/--set expects NAME=value/)
    expect(() => parseSetFlags(['1A=2'])).toThrow(/--set expects NAME=value/)
  })
})

describe('generateValue', () => {
  it('generates exactly N chars for secret:N (default 32)', () => {
    expect(generateValue('secret:17')).toHaveLength(17)
    expect(generateValue('secret')).toHaveLength(32)
  })
  it('rejects unknown generators and silly lengths', () => {
    expect(() => generateValue('uuid')).toThrow(/unknown generator/)
    expect(() => generateValue('secret:0')).toThrow(/out of range/)
    expect(() => generateValue('secret:9999')).toThrow(/out of range/)
  })
})

describe('resolveVariables', () => {
  const V = (v: Partial<TemplateVar> & { name: string }): TemplateVar => ({ required: true, ...v })
  it('--set wins over everything, and unknown --set names pass through', async () => {
    const values = await resolveVariables([V({ name: 'A', generate: 'secret:8' })], { A: 'mine', EXTRA: 'x' })
    expect(values).toEqual({ A: 'mine', EXTRA: 'x' })
  })
  it('auto-generates generator-backed vars and reports them', async () => {
    const generated: string[] = []
    const values = await resolveVariables([V({ name: 'KEY', generate: 'secret:8' })], {}, { onGenerated: (n) => generated.push(n) })
    expect(values.KEY).toHaveLength(8)
    expect(generated).toEqual(['KEY'])
  })
  it('fills defaults for required vars; optional defaults only under --yes', async () => {
    const vars = [V({ name: 'R', default: 'r' }), V({ name: 'O', required: false, default: 'o' })]
    expect(await resolveVariables(vars, {}, {})).toEqual({ R: 'r' })
    expect(await resolveVariables(vars, {}, { yes: true })).toEqual({ R: 'r', O: 'o' })
  })
  it('prompts for missing required vars on a TTY', async () => {
    const values = await resolveVariables([V({ name: 'URL', description: 'public URL' })], {}, { tty: true, ask: async (v) => `asked:${v.name}` })
    expect(values).toEqual({ URL: 'asked:URL' })
  })
  it('fails with a machine-readable list when it cannot ask', async () => {
    await expect(resolveVariables([V({ name: 'URL', description: 'public URL' })], {}, { yes: true }))
      .rejects.toThrow(/missing required template variables:[\s\S]*URL\s+public URL[\s\S]*--set NAME=value/)
  })
})

describe('missingVariablesFrom', () => {
  it('extracts the platform missing_variables payload', () => {
    const missing = missingVariablesFrom({ error: 'missing_variables', missing: [{ name: 'A', description: 'a' }, { name: 'P', type: 'password' }] })
    expect(missing).toMatchObject([
      { name: 'A', required: true, description: 'a' },
      { name: 'P', required: true, generate: 'secret:32' },
    ])
  })
  it('leaves other errors alone', () => {
    expect(missingVariablesFrom({ error: 'forbidden' })).toBeNull()
    expect(missingVariablesFrom(undefined)).toBeNull()
  })
})

describe('looksLikePath', () => {
  it('reads ./dir, absolute and nested paths as paths, bare codes as codes', () => {
    expect(looksLikePath('./tpl')).toBe(true)
    expect(looksLikePath('/abs/tpl')).toBe(true)
    expect(looksLikePath('sub/dir')).toBe(true)
    expect(looksLikePath('plausible')).toBe(false)
  })
})

describe('deployment progress', () => {
  it('maps statuses (and an explicit step, which wins) to step indexes', () => {
    expect(stepIndexFor('pending')).toBe(0)
    expect(stepIndexFor('writing_variables')).toBe(1)
    expect(stepIndexFor('deploying')).toBe(2)
    expect(stepIndexFor('health_check')).toBe(3)
    expect(stepIndexFor('failed', 'deploy')).toBe(2)
    expect(stepIndexFor('somefuturestatus')).toBeNull()
  })
  it('renders each step exactly once across polls', async () => {
    const seq = [
      { status: 'creating_services' },
      { status: 'creating_services' },
      { status: 'deploying' },
      { status: 'succeeded', urls: ['https://app.example'] },
    ]
    const out: string[] = []
    const dep = await watchDeployment(async () => seq.shift()!, 'd1', (l) => out.push(l), async () => {})
    expect(out).toEqual([
      '  … create services',
      '  ✓ create services',
      '  ✓ write variables',
      '  … deploy',
      '  ✓ deploy',
      '  ✓ health check',
    ])
    expect(dep.urls).toEqual(['https://app.example'])
  })
  it('names the failing step and carries the platform error', async () => {
    const seq = [{ status: 'deploying' }, { status: 'failed', step: 'deploy', error: 'image pull failed' }]
    await expect(watchDeployment(async () => seq.shift()!, 'd1', () => {}, async () => {}))
      .rejects.toThrow('template deployment failed during deploy: image pull failed')
  })
  it('holds progress on an unknown status instead of guessing', async () => {
    const seq = [{ status: 'deploying' }, { status: 'somefuturestatus' }, { status: 'succeeded' }]
    const out: string[] = []
    await watchDeployment(async () => seq.shift()!, 'd1', (l) => out.push(l), async () => {})
    expect(out.filter((l) => l.includes('…'))).toEqual(['  … deploy'])
    expect(out.filter((l) => l.includes('✓'))).toHaveLength(DEPLOY_STEPS.length)
  })
  it('times out with a pointer to the audit trail', async () => {
    await expect(watchDeployment(async () => ({ status: 'deploying' }), 'd9', () => {}, async () => {}, 0))
      .rejects.toThrow(/timed out .*template deployment d9/)
  })
  it('lists success urls from both shapes', () => {
    expect(deploymentUrls({ urls: ['https://a'], services: [{ name: 'app', url: 'https://b' }, { name: 'db' }] }))
      .toEqual(['https://a', 'app: https://b'])
  })
})
