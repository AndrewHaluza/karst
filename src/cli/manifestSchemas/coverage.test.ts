import { describe, expect, it } from 'vitest';
import type { JsonSchema } from '../jsonSchema.js';
import type { AutopilotConfig } from '../../manifest/autopilot.js';
import { PRESET_CAPABILITIES } from '../../manifest/types.js';
import type {
  AgentDef,
  AgentPreset,
  AnalysisConfig,
  ApproachDef,
  ArtifactConventions,
  BindVar,
  DependsOn,
  DockerDef,
  GateDef,
  GraphApproachConfig,
  GraphCommandConfig,
  GraphLimits,
  GraphPlannerConfig,
  GraphProfileConfig,
  GraphWorkspaceDef,
  Manifest,
  OutputDef,
  PortSlot,
  PresetSlot,
  ProcessAssignmentConfig,
  ProcessAssignmentsConfig,
  QuotaConfig,
  RepoConventions,
  RepositoryDef,
  ResilienceConfig,
  ReviewConfig,
  ReviewFindingsConfig,
  ReviewStallDetection,
  ServiceDef,
  ShipDef,
  SubtaskLimits,
  TicketingConfig,
  UatAuthBootstrap,
  UatAuthor,
  UatBaselineReviewConfig,
  UatConfig,
  UatGateDef,
  UatHarnessDef,
  UatRepositoryOverride,
  UatTesterConfig,
  UatTesterObservationsConfig,
  UatTesterRequireEvidence,
  WorkflowPhase,
} from '../../manifest/types.js';
import { MANIFEST_SECTIONS, MANIFEST_SECTION_SCHEMAS, sectionFields } from './index.js';
import type { ManifestSection } from './index.js';

/**
 * Each record below lists EVERY key of one manifest type, as `Record<keyof T, true>`.
 * A key added to the type breaks `npm run typecheck` until it is listed here, and a
 * listed key breaks the test below until the section schema has a property for it.
 * This is the enforcement of the schema step in @arch:FIELDCHK.
 */
type Keys<T> = Record<keyof T, true>;

const MANIFEST: Keys<Manifest> = {
  id: true, host: true, portRange: true, baselineBranch: true, repositories: true, approaches: true,
  agents: true, worktreePathDisplay: true, ticketLabelTemplate: true, terminalNameTemplate: true,
  conventions: true, ticketing: true, agentProvider: true, defaultModel: true, resilience: true,
  defaultEffort: true, agentPresets: true, activeAgentPreset: true, defaultAgentPreset: true,
  archiveDoneAfterDays: true, archivePlanningAfterDays: true, artifacts: true, subtasks: true,
  debug: true, agentSandbox: true, agentBackends: true, sandboxMemory: true, sandboxLimits: true,
  autopilot: true, closeDoneTerminalsWithTicket: true, diffsInSourceControl: true,
  stopServersOnDone: true, uat: true, analysis: true, quota: true, review: true, processes: true,
};
const REPOSITORY: Keys<RepositoryDef> = {
  repoPath: true, baselineBranch: true, hasMigrations: true, signals: true, scope: true, conventions: true,
  service: true, services: true, sandbox: true, graphWorkspace: true, ship: true, enabled: true,
};
const SERVICE: Keys<ServiceDef> = {
  start: true, docker: true, health: true, build: true, reset: true, cwd: true, healthIdentity: true,
  healthTimeoutSeconds: true, sandbox: true, ports: true, portRange: true, dependsOn: true,
};
const DOCKER: Keys<DockerDef> = { image: true, containerPort: true, env: true, volumes: true, args: true };
const PORT: Keys<PortSlot> = { name: true, env: true, default: true };
const DEPENDS_ON: Keys<DependsOn> = { target: true, port: true, bind: true };
const BIND: Keys<BindVar> = { env: true, template: true };
const SHIP: Keys<ShipDef> = { exclude: true, regenerate: true };
const REPO_CONVENTIONS: Keys<RepoConventions> = { commitMessage: true, pullRequestTitle: true, pullRequestDescription: true };
const GRAPH_WORKSPACE: Keys<GraphWorkspaceDef> = { link: true, setup: true, setupWhen: true };
const ARTIFACT_CONVENTIONS: Keys<ArtifactConventions> = {
  branchName: true, commitMessage: true, pullRequestTitle: true, pullRequestDescription: true, defaultType: true,
};
const APPROACH: Keys<ApproachDef> = {
  id: true, label: true, description: true, entrypoint: true, source: true, recommended: true, workflow: true,
  outputs: true, checks: true, enabled: true, graph: true,
};
const WORKFLOW: Keys<WorkflowPhase> = { name: true, command: true, description: true };
const OUTPUT: Keys<OutputDef> = { glob: true, kind: true };
const GRAPH: Keys<GraphApproachConfig> = { planner: true, profiles: true, commands: true, limits: true };
const GRAPH_PLANNER: Keys<GraphPlannerConfig> = { profile: true, prompt: true };
const GRAPH_PROFILE: Keys<GraphProfileConfig> = { provider: true, model: true, effort: true };
const GRAPH_COMMAND: Keys<GraphCommandConfig> = { command: true, args: true, cwd: true, access: true, timeoutSeconds: true, env: true };
const GRAPH_LIMITS: Keys<GraphLimits> = {
  maxParallel: true, maxNodeRuns: true, maxExpertRuns: true, maxReplans: true, maxActivations: true,
  maxGraphWallSeconds: true, maxAgentWallSeconds: true, maxAgentIdleSeconds: true, maxArtifactBytes: true,
  maxLogBytes: true, maxAggregateArtifactBytes: true, maxAggregateWorkspaceBytes: true,
};
const AGENT: Keys<AgentDef> = { role: true, command: true, promptPath: true, enabled: true };
const TICKETING: Keys<TicketingConfig> = {
  provider: true, teamId: true, listId: true, advanceOnShip: true, shipStatus: true, advanceOnStart: true,
  startStatus: true, searchEnabled: true, syncSubtasks: true,
};
const GATE: Keys<GateDef> = {
  name: true, kind: true, script: true, command: true, args: true, repo: true, sandbox: true,
  onResourceKill: true, maxConcurrent: true, timeoutMinutes: true, enabled: true,
};
const UAT_GATE: Keys<UatGateDef> = { ...GATE, report: true };
const UAT: Keys<UatConfig> = {
  testDir: true, maxFixAttempts: true, stallTimeoutMinutes: true, gates: true, probeWhenAllDisabled: true,
  keepStackForUser: true, testerVerifier: true, testerObservations: true, tester: true, baselineReview: true,
  harnesses: true,
  env: true, secrets: true, passthrough: true, origins: true, authBootstrap: true, author: true, repositories: true,
};
const OBSERVATIONS: Keys<UatTesterObservationsConfig> = { blockingSeverity: true, onSkip: true, requireEvidence: true };
const EVIDENCE: Keys<UatTesterRequireEvidence> = { file: true, whenChanged: true };
const TESTER: Keys<UatTesterConfig> = { tokenBudget: true };
const HARNESS: Keys<UatHarnessDef> = {
  name: true, whenChanged: true, start: true, stop: true, evidence: true, startTimeoutSeconds: true, description: true,
};
const BASELINE_REVIEW: Keys<UatBaselineReviewConfig> = { paths: true };
const AUTH_BOOTSTRAP: Keys<UatAuthBootstrap> = { path: true, secrets: true };
const AUTHOR: Keys<UatAuthor> = { agent: true, enabled: true };
const UAT_REPOSITORY: Keys<UatRepositoryOverride> = { env: true, secrets: true, gates: true, testDir: true };
const REVIEW: Keys<ReviewConfig> = {
  maxFixAttempts: true, stallTimeoutMinutes: true, requireIndependentSignal: true, openChanges: true, gates: true,
  probeWhenAllDisabled: true, findings: true, stallDetection: true, repositories: true,
};
const FINDINGS: Keys<ReviewFindingsConfig> = { enabled: true, blockingSeverity: true, maxFindings: true };
const STALL: Keys<ReviewStallDetection> = { enabled: true, sameFileRounds: true, repeatedFindingRounds: true };
const PROCESS: Keys<ProcessAssignmentConfig> = {
  agentName: true, agent: true, provider: true, model: true, effort: true, preset: true, pinned: true, enabled: true,
};
const PROCESSES: Keys<ProcessAssignmentsConfig> = {
  uatTester: true, uatFix: true, review: true, reviewFix: true, prDescription: true, ticketAnalysis: true,
  stallSuggestion: true, planning: true,
};
const RESILIENCE: Keys<ResilienceConfig> = { retries: true, backoffMs: true, fallbackModels: true };
const QUOTA: Keys<QuotaConfig> = { warnThresholdPct: true, claudeGlobalStatusline: true, claudeOauthUsageApi: true };
const ANALYSIS: Keys<AnalysisConfig> = { codePointers: true };
const PRESET: Keys<AgentPreset> = { label: true, slots: true };
const SLOT: Keys<PresetSlot> = { provider: true, model: true, effort: true };
const SUBTASKS: Keys<SubtaskLimits> = { maxConcurrentPerParent: true, maxConcurrentTotal: true };
const AUTOPILOT: Keys<AutopilotConfig> = { enabled: true, ci: true, conflicts: true };

/** `*` follows `items` or `additionalProperties`; any other segment is a property name. */
interface Node {
  name: string;
  section: ManifestSection;
  path: string;
  keys: readonly string[];
}

const REPO = 'repositories.*';
const SVC = `${REPO}.services.*`;
const NODES: readonly Node[] = [
  { name: 'RepositoryDef', section: 'services', path: REPO, keys: Object.keys(REPOSITORY) },
  { name: 'ServiceDef', section: 'services', path: SVC, keys: Object.keys(SERVICE) },
  { name: 'ServiceDef (single)', section: 'services', path: `${REPO}.service`, keys: Object.keys(SERVICE) },
  { name: 'DockerDef', section: 'services', path: `${SVC}.docker`, keys: Object.keys(DOCKER) },
  { name: 'PortSlot', section: 'services', path: `${SVC}.ports.*`, keys: Object.keys(PORT) },
  { name: 'DependsOn', section: 'services', path: `${SVC}.dependsOn.*`, keys: Object.keys(DEPENDS_ON) },
  { name: 'BindVar', section: 'services', path: `${SVC}.dependsOn.*.bind.*`, keys: Object.keys(BIND) },
  { name: 'ShipDef', section: 'services', path: `${REPO}.ship`, keys: Object.keys(SHIP) },
  { name: 'RepoConventions', section: 'services', path: `${REPO}.conventions`, keys: Object.keys(REPO_CONVENTIONS) },
  { name: 'GraphWorkspaceDef', section: 'services', path: `${REPO}.graphWorkspace`, keys: Object.keys(GRAPH_WORKSPACE) },
  { name: 'ArtifactConventions', section: 'git', path: 'conventions', keys: Object.keys(ARTIFACT_CONVENTIONS) },
  { name: 'SubtaskLimits', section: 'general', path: 'subtasks', keys: Object.keys(SUBTASKS) },
  { name: 'ApproachDef', section: 'approaches', path: 'approaches.*', keys: Object.keys(APPROACH) },
  { name: 'WorkflowPhase', section: 'approaches', path: 'approaches.*.workflow.*', keys: Object.keys(WORKFLOW) },
  { name: 'OutputDef', section: 'approaches', path: 'approaches.*.outputs.*', keys: Object.keys(OUTPUT) },
  { name: 'GraphApproachConfig', section: 'approaches', path: 'approaches.*.graph', keys: Object.keys(GRAPH) },
  { name: 'GraphPlannerConfig', section: 'approaches', path: 'approaches.*.graph.planner', keys: Object.keys(GRAPH_PLANNER) },
  { name: 'GraphProfileConfig', section: 'approaches', path: 'approaches.*.graph.profiles.*', keys: Object.keys(GRAPH_PROFILE) },
  { name: 'GraphCommandConfig', section: 'approaches', path: 'approaches.*.graph.commands.*', keys: Object.keys(GRAPH_COMMAND) },
  { name: 'GraphLimits', section: 'approaches', path: 'approaches.*.graph.limits', keys: Object.keys(GRAPH_LIMITS) },
  { name: 'AgentDef', section: 'agents', path: 'agents.*', keys: Object.keys(AGENT) },
  { name: 'ProcessAssignmentConfig', section: 'agents', path: 'processes.uatTester', keys: Object.keys(PROCESS) },
  { name: 'AgentPreset', section: 'agents', path: 'agentPresets.*', keys: Object.keys(PRESET) },
  { name: 'PresetSlot', section: 'agents', path: `agentPresets.*.slots.${PRESET_CAPABILITIES[0]}`, keys: Object.keys(SLOT) },
  { name: 'QuotaConfig', section: 'agents', path: 'quota', keys: Object.keys(QUOTA) },
  { name: 'TicketingConfig', section: 'ticketing', path: 'ticketing', keys: Object.keys(TICKETING) },
  { name: 'UatConfig', section: 'quality', path: 'uat', keys: Object.keys(UAT) },
  { name: 'UatGateDef', section: 'quality', path: 'uat.gates.*', keys: Object.keys(UAT_GATE) },
  { name: 'GateDef (review)', section: 'quality', path: 'review.gates.*', keys: Object.keys(GATE) },
  { name: 'UatTesterObservationsConfig', section: 'quality', path: 'uat.testerObservations', keys: Object.keys(OBSERVATIONS) },
  { name: 'UatTesterRequireEvidence', section: 'quality', path: 'uat.testerObservations.requireEvidence', keys: Object.keys(EVIDENCE) },
  { name: 'UatTesterConfig', section: 'quality', path: 'uat.tester', keys: Object.keys(TESTER) },
  { name: 'UatBaselineReviewConfig', section: 'quality', path: 'uat.baselineReview', keys: Object.keys(BASELINE_REVIEW) },
  { name: 'UatHarnessDef', section: 'quality', path: 'uat.harnesses.*', keys: Object.keys(HARNESS) },
  { name: 'UatAuthBootstrap', section: 'quality', path: 'uat.authBootstrap', keys: Object.keys(AUTH_BOOTSTRAP) },
  { name: 'UatAuthor', section: 'quality', path: 'uat.author', keys: Object.keys(AUTHOR) },
  { name: 'UatRepositoryOverride', section: 'quality', path: 'uat.repositories.*', keys: Object.keys(UAT_REPOSITORY) },
  { name: 'ReviewConfig', section: 'quality', path: 'review', keys: Object.keys(REVIEW) },
  { name: 'ReviewFindingsConfig', section: 'quality', path: 'review.findings', keys: Object.keys(FINDINGS) },
  { name: 'ReviewStallDetection', section: 'quality', path: 'review.stallDetection', keys: Object.keys(STALL) },
  { name: 'AutopilotConfig', section: 'autopilot', path: 'autopilot', keys: Object.keys(AUTOPILOT) },
  { name: 'ResilienceConfig', section: 'project', path: 'resilience', keys: Object.keys(RESILIENCE) },
  { name: 'AnalysisConfig', section: 'project', path: 'analysis', keys: Object.keys(ANALYSIS) },
];

/** Every concrete schema reachable from `schema`: `$ref`, `anyOf` and `oneOf` are followed. */
function leaves(schema: JsonSchema, root: JsonSchema): JsonSchema[] {
  if (schema.$ref !== undefined) {
    const target = root.$defs?.[schema.$ref.replace('#/$defs/', '')];
    return target === undefined ? [] : leaves(target, root);
  }
  const alternatives = [...(schema.anyOf ?? []), ...(schema.oneOf ?? [])];
  if (alternatives.length > 0) return alternatives.flatMap((alt) => leaves(alt, root));
  return [schema];
}

function child(schemas: JsonSchema[], segment: string, root: JsonSchema): JsonSchema[] {
  return schemas.flatMap((schema) => {
    if (segment === '*') {
      const extra = typeof schema.additionalProperties === 'object' ? [schema.additionalProperties] : [];
      return [...(schema.items === undefined ? [] : [schema.items]), ...extra].flatMap((s) => leaves(s, root));
    }
    const property = schema.properties?.[segment];
    return property === undefined ? [] : leaves(property, root);
  });
}

function propertyKeys(section: ManifestSection, path: string): Set<string> {
  const root = MANIFEST_SECTION_SCHEMAS[section];
  let nodes = leaves(root, root);
  for (const segment of path.split('.')) nodes = child(nodes, segment, root);
  return new Set(nodes.flatMap((node) => Object.keys(node.properties ?? {})));
}

describe('every manifest key has a schema property (@arch:FIELDCHK)', () => {
  it('the sections claim every key of Manifest', () => {
    const claimed = new Set(MANIFEST_SECTIONS.flatMap((section) => sectionFields(section)));
    expect([...Object.keys(MANIFEST)].filter((key) => !claimed.has(key))).toEqual([]);
    expect([...claimed].filter((key) => !(key in MANIFEST))).toEqual([]);
  });

  it('each section schema has a property for each field the section claims', () => {
    for (const section of MANIFEST_SECTIONS) {
      const root = MANIFEST_SECTION_SCHEMAS[section];
      const have = new Set(leaves(root, root).flatMap((node) => Object.keys(node.properties ?? {})));
      expect(sectionFields(section).filter((field) => !have.has(field)), section).toEqual([]);
    }
  });

  it.each(NODES.map((node) => ({ ...node })))('$name has a property for every key ($section: $path)', (node) => {
    const have = propertyKeys(node.section, node.path);
    expect(have.size, `${node.section}: ${node.path} resolves to no schema`).toBeGreaterThan(0);
    expect(node.keys.filter((key) => !have.has(key))).toEqual([]);
  });

  it('process rows cover every process key', () => {
    expect(Object.keys(PROCESSES).filter((key) => !propertyKeys('agents', 'processes').has(key))).toEqual([]);
  });
});
