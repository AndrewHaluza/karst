import type {
  Manifest,
  RepositoryDef,
  ApproachDef,
  ApproachSource,
  WorkflowPhase,
  AgentDef,
  WorktreePathDisplay,
  TicketingConfig,
  AgentProvider,
  ArtifactConventions,
} from './types.js';
import { ManifestError } from './error.js';
import { repoIdCollisions } from '../runtime/repoId.js';
import {
  isObject,
  requireString,
  requireStringArray,
  requireStringArrayAllowEmpty,
} from './validate/primitives.js';
import { validateRepository } from './validate/repository.js';
import { assertSharedRepoBaselineBranches } from './baselineBranch.js';
import { validateGraph } from './validate/graph.js';
import { validateUat } from './validate/uat.js';
import { validateReview } from './validate/review.js';
import { validateProcessAssignments } from './validate/processAssignments.js';
import { validateGraphConfig, assertNoHoistedGraphKeys } from './graphConfig.js';
import {
  validateArtifactTemplate,
  type ArtifactConventionName,
} from '../workflow/artifactConventions.js';
import { validateBranchTemplate } from '../runtime/branchName.js';
import { isTicketType, TICKET_TYPES } from '../store/ticketTypes.js';
import { validateLabelTemplate } from '../store/ticketLabelTemplate.js';

// Re-exported so the many existing `from './schema.js'` importers keep working.
export { ManifestError } from './error.js';
export { isRepoClassified, unclassifiedRepos } from './validate/graph.js';

/**
 * Parse an approach's `source` recipe: discriminated on `type`, either `git`
 * (repo/ref/non-empty include[]) or `npm` (package/command/collect[], may be empty).
 */
function validateApproachSource(raw: unknown, where: string): ApproachSource {
  if (!isObject(raw)) throw new ManifestError(`${where} must be an object`);
  if (raw.type === 'git') {
    return {
      type: 'git',
      repo: requireString(raw.repo, `${where}.repo`),
      ref: requireString(raw.ref, `${where}.ref`),
      include: requireStringArray(raw.include, where, 'include'),
    };
  }
  if (raw.type === 'npm') {
    return {
      type: 'npm',
      package: requireString(raw.package, `${where}.package`),
      command: requireString(raw.command, `${where}.command`),
      collect: requireStringArrayAllowEmpty(raw.collect, where, 'collect'),
    };
  }
  throw new ManifestError(`${where}.type must be "git" or "npm"`);
}

/** Parse one workflow phase: `name` is required, `command`/`description` optional. */
function validateWorkflowPhase(raw: unknown, where: string): WorkflowPhase {
  if (!isObject(raw)) throw new ManifestError(`${where} must be an object`);
  const phase: WorkflowPhase = { name: requireString(raw.name, `${where}.name`) };
  if (raw.command !== undefined) {
    phase.command = requireString(raw.command, `${where}.command`);
  }
  if (raw.description !== undefined) {
    phase.description = requireString(raw.description, `${where}.description`);
  }
  return phase;
}

/** Parse an approach's `workflow` phase list; undefined leaves the field unset. */
function validateWorkflow(raw: unknown, where: string): WorkflowPhase[] {
  if (!Array.isArray(raw)) {
    throw new ManifestError(`${where} must be an array`);
  }
  return raw.map((p, i) => validateWorkflowPhase(p, `${where}[${i}]`));
}

/**
 * Parse the top-level `approaches` list (default []): each needs a unique `id`
 * and `label`; at most one may be `recommended`. Optional `description`,
 * `entrypoint`, and `source` are parsed when present. A nested `graph:` block
 * is validated through `validateGraphConfig` (defaulted, closed vocabularies,
 * hard ceilings); a file carrying BOTH the nested block and a hoisted flat
 * shape is refused, never guessed.
 */
function validateApproaches(raw: unknown): ApproachDef[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    throw new ManifestError('approaches must be an array');
  }
  const seen = new Set<string>();
  let recommendedCount = 0;
  const approaches = raw.map((a, i) => {
    const where = `approaches[${i}]`;
    if (!isObject(a)) throw new ManifestError(`${where} must be an object`);
    const id = requireString(a.id, `${where}.id`);
    if (seen.has(id)) throw new ManifestError(`duplicate approach id "${id}"`);
    seen.add(id);
    const label = requireString(a.label, `${where}.label`);
    const approach: ApproachDef = { id, label };
    if (a.description !== undefined) {
      approach.description = requireString(a.description, `${where}.description`);
    }
    if (a.entrypoint !== undefined) {
      approach.entrypoint = requireString(a.entrypoint, `${where}.entrypoint`);
    }
    if (a.source !== undefined) {
      approach.source = validateApproachSource(a.source, `${where}.source`);
    }
    if (a.workflow !== undefined) {
      approach.workflow = validateWorkflow(a.workflow, `${where}.workflow`);
    }
    if (a.graph !== undefined) {
      assertNoHoistedGraphKeys(a, where);
      approach.graph = validateGraphConfig(a.graph, `${where}.graph`);
    }
    approach.enabled = a.enabled === false ? false : true;
    if (a.recommended === true) {
      recommendedCount += 1;
      approach.recommended = true;
    }
    return approach;
  });
  if (recommendedCount > 1) {
    throw new ManifestError('at most one approach may be recommended');
  }
  return approaches;
}

/** Parse the top-level role-keyed `agents` map (default {}); each needs a `role`. */
function validateAgents(raw: unknown): Record<string, AgentDef> {
  if (raw === undefined) return {};
  if (!isObject(raw)) throw new ManifestError('agents must be a mapping');
  const agents: Record<string, AgentDef> = {};
  for (const [key, a] of Object.entries(raw)) {
    const where = `agents "${key}"`;
    if (!isObject(a)) throw new ManifestError(`${where} must be an object`);
    const agent: AgentDef = { role: requireString(a.role, `${where}.role`) };
    if (a.command !== undefined) {
      agent.command = requireString(a.command, `${where}.command`);
    }
    if (a.promptPath !== undefined) {
      agent.promptPath = requireString(a.promptPath, `${where}.promptPath`);
    }
    agent.enabled = a.enabled === false ? false : true;
    agents[key] = agent;
  }
  return agents;
}

/**
 * Parse the top-level `ticketing` block (default `{ provider: 'manual' }`):
 * `provider` must be 'clickup' or 'manual'; `teamId`/`listId`/`shipStatus` are
 * parsed only when present. `advanceOnShip` always lands (default `false`).
 *
 * Two coherence guards, so a config that cannot do anything never reaches disk:
 * an advance with no status to set is a typo, and an advance on `manual` is
 * silently inert (the manual provider only records locally).
 */
function validateTicketing(raw: unknown): TicketingConfig {
  if (raw === undefined) {
    return { provider: 'manual', advanceOnShip: false, advanceOnStart: false, searchEnabled: true };
  }
  if (!isObject(raw)) throw new ManifestError('ticketing must be a mapping');
  if (raw.provider !== 'clickup' && raw.provider !== 'manual') {
    throw new ManifestError("ticketing.provider must be 'clickup' or 'manual'");
  }
  const config: TicketingConfig = {
    provider: raw.provider,
    advanceOnShip: false,
    advanceOnStart: false,
    searchEnabled: true,
  };
  if (raw.teamId !== undefined) {
    config.teamId = requireString(raw.teamId, 'ticketing.teamId');
  }
  if (raw.listId !== undefined) {
    config.listId = requireString(raw.listId, 'ticketing.listId');
  }
  if (raw.shipStatus !== undefined) {
    if (typeof raw.shipStatus !== 'string') {
      throw new ManifestError('ticketing.shipStatus must be a string');
    }
    const status = raw.shipStatus.trim();
    if (status) config.shipStatus = status;
  }
  if (raw.advanceOnShip !== undefined) {
    if (typeof raw.advanceOnShip !== 'boolean') {
      throw new ManifestError('ticketing.advanceOnShip must be a boolean');
    }
    config.advanceOnShip = raw.advanceOnShip;
  }
  if (config.advanceOnShip) {
    if (!config.shipStatus) {
      throw new ManifestError(
        'ticketing.shipStatus is required when ticketing.advanceOnShip is true',
      );
    }
    if (config.provider === 'manual') {
      throw new ManifestError(
        "ticketing.advanceOnShip requires a provider that can set status (not 'manual')",
      );
    }
  }
  // `startStatus` is deliberately NOT required when `advanceOnStart` is true —
  // `advanceTicketOnStart` (start.ts) falls back to a sensible default ('in
  // progress') so a missing/blank config still does something useful, unlike
  // ship's stricter coherence guard above.
  if (raw.startStatus !== undefined) {
    if (typeof raw.startStatus !== 'string') {
      throw new ManifestError('ticketing.startStatus must be a string');
    }
    const status = raw.startStatus.trim();
    if (status) config.startStatus = status;
  }
  if (raw.advanceOnStart !== undefined) {
    if (typeof raw.advanceOnStart !== 'boolean') {
      throw new ManifestError('ticketing.advanceOnStart must be a boolean');
    }
    config.advanceOnStart = raw.advanceOnStart;
  }
  if (config.advanceOnStart && config.provider === 'manual') {
    throw new ManifestError(
      "ticketing.advanceOnStart requires a provider that can set status (not 'manual')",
    );
  }
  if (raw.searchEnabled !== undefined) {
    if (typeof raw.searchEnabled !== 'boolean') {
      throw new ManifestError('ticketing.searchEnabled must be a boolean');
    }
    config.searchEnabled = raw.searchEnabled;
  }
  return config;
}

/** Parse `agentProvider` (default 'claude'). */
function validateAgentProvider(raw: unknown): AgentProvider {
  if (raw === undefined) return 'claude';
  if (
    raw !== 'claude' &&
    raw !== 'codex' &&
    raw !== 'antigravity' &&
    raw !== 'opencode'
  ) {
    throw new ManifestError('agentProvider must be "claude", "codex", "antigravity", or "opencode"');
  }
  return raw as AgentProvider;
}

/**
 * Parse `defaultModel`. Must be a string when present; a blank/whitespace value
 * normalizes to undefined (no default) so a cleared field can't pin a bad model.
 */
function validateDefaultModel(raw: unknown): string | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string') {
    throw new ManifestError('defaultModel must be a string');
  }
  return raw.trim() === '' ? undefined : raw;
}

/**
 * Parse `defaultEffort`. Must be a string when present; a blank/whitespace value
 * normalizes to undefined (no default) so a cleared field can't pin a bad
 * effort. Whether the effort is SUPPORTED by the selected model is judged
 * against the live catalog at Save (`assertProfileEffort`), never here.
 */
function validateDefaultEffort(raw: unknown): string | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string') {
    throw new ManifestError('defaultEffort must be a string');
  }
  return raw.trim() === '' ? undefined : raw;
}

/** Default delay before a done ticket is auto-archived (§ auto-archiving). */
export const DEFAULT_ARCHIVE_DONE_AFTER_DAYS = 3;

/**
 * Parse `archiveDoneAfterDays` — how many days a ticket stays visible at
 * `done` before the auto-archive sweep moves it to the Archived facet.
 * Defaults to 3 (the delay exists so a freshly-done ticket is never archived
 * immediately). Must be a positive whole number: 0 is the exact failure the
 * delay exists to prevent, and a fraction has no meaning against a day clock.
 */
function validateArchiveDoneAfterDays(raw: unknown): number {
  if (raw === undefined) return DEFAULT_ARCHIVE_DONE_AFTER_DAYS;
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1) {
    throw new ManifestError('archiveDoneAfterDays must be a positive whole number of days');
  }
  return raw;
}

/**
 * Parse `debug` (default undefined → debug logging off). Must be a boolean
 * when present — a string `"true"` is a YAML typo, and a non-boolean must
 * fail loudly rather than silently pinning verbose logging on.
 */
function validateDebug(raw: unknown): boolean | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'boolean') {
    throw new ManifestError('debug must be a boolean');
  }
  return raw;
}

/**
 * Parse `closeDoneTerminalsWithTicket` (default undefined → closing a ticket
 * leaves its done terminals alone). Must be a boolean when present, like
 * `debug` — a string `"true"` is a YAML typo, and a non-boolean must fail
 * loudly rather than silently pinning the behavior on.
 */
function validateCloseDoneTerminalsWithTicket(raw: unknown): boolean | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'boolean') {
    throw new ManifestError('closeDoneTerminalsWithTicket must be a boolean');
  }
  return raw;
}

/**
 * Parse the project `id`. Must be a string when present; blank/whitespace
 * normalizes to undefined so a cleared field falls back to the path-derived
 * slug rather than pinning every ticket to an empty project. Trimmed, because
 * the slug is an equality key — stray whitespace would fork one project in two.
 */
function validateProjectId(raw: unknown): string | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string') {
    throw new ManifestError('id must be a string');
  }
  const trimmed = raw.trim();
  return trimmed === '' ? undefined : trimmed;
}

/** Parse `worktreePathDisplay` (default 'relative'); only two legal values. */
function validateWorktreePathDisplay(raw: unknown): WorktreePathDisplay {
  if (raw === undefined) return 'relative';
  if (raw !== 'absolute' && raw !== 'relative') {
    throw new ManifestError("worktreePathDisplay must be 'absolute' or 'relative'");
  }
  return raw;
}

/**
 * Parse `ticketLabelTemplate`. Must be a string when present; a blank/whitespace
 * value normalizes to undefined (falls back to the default) so a cleared field
 * can't erase every ticket label.
 */
function validateTicketLabelTemplate(raw: unknown): string | undefined {
  return parseLabelTemplateField('ticketLabelTemplate', raw);
}

/** Parse `terminalNameTemplate` — string or throw; blank → undefined (default). */
function validateTerminalNameTemplate(raw: unknown): string | undefined {
  return parseLabelTemplateField('terminalNameTemplate', raw);
}

/**
 * Shared parse for the two label-style template fields. Unknown VARIABLES stay
 * legal (the renderer degrades them to empty), but placeholder transforms are
 * checked HERE — a typo must surface where the template was entered, not as a
 * label that quietly reverts to the default.
 */
function parseLabelTemplateField(
  field: 'ticketLabelTemplate' | 'terminalNameTemplate',
  raw: unknown,
): string | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string') {
    throw new ManifestError(`${field} must be a string`);
  }
  if (raw.trim() === '') return undefined;
  try {
    validateLabelTemplate(field, raw);
  } catch (error) {
    throw new ManifestError(error instanceof Error ? error.message : String(error));
  }
  return raw;
}

/** Parse and strictly validate independently optional artifact conventions. */
function validateArtifactConventions(raw: unknown): ArtifactConventions | undefined {
  if (raw === undefined) return undefined;
  if (!isObject(raw)) throw new ManifestError('conventions must be a mapping');

  const fields: ArtifactConventionName[] = [
    'commitMessage',
    'pullRequestTitle',
    'pullRequestDescription',
  ];
  const conventions: ArtifactConventions = {};
  for (const field of fields) {
    const value = raw[field];
    if (value === undefined) continue;
    const path = `conventions.${field}`;
    if (typeof value !== 'string') {
      throw new ManifestError(`${path} must be a string`);
    }
    try {
      validateArtifactTemplate(field, value);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new ManifestError(`${path}${detail.slice(field.length)}`);
    }
    conventions[field] = value;
  }

  // The branch template has its own vocabulary and its own extra rule (it must
  // vary per ticket), so it validates through `validateBranchTemplate` rather
  // than the artifact validator — same dotted-path error prefix either way.
  const branchName = raw.branchName;
  if (branchName !== undefined) {
    if (typeof branchName !== 'string') {
      throw new ManifestError('conventions.branchName must be a string');
    }
    try {
      validateBranchTemplate(branchName);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new ManifestError(`conventions.${detail}`);
    }
    conventions.branchName = branchName;
  }

  const defaultType = raw.defaultType;
  if (defaultType !== undefined) {
    if (typeof defaultType !== 'string') {
      throw new ManifestError('conventions.defaultType must be a string');
    }
    if (!isTicketType(defaultType)) {
      throw new ManifestError(
        `conventions.defaultType must be one of: ${TICKET_TYPES.join(', ')}`,
      );
    }
    conventions.defaultType = defaultType;
  }

  return conventions;
}

/** Validate a parsed YAML value into a typed Manifest, or throw ManifestError. */
/**
 * Repository names must stay distinct once canonicalized. A graph document
 * claims repositories by canonical (case-folded) id, so `BE` and `be` would be
 * one ambiguous target downstream — rejected HERE, at the manifest, where the
 * author can rename the key, rather than three layers away at graph compile.
 */
function assertDistinctRepoIds(repositories: Record<string, RepositoryDef>): void {
  const collision = repoIdCollisions(Object.keys(repositories))[0];
  if (collision) {
    throw new ManifestError(
      `repositories "${collision[0]}" and "${collision[1]}" differ only by case; ` +
        'repository names must be distinct case-insensitively — rename one of the two ' +
        'keys in karst.yml (and update every reference to it) so the names differ by ' +
        'more than case',
    );
  }
}

export function validateManifest(raw: unknown): Manifest {
  if (!isObject(raw)) throw new ManifestError('top level must be a mapping');

  const host = requireString(raw.host, 'host');
  const baselineBranch = requireString(raw.baselineBranch, 'baselineBranch');

  const range = raw.portRange;
  if (
    !Array.isArray(range) ||
    range.length !== 2 ||
    typeof range[0] !== 'number' ||
    typeof range[1] !== 'number'
  ) {
    throw new ManifestError('portRange must be a [min, max] number pair');
  }
  if (range[0] > range[1]) {
    throw new ManifestError(`portRange min (${range[0]}) exceeds max (${range[1]})`);
  }

  // Callers reach here through `loadManifest`, which runs `migrateLegacyManifest`
  // first — so a legacy `services:` tree has already become `repositories:` and a
  // file carrying both keys has already been rejected.
  const reposRaw = raw.repositories;
  if (!isObject(reposRaw) || Object.keys(reposRaw).length === 0) {
    throw new ManifestError('repositories must be a non-empty mapping');
  }

  const repositories: Record<string, RepositoryDef> = {};
  for (const [name, repoRaw] of Object.entries(reposRaw)) {
    repositories[name] = validateRepository(repoRaw, name);
  }

  assertDistinctRepoIds(repositories);
  validateGraph(repositories);
  assertSharedRepoBaselineBranches(repositories, baselineBranch);

  const agents = validateAgents(raw.agents);
  const processes = validateProcessAssignments(raw.processes);

  return {
    id: validateProjectId(raw.id),
    host,
    portRange: [range[0], range[1]],
    baselineBranch,
    repositories,
    approaches: validateApproaches(raw.approaches),
    agents,
    processes,
    worktreePathDisplay: validateWorktreePathDisplay(raw.worktreePathDisplay),
    ticketLabelTemplate: validateTicketLabelTemplate(raw.ticketLabelTemplate),
    terminalNameTemplate: validateTerminalNameTemplate(raw.terminalNameTemplate),
    conventions: validateArtifactConventions(raw.conventions),
    ticketing: validateTicketing(raw.ticketing),
    agentProvider: validateAgentProvider(raw.agentProvider),
    defaultModel: validateDefaultModel(raw.defaultModel),
    defaultEffort: validateDefaultEffort(raw.defaultEffort),
    archiveDoneAfterDays: validateArchiveDoneAfterDays(raw.archiveDoneAfterDays),
    debug: validateDebug(raw.debug),
    closeDoneTerminalsWithTicket: validateCloseDoneTerminalsWithTicket(
      raw.closeDoneTerminalsWithTicket,
    ),
    uat: validateUat(raw.uat),
    review: validateReview(raw.review, Object.keys(repositories)),
  };
}
