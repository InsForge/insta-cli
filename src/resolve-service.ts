// `insta services add` with no type (or no name): the three service kinds are otherwise only
// discoverable by guessing wrong and reading `type must be postgres|storage|compute`, so missing
// arguments answer "what can I add?" instead. A terminal gets the two questions the dashboard's
// Add Service asks — what, then what to call it; an agent gets the same list as an error, because
// nothing was created and a silent exit 0 would read as success. No flags are asked for: postgres
// and storage need none, and a compute service is legitimately empty until `insta deploy`.
import * as clack from '@clack/prompts'
import { SERVICE_TYPES, assertServiceName, type ServiceType } from './commands/services.js'

export type ServiceKind = { type: ServiceType; hint: string; defaultName: string }

export const SERVICE_KINDS: readonly ServiceKind[] = [
  { type: 'postgres', hint: 'relational DB, usable as soon as it is added', defaultName: 'main-db' },
  { type: 'storage', hint: 'S3-compatible bucket, private by default', defaultName: 'assets' },
  { type: 'compute', hint: 'an app to deploy code to (empty until `insta deploy`)', defaultName: 'app' },
]

export type ServiceArgsDeps = {
  selectType: (kinds: readonly ServiceKind[]) => Promise<ServiceType>
  askName: (kind: ServiceKind) => Promise<string>
  tty: boolean
}

/** The kind list, one line each — what a terminal picks from and an agent reads. */
export function serviceKindLines(): string[] {
  return SERVICE_KINDS.map((k) => `  ${k.type.padEnd(9)} ${k.hint}`)
}

/** What to say when there is no terminal to ask: the missing half, and how to supply it. */
export function missingArgsMessage(type?: string): string {
  const known = SERVICE_KINDS.find((k) => k.type === type)
  if (known) return `name the service:  insta services add ${known.type} ${known.defaultName}`
  return ['what to add:', ...serviceKindLines(), '', '  e.g. insta services add postgres main-db'].join('\n')
}

/**
 * Fill in whatever `insta services add` was not given. An unknown type passes straight through so
 * `assertType` — not this — reports it, keeping one wording for a bad type everywhere.
 */
export async function resolveServiceArgs(
  type: string | undefined,
  name: string | undefined,
  deps: ServiceArgsDeps,
): Promise<{ type: string; name: string }> {
  if (type && name) return { type, name }
  if (type && !SERVICE_TYPES.includes(type as ServiceType)) return { type, name: name ?? '' }
  if (!deps.tty) throw new Error(missingArgsMessage(type))
  const picked = type ? (type as ServiceType) : await deps.selectType(SERVICE_KINDS)
  const kind = SERVICE_KINDS.find((k) => k.type === picked)
  if (!kind) return { type: picked, name: name ?? '' }
  return { type: picked, name: name ?? (await deps.askName(kind)) }
}

/** Real prompts (clack, as the InsForge CLI's `create`); cancelling exits without provisioning. */
export async function promptServiceType(kinds: readonly ServiceKind[]): Promise<ServiceType> {
  const picked = await clack.select({
    message: 'What do you want to add?',
    options: kinds.map((k) => ({ value: k.type, label: k.type, hint: k.hint })),
  })
  if (clack.isCancel(picked)) process.exit(0)
  return picked
}

export async function promptServiceName(kind: ServiceKind): Promise<string> {
  const answer = await clack.text({
    message: `Name this ${kind.type} service:`,
    initialValue: kind.defaultName,
    // The same rule the command enforces, reported before Enter rather than after a round trip.
    validate: (v) => {
      try {
        assertServiceName(v.trim())
        return undefined
      } catch (e) {
        return (e as Error).message
      }
    },
  })
  if (clack.isCancel(answer)) process.exit(0)
  return answer.trim()
}

/** Prompts on a real terminal only — an agent's stdin is not one, and must never block. */
export function serviceArgsDeps(): ServiceArgsDeps {
  return {
    selectType: promptServiceType,
    askName: promptServiceName,
    tty: !!process.stdin.isTTY && !!process.stdout.isTTY,
  }
}
