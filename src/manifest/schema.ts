import type {
  Manifest,
  ServiceDef,
  PortSlot,
  DependsOn,
  BindVar,
  ApproachDef,
  ApproachSource,
  WorkflowPhase,
  AgentDef,
  WorktreePathDisplay,
  TicketingConfig,
  AgentProvider,
} from './types.js';

/** Thrown for any manifest that fails validation. Message names the exact fault. */
export class ManifestError extends Error {
  constructor(message: string) {
    super(`Invalid karst.yml: ${message}`);
    this.name = 'ManifestError';
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function requireString(v: unknown, where: string): string {
  if (typeof v !== 'string' || v.length === 0) {
    throw new ManifestError(`${where} must be a non-empty string`);
  }
  return v;
}

function requireNumber(v: unknown, where: string): number {
  if (typeof v !== 'number' || Number.isNaN(v)) {
    throw new ManifestError(`${where} must be a number`);
  }
  return v;
}

function validatePortSlot(raw: unknown, svc: string, i: number): PortSlot {
  const where = `service "${svc}" ports[${i}]`;
  if (!isObject(raw)) throw new ManifestError(`${where} must be an object`);
  return {
    name: requireString(raw.name, `${where}.name`),
    env: requireString(raw.env, `${where}.env`),
    default: requireNumber(raw.default, `${where}.default`),
  };
}

function validateBind(raw: unknown, svc: string, edge: number, i: number): BindVar {
  const where = `service "${svc}" dependsOn[${edge}].bind[${i}]`;
  if (!isObject(raw)) throw new ManifestError(`${where} must be an object`);
  return {
    env: requireString(raw.env, `${where}.env`),
    template: requireString(raw.template, `${where}.template`),
  };
}

function validateDependsOn(raw: unknown, svc: string, i: number): DependsOn {
  const where = `service "${svc}" dependsOn[${i}]`;
  if (!isObject(raw)) throw new ManifestError(`${where} must be an object`);
  const bindRaw = raw.bind;
  if (!Array.isArray(bindRaw) || bindRaw.length === 0) {
    throw new ManifestError(`${where}.bind must be a non-empty array`);
  }
  return {
    target: requireString(raw.target, `${where}.target`),
    port: requireString(raw.port, `${where}.port`),
    bind: bindRaw.map((b, bi) => validateBind(b, svc, i, bi)),
  };
}

/** Parse a service's `signals` field: an array of non-empty strings, default []. */
function validateSignals(raw: unknown, svc: string): string[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    throw new ManifestError(`service "${svc}" signals must be an array of strings`);
  }
  return raw.map((s, i) => requireString(s, `service "${svc}" signals[${i}]`));
}

function validateService(raw: unknown, name: string): ServiceDef {
  const where = `service "${name}"`;
  if (!isObject(raw)) throw new ManifestError(`${where} must be an object`);

  const portsRaw = raw.ports;
  if (!Array.isArray(portsRaw) || portsRaw.length === 0) {
    throw new ManifestError(`${where}.ports must be a non-empty array`);
  }
  const dependsOnRaw = raw.dependsOn ?? [];
  if (!Array.isArray(dependsOnRaw)) {
    throw new ManifestError(`${where}.dependsOn must be an array`);
  }

  return {
    repoPath: requireString(raw.repoPath, `${where}.repoPath`),
    start: requireString(raw.start, `${where}.start`),
    health: raw.health === undefined ? undefined : requireString(raw.health, `${where}.health`),
    ports: portsRaw.map((p, i) => validatePortSlot(p, name, i)),
    dependsOn: dependsOnRaw.map((d, i) => validateDependsOn(d, name, i)),
    hasMigrations: raw.hasMigrations === true, // default false
    signals: validateSignals(raw.signals, name),
  };
}

/** Parse a required non-empty array of non-empty strings at `${where}.${field}`. */
function requireStringArray(raw: unknown, where: string, field: string): string[] {
  const full = `${where}.${field}`;
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new ManifestError(`${full} must be a non-empty array of strings`);
  }
  return raw.map((s, i) => requireString(s, `${full}[${i}]`));
}

/** Parse an array of strings at `${where}.${field}`, allowing an empty array. */
function requireStringArrayAllowEmpty(raw: unknown, where: string, field: string): string[] {
  const full = `${where}.${field}`;
  if (!Array.isArray(raw)) {
    throw new ManifestError(`${full} must be an array of strings`);
  }
  return raw.map((s, i) => requireString(s, `${full}[${i}]`));
}

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
 * `provider` must be 'clickup' or 'manual'; `teamId`/`listId` are parsed only
 * when present (non-empty strings). Mirrors `validateWorktreePathDisplay` +
 * the optional-field handling in `validateService`.
 */
function validateTicketing(raw: unknown): TicketingConfig {
  if (raw === undefined) return { provider: 'manual' };
  if (!isObject(raw)) throw new ManifestError('ticketing must be a mapping');
  if (raw.provider !== 'clickup' && raw.provider !== 'manual') {
    throw new ManifestError("ticketing.provider must be 'clickup' or 'manual'");
  }
  const config: TicketingConfig = { provider: raw.provider };
  if (raw.teamId !== undefined) {
    config.teamId = requireString(raw.teamId, 'ticketing.teamId');
  }
  if (raw.listId !== undefined) {
    config.listId = requireString(raw.listId, 'ticketing.listId');
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

/**
 * Cross-service checks that need the whole graph: every dependsOn target must
 * exist, and the referenced port slot must exist on that target. Catches the
 * silent-misconfig class before it reaches the resolver.
 */
function validateGraph(services: Record<string, ServiceDef>): void {
  for (const [name, svc] of Object.entries(services)) {
    for (const dep of svc.dependsOn) {
      const target = services[dep.target];
      if (!target) {
        throw new ManifestError(
          `service "${name}" dependsOn unknown target "${dep.target}"`,
        );
      }
      const hasSlot = target.ports.some((p) => p.name === dep.port);
      if (!hasSlot) {
        throw new ManifestError(
          `service "${name}" dependsOn "${dep.target}" port "${dep.port}", ` +
            `but "${dep.target}" has no such port slot`,
        );
      }
    }
  }
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

  const servicesRaw = raw.services;
  if (!isObject(servicesRaw) || Object.keys(servicesRaw).length === 0) {
    throw new ManifestError('services must be a non-empty mapping');
  }

  const services: Record<string, ServiceDef> = {};
  for (const [name, svcRaw] of Object.entries(servicesRaw)) {
    services[name] = validateService(svcRaw, name);
  }

  validateGraph(services);

  return {
    host,
    portRange: [range[0], range[1]],
    baselineBranch,
    services,
    approaches: validateApproaches(raw.approaches),
    agents: validateAgents(raw.agents),
    worktreePathDisplay: validateWorktreePathDisplay(raw.worktreePathDisplay),
    ticketLabelTemplate: validateTicketLabelTemplate(raw.ticketLabelTemplate),
    ticketing: validateTicketing(raw.ticketing),
    agentProvider: validateAgentProvider(raw.agentProvider),
    defaultModel: validateDefaultModel(raw.defaultModel),
  };
}

/**
 * A service is "classified" once it declares at least one signal word. The
 * onboarding classify-gate uses this to decide whether to prompt for signals
 * before ticket onboarding proceeds.
 */
export function isServiceClassified(svc: ServiceDef): boolean {
  return (svc.signals ?? []).length > 0;
}
