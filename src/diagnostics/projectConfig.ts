import type { AgentProvider, Manifest } from '../manifest/types.js'
import type { Pseudonymizer } from './pseudonymize.js'
import { sanitizeText } from './redact.js'

export interface EffectiveRepositoryConfig {
  readonly name: string
  readonly enabled: boolean
  readonly runnable: boolean
  readonly hasMigrations: boolean
  readonly baselineOverridePresent: boolean
  readonly signalCount: number
  readonly portCount?: number
  readonly dependencyCount?: number
  readonly dependencyTargets?: readonly string[]
  readonly startCommandPresent?: boolean
  readonly healthCheckPresent?: boolean
}

export interface EffectiveApproachConfig {
  readonly id: string
  readonly enabled: boolean
  readonly entrypointPresent: boolean
  readonly sourceType: 'git' | 'npm' | 'custom'
  readonly workflowPhaseCount: number
  readonly workflowPhases: readonly string[]
}

export interface EffectiveProjectConfig {
  readonly projectRef: string
  readonly hostCategory: 'loopback' | 'network' | 'unknown'
  readonly portRangeWidth: number
  readonly baselineBranchRef: string
  readonly worktreePathDisplay: 'absolute' | 'relative'
  readonly ticketLabelTemplatePresent: boolean
  readonly terminalTemplatePresent: boolean
  readonly agentProvider: AgentProvider
  readonly resolvedModel: string | null
  readonly ticketingProvider: string
  readonly advanceOnStart: boolean
  readonly advanceOnShip: boolean
  readonly repositories: readonly EffectiveRepositoryConfig[]
  readonly approach: EffectiveApproachConfig | null
}

function safe(value: string): string {
  return sanitizeText(value).value ?? '[OMITTED:unsafe-metadata]'
}

function hostCategory(host: string): EffectiveProjectConfig['hostCategory'] {
  const normalized = host.trim().toLowerCase()
  if (['localhost', '127.0.0.1', '::1', '[::1]'].includes(normalized)) return 'loopback'
  if (/^[a-z0-9.-]+$/i.test(normalized) && normalized.length > 0) return 'network'
  return 'unknown'
}

export function projectEffectiveConfig(
  manifest: Manifest,
  input: {
    readonly projectIdentity: string
    readonly selectedRepos: readonly string[]
    readonly selectedApproach: string | null
    readonly resolvedModel: string | undefined
    readonly resolvedProvider: AgentProvider
    readonly aliases: Pseudonymizer
    readonly repositoryAlias: (name: string) => string
  },
): EffectiveProjectConfig {
  const selected = new Set(input.selectedRepos)
  const repositories = Object.entries(manifest.repositories)
    .filter(([name]) => selected.has(name))
    .map(([name, repository]): EffectiveRepositoryConfig => {
      const service = repository.service
      return {
        name: input.repositoryAlias(name),
        enabled: repository.enabled !== false,
        runnable: service !== undefined,
        hasMigrations: repository.hasMigrations,
        baselineOverridePresent: repository.baselineBranch !== undefined,
        signalCount: repository.signals?.length ?? 0,
        ...(service
          ? {
            portCount: service.ports.length,
            dependencyCount: service.dependsOn.length,
            dependencyTargets: service.dependsOn.map(
              (dependency) => input.repositoryAlias(dependency.target),
            ),
            startCommandPresent: service.start.trim().length > 0,
            healthCheckPresent: Boolean(service.health?.trim()),
          }
          : {}),
      }
    })
  const approach = (manifest.approaches ?? [])
    .find((candidate) => candidate.id === input.selectedApproach)
  const workflowPhases = approach?.workflow?.map((phase) => safe(phase.name)) ?? []

  return {
    projectRef: input.aliases.project(input.projectIdentity),
    hostCategory: hostCategory(manifest.host),
    portRangeWidth: Math.max(0, manifest.portRange[1] - manifest.portRange[0] + 1),
    baselineBranchRef: input.aliases.branch(manifest.baselineBranch),
    worktreePathDisplay: manifest.worktreePathDisplay ?? 'absolute',
    ticketLabelTemplatePresent: Boolean(manifest.ticketLabelTemplate),
    terminalTemplatePresent: Boolean(manifest.terminalNameTemplate),
    agentProvider: input.resolvedProvider,
    resolvedModel: input.resolvedModel ? safe(input.resolvedModel) : null,
    ticketingProvider: manifest.ticketing?.provider ?? 'manual',
    advanceOnStart: manifest.ticketing?.advanceOnStart ?? false,
    advanceOnShip: manifest.ticketing?.advanceOnShip ?? false,
    repositories,
    approach: approach
      ? {
        id: safe(approach.id),
        enabled: approach.enabled !== false,
        entrypointPresent: Boolean(approach.entrypoint),
        sourceType: approach.source?.type ?? 'custom',
        workflowPhaseCount: workflowPhases.length,
        workflowPhases,
      }
      : null,
  }
}
