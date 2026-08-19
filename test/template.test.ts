import { describe, it, expect } from 'vitest'
import {
  imageTagIssue, validateManifest, collectManifestVariables, parseManifestYaml,
  type TemplateManifest, type TemplateVar,
} from '../src/template-manifest.js'
import {
  templateListLines, templateInfoLines, normalizeInfoServices, normalizeInfoVariables,
  parseSetFlags, resolveVariables, missingVariablesFrom, looksLikePath,
  stepIndexFor, deploymentUrls, serviceStateLines, partialMessage, watchDeployment, DEPLOY_STEPS,
} from '../src/commands/template.js'

const MANIFEST: TemplateManifest = {
  code: 'plausible',
  version: '2.1.1',
  maintainer: 'insforge',
  upstream: { pinned: 'ghcr.io/plausible/community-edition:v2.1.1' },
  generated: { 'db-pass': 'secret:32' },
  services: {
    app: {
      type: 'web',
      image: 'ghcr.io/plausible/community-edition:v2.1.1',
      port: 8000,
      healthcheck: '/api/health',
      env: {
        fixed: { DISABLE_REGISTRATION: 'true' },
        generated: { SECRET_KEY_BASE: '${db-pass}' },
        required: { BASE_URL: { description: 'public URL the app is served at' } },
        optional: { SMTP_HOST: 'SMTP relay host' },
      },
    },
    worker: { type: 'worker', image: 'ghcr.io/plausible/community-edition:v2.1.1', volume: { size: 10 } },
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
    const m = { ...MANIFEST, services: { app: { type: 'worker', image: 'nginx:latest' } } }
    expect(validateManifest(m).join('\n')).toMatch(/not a pin/)
  })
  // The platform's service model (templateManifest.ts): type is web|worker, image XOR build.
  it('requires a web|worker type and exactly one of image/build', () => {
    const m: TemplateManifest = { code: 'x', version: '1', services: { a: { type: 'postgres' as any, image: 'a:1', build: 'b' }, b: {} } }
    const problems = validateManifest(m)
    expect(problems).toContain('services.a.type must be web or worker')
    expect(problems).toContain('services.a: image and build are mutually exclusive')
    expect(problems).toContain('services.b: one of image or build is required')
  })
  it('requires web services to declare an absolute healthcheck path', () => {
    const m: TemplateManifest = { code: 'x', version: '1', services: { a: { type: 'web', image: 'a:1' }, b: { type: 'web', image: 'b:1', healthcheck: 'health' } } }
    const problems = validateManifest(m)
    expect(problems).toContain('services.a: web services must declare a healthcheck path')
    expect(problems).toContain('services.b: healthcheck must be an absolute path (start with /)')
  })
  it('requires a description on required vars unless a generator answers for the user', () => {
    const m: TemplateManifest = {
      code: 'x', version: '1',
      services: { a: { type: 'worker', image: 'a:1', env: { required: { PLAIN: {}, GEN: { generate: 'secret:16' } } } } },
    }
    expect(validateManifest(m)).toEqual(['services.a.env.required.PLAIN: a description is required (unless generate is set)'])
  })
  it('enforces platform env-name and generator-spec shapes', () => {
    const m: TemplateManifest = {
      code: 'x', version: '1', generated: { g: 'uuid' },
      services: { a: { type: 'worker', image: 'a:1', env: { fixed: { lower_case: '1' }, required: { BAD_GEN: { generate: 'secret:0' } } } } },
    }
    const problems = validateManifest(m).join('\n')
    expect(problems).toMatch(/generated\.g: unknown generator 'uuid'/)
    expect(problems).toMatch(/env names must match/)
    expect(problems).toMatch(/BAD_GEN: generate must be secret:N/)
  })
  it('requires env.generated to reference a declared generator', () => {
    const m: TemplateManifest = {
      code: 'x', version: '1', generated: { key: 'secret:32' },
      services: { a: { type: 'worker', image: 'a:1', env: { generated: { A_REF: 'plain', B_REF: '${nope}', C_REF: '${key}' } } } },
    }
    const problems = validateManifest(m)
    expect(problems).toContain('services.a.env.generated.A_REF must reference a declared generator like ${name}')
    expect(problems).toContain("services.a.env.generated.B_REF references undeclared generator 'nope'")
    expect(problems).toHaveLength(2)
  })
  it('rejects out-of-range ports and fractional volumes', () => {
    const m: TemplateManifest = { code: 'x', version: '1', services: { a: { type: 'worker', image: 'a:1', port: 70000, volume: { size: 1.5 } } } }
    const problems = validateManifest(m).join('\n')
    expect(problems).toMatch(/port must be an integer/)
    expect(problems).toMatch(/volume.size must be a whole Gi/)
  })
})

describe('parseManifestYaml', () => {
  it('parses and validates YAML text', () => {
    const m = parseManifestYaml(['code: demo', 'version: "1.0"', 'services:', '  app:', '    type: worker', '    image: nginx:1.27'].join('\n'))
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
  it('merges duplicates: required anywhere wins, later mentions backfill unset fields', () => {
    const m: TemplateManifest = {
      code: 'x', version: '1', services: {
        a: { type: 'worker', image: 'a:1', env: { optional: { K: { default: 'd' } } } },
        b: { type: 'worker', image: 'b:1', env: { required: { K: { description: 'desc' } } } },
      },
    }
    const vars = collectManifestVariables(m)
    expect(vars).toEqual([{ name: 'K', required: true, description: 'desc', default: 'd', generate: undefined }])
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
  // The registry detail shape (TemplateDetail): grouped variables, manifest-map services.
  const tpl = {
    code: 'plausible', name: 'Plausible', tagline: 'self-hosted web analytics', version: '2.1.1',
    maintainer: 'insforge', source: 'github.com/plausible/community-edition',
    upstream: { pinned: 'ghcr.io/plausible/community-edition:v2.1.1' },
    services: [
      { name: 'app', type: 'web', port: 8000 },
      { name: 'worker', type: 'worker', volumeGib: 10 },
    ],
    variables: {
      required: [
        { name: 'BASE_URL', required: true, description: 'public URL' },
        { name: 'ADMIN_PWD', required: true, generate: 'secret:32' },
      ],
      optional: [{ name: 'SMTP_HOST', required: false, description: 'SMTP relay', default: 'localhost' }],
    },
  }
  it('renders header fields, a services summary, and grouped variables', () => {
    const lines = templateInfoLines(tpl)
    expect(lines[0]).toBe('plausible — Plausible')
    expect(lines).toContain('  version     2.1.1')
    expect(lines).toContain('  source      github.com/plausible/community-edition')
    expect(lines).toContain('  upstream    ghcr.io/plausible/community-edition:v2.1.1')
    expect(lines).toContain('services (2): app (web, port 8000), worker (worker, 10Gi volume)')
    const text = lines.join('\n')
    expect(text).toMatch(/required:\n\s+BASE_URL\s+public URL\n\s+ADMIN_PWD\s+\(generated: secret:32\)/)
    expect(text).toMatch(/optional:\n\s+SMTP_HOST\s+SMTP relay \(default: localhost\)/)
  })
  it('bolds required variable names with the injected emphasis', () => {
    const lines = templateInfoLines(tpl, (s) => `<b>${s}</b>`)
    expect(lines.join('\n')).toContain('<b>BASE_URL')
    expect(lines.join('\n')).not.toContain('<b>SMTP_HOST')
  })
  it('renders manifest-shaped (map) services too, normalized or not', () => {
    expect(normalizeInfoServices({ app: { type: 'web', port: 80 }, worker: { type: 'worker', volume: { size: 5 } }, norm: { volumeGib: 3 } })).toEqual([
      { name: 'app', type: 'web', port: 80, volumeGib: undefined },
      { name: 'worker', type: 'worker', port: undefined, volumeGib: 5 },
      { name: 'norm', type: undefined, port: undefined, volumeGib: 3 },
    ])
  })
  it('accepts flat variable arrays too', () => {
    const vars = normalizeInfoVariables([{ name: 'A', required: true, description: 'a' }, { name: 'B' }])
    expect(vars).toMatchObject([{ name: 'A', required: true }, { name: 'B', required: false }])
  })
})

describe('parseSetFlags', () => {
  it('parses NAME=value pairs, last occurrence winning; values may contain =', () => {
    expect(parseSetFlags(['A=1', 'B_2=x=y', 'A=2'])).toEqual({ A: '2', B_2: 'x=y' })
  })
  it('rejects pairs without =, and names outside the platform env-name rule', () => {
    expect(() => parseSetFlags(['JUNK'])).toThrow(/--set expects NAME=value/)
    expect(() => parseSetFlags(['1A=2'])).toThrow(/--set expects NAME=value/)
    expect(() => parseSetFlags(['lower=2'])).toThrow(/--set expects NAME=value/)
  })
})

describe('resolveVariables', () => {
  const V = (v: Partial<TemplateVar> & { name: string }): TemplateVar => ({ required: true, ...v })
  it('--set wins over everything, and unknown --set names pass through', async () => {
    const values = await resolveVariables([V({ name: 'A', generate: 'secret:8' })], { A: 'mine', EXTRA: 'x' })
    expect(values).toEqual({ A: 'mine', EXTRA: 'x' })
  })
  // The platform resolves provided → generator → default itself; generated secrets never transit.
  it('leaves generator-backed and defaulted vars off the wire, reporting them', async () => {
    const auto: string[] = []
    const values = await resolveVariables(
      [V({ name: 'KEY', generate: 'secret:8' }), V({ name: 'R', default: 'r' }), V({ name: 'O', required: false, default: 'o' })],
      {},
      { onAutoResolved: (v) => auto.push(v.name) },
    )
    expect(values).toEqual({})
    expect(auto).toEqual(['KEY', 'R', 'O'])
  })
  it('skips optional vars without prompting', async () => {
    expect(await resolveVariables([V({ name: 'O', required: false, description: 'opt' })], {}, {})).toEqual({})
  })
  it('prompts for missing required vars on a TTY', async () => {
    const values = await resolveVariables([V({ name: 'URL', description: 'public URL' })], {}, { tty: true, ask: async (v) => `asked:${v.name}` })
    expect(values).toEqual({ URL: 'asked:URL' })
  })
  it('fails with a machine-readable list when it cannot ask', async () => {
    await expect(resolveVariables([V({ name: 'URL', description: 'public URL' })], {}, {}))
      .rejects.toThrow(/missing required template variables:[\s\S]*URL\s+public URL[\s\S]*--set NAME=value/)
  })
})

describe('missingVariablesFrom', () => {
  it('extracts the platform missing_variables payload (and its alias key)', () => {
    expect(missingVariablesFrom({ error: 'missing_variables', missing: [{ name: 'A', key: 'A', description: 'a' }] }))
      .toEqual([{ name: 'A', required: true, description: 'a' }])
    expect(missingVariablesFrom({ error: 'missing_variables', missingVariables: [{ name: 'B', key: 'B' }] }))
      .toEqual([{ name: 'B', required: true, description: undefined }])
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
  it('maps the step field to an index; anything else holds progress', () => {
    expect(stepIndexFor('create_services')).toBe(0)
    expect(stepIndexFor('write_variables')).toBe(1)
    expect(stepIndexFor('deploy')).toBe(2)
    expect(stepIndexFor('health_check')).toBe(3)
    expect(stepIndexFor(undefined)).toBeNull()
    expect(stepIndexFor('somefuturestep')).toBeNull()
  })
  it('renders each step exactly once across polls', async () => {
    const seq = [
      { status: 'running', step: 'create_services' },
      { status: 'running', step: 'create_services' },
      { status: 'running', step: 'deploy' },
      { status: 'succeeded', services: [{ name: 'app', state: 'healthy', url: 'https://app.example' }] },
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
    expect(deploymentUrls(dep)).toEqual(['app: https://app.example'])
  })
  it('names the failing step and carries the platform error + log tail', async () => {
    const seq = [
      { status: 'running', step: 'deploy' },
      { status: 'failed', step: 'deploy', error: 'image pull failed', logsTail: 'manifest unknown', services: [{ name: 'app', state: 'failed' }] },
    ]
    await expect(watchDeployment(async () => seq.shift()!, 'd1', () => {}, async () => {}))
      .rejects.toThrow(/failed during deploy: image pull failed[\s\S]*✗ app \[failed\][\s\S]*--- log tail ---\nmanifest unknown/)
  })
  // `partial` is TERMINAL (created resources are kept) — without this branch the watcher would
  // poll a settled run to the timeout.
  it('treats partial as terminal, listing per-service outcomes and the way forward', async () => {
    const seq = [
      { status: 'running', step: 'health_check' },
      {
        status: 'partial', step: 'health_check',
        services: [
          { name: 'app', state: 'healthy', url: 'https://app.example' },
          { name: 'worker', state: 'failed' },
        ],
        logsTail: 'OOM killed',
      },
    ]
    await expect(watchDeployment(async () => seq.shift()!, 'd1', () => {}, async () => {}))
      .rejects.toThrow(/finished partial: 1\/2 services healthy[\s\S]*✓ app — https:\/\/app\.example\n\s+✗ worker \[failed\][\s\S]*--- log tail ---\nOOM killed[\s\S]*created services are kept[\s\S]*re-run the deploy to retry/)
  })
  it('holds progress on a missing/unknown step instead of guessing', async () => {
    const seq = [{ status: 'running', step: 'deploy' }, { status: 'running' }, { status: 'succeeded' }]
    const out: string[] = []
    await watchDeployment(async () => seq.shift()!, 'd1', (l) => out.push(l), async () => {})
    expect(out.filter((l) => l.includes('…'))).toEqual(['  … deploy'])
    expect(out.filter((l) => l.includes('✓'))).toHaveLength(DEPLOY_STEPS.length)
  })
  it('times out with a pointer to the audit trail', async () => {
    await expect(watchDeployment(async () => ({ status: 'running', step: 'deploy' }), 'd9', () => {}, async () => {}, 0))
      .rejects.toThrow(/timed out .*template deployment d9/)
  })
  it('marks non-terminal service states neutrally', () => {
    expect(serviceStateLines({ services: [{ name: 'app', state: 'created' }] })).toEqual(['  • app [created]'])
    expect(partialMessage({ services: [] })).toMatch(/0\/0 services healthy/)
  })
})
