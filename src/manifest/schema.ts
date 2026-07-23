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
} from './types.js';
import { ManifestError } from './error.js';
import {
  isObject,
  requireString,
  requireStringArray,
  requireStringArrayAllowEmpty,
} from './validate/primitives.js';
import { validateRepository } from './validate/repository.js';
import { validateGraph } from './validate/graph.js';

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
 * `entrypoint`, and `source` are parsed when present.
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
    return { provider: 'manual', advanceOnShip: false, advanceOnStart: false };
  }
  if (!isObject(raw)) throw new ManifestError('ticketing must be a mapping');
  if (raw.provider !== 'clickup' && raw.provider !== 'manual') {
    throw new ManifestError("ticketing.provider must be 'clickup' or 'manual'");
  }
  const config: TicketingConfig = {
    provider: raw.provider,
    advanceOnShip: false,
    advanceOnStart: false,
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
  return config;
}

/** Parse `agentProvider` (default 'claude'); only two legal values. */
function validateAgentProvider(raw: unknown): AgentProvider {
  if (raw === undefined) return 'claude';
  if (raw !== 'claude' && raw !== 'codex') {
    throw new ManifestError('agentProvider must be "claude" or "codex"');
  }
  return raw;
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
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string') {
    throw new ManifestError('ticketLabelTemplate must be a string');
  }
  return raw.trim() === '' ? undefined : raw;
}

/** Parse `terminalNameTemplate` — string or throw; blank → undefined (default). */
function validateTerminalNameTemplate(raw: unknown): string | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string') {
    throw new ManifestError('terminalNameTemplate must be a string');
  }
  return raw.trim() === '' ? undefined : raw;
}

/** Validate a parsed YAML value into a typed Manifest, or throw ManifestError. */
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

  validateGraph(repositories);

  return {
    id: validateProjectId(raw.id),
    host,
    portRange: [range[0], range[1]],
    baselineBranch,
    repositories,
    approaches: validateApproaches(raw.approaches),
    agents: validateAgents(raw.agents),
    worktreePathDisplay: validateWorktreePathDisplay(raw.worktreePathDisplay),
    ticketLabelTemplate: validateTicketLabelTemplate(raw.ticketLabelTemplate),
    terminalNameTemplate: validateTerminalNameTemplate(raw.terminalNameTemplate),
    ticketing: validateTicketing(raw.ticketing),
    agentProvider: validateAgentProvider(raw.agentProvider),
    defaultModel: validateDefaultModel(raw.defaultModel),
  };
}
