import type { Store } from '../../store/db.js';
import {
  createTicket,
  findTicketById,
  getTicket,
  getTicketByKey,
  updateTicketFields,
  type ProjectScope,
  type TicketWithStages,
} from '../../store/tickets.js';
import { getEnvOverrides, setServiceEnvOverrides } from '../../store/ticketEnvOverrides.js';

/**
 * Nesting cap (design NDL-70 §3, D7). "Depth" is the number of `-s<n>` segments
 * in the key, so a root ticket is depth 0 and `PROJ-1-s2-s1-s1` is depth 3. The
 * cap bounds branch and path length and keeps the UI tree readable.
 */
export const MAX_SUBTASK_DEPTH = 4;

/** The new ask a sub-task carries; everything else is inherited from the parent. */
export interface SubtaskFields {
  title: string;
  /** The sub-task's actual ask. The one field NOT copied from the parent. */
  description?: string;
  /** Whether the sub-task blocks the parent from leaving `impl`/`fix`. */
  blocking?: boolean;
  /**
   * Optional subset of the parent's `selected_repos` to scope the sub-task to.
   * Defaults to all of the parent's repos.
   */
  repos?: string[];
  /**
   * Queue the sub-task to auto-start implementation (default true). `false`
   * (CLI `--no-start`) leaves it at `scope` for a manual Start.
   */
  start?: boolean;
}

/** No ticket with `parentId` exists (readers must tolerate a missing row). */
export class SubtaskParentMissingError extends Error {
  constructor(parentId: number) {
    super(`cannot create a sub-task: ticket #${parentId} does not exist`);
    this.name = 'SubtaskParentMissingError';
  }
}

/** A sub-task of an archived parent would resurrect abandoned work. */
export class SubtaskParentArchivedError extends Error {
  constructor(parentId: number) {
    super(`cannot create a sub-task: parent ticket #${parentId} is archived`);
    this.name = 'SubtaskParentArchivedError';
  }
}

/**
 * A parent at `ship` or `done` cannot take sub-tasks (design §3). A done parent
 * is served by follow-ups; a shipping parent's branch is being merged, so
 * nothing new may stack onto it.
 */
export class SubtaskParentStageError extends Error {
  constructor(parentId: number, stageCurrent: string) {
    super(`cannot create a sub-task: parent ticket #${parentId} is at '${stageCurrent}'`);
    this.name = 'SubtaskParentStageError';
  }
}

/** The parent belongs to a different project than the caller's scope. */
export class SubtaskProjectMismatchError extends Error {
  constructor(parentId: number, parentProjectId: number | null, scopeProjectId: number) {
    super(
      `cannot create a sub-task: parent ticket #${parentId} is in project ${parentProjectId ?? 'none'}, not ${scopeProjectId}`,
    );
    this.name = 'SubtaskProjectMismatchError';
  }
}

/** The new sub-task would be deeper than `MAX_SUBTASK_DEPTH`. */
export class SubtaskDepthExceededError extends Error {
  constructor(parentId: number, depth: number) {
    super(
      `cannot create a sub-task: ticket #${parentId} is already at depth ${depth - 1} (max ${MAX_SUBTASK_DEPTH})`,
    );
    this.name = 'SubtaskDepthExceededError';
  }
}

/** A corrupt `subtask_parent_id` chain visited the same ticket twice. */
export class SubtaskCycleError extends Error {
  constructor(ticketId: number) {
    super(`cannot create a sub-task: sub-task parent chain from ticket #${ticketId} contains a cycle`);
    this.name = 'SubtaskCycleError';
  }
}

/** A requested repo is not one of the parent's repos — there is no branch to stack on. */
export class SubtaskRepoNotInParentError extends Error {
  readonly repos: string[];
  constructor(parentKey: string, repos: string[]) {
    super(`cannot create a sub-task: repo(s) ${repos.join(', ')} are not in parent ${parentKey}`);
    this.name = 'SubtaskRepoNotInParentError';
    this.repos = repos;
  }
}

/**
 * Number of sub-task ancestors of `ticketId` (0 for a top-level ticket). This
 * single walk serves both the depth cap and the cycle guard: `subtask_parent_id`
 * is set once at creation and v1 has no re-parenting, so a cycle is impossible
 * by construction — but a corrupt row must not hang the writer.
 */
function subtaskAncestorCount(store: Store, ticketId: number): number {
  const seen = new Set<number>();
  let cursor: number | null = ticketId;
  let count = 0;
  while (cursor !== null) {
    if (seen.has(cursor)) throw new SubtaskCycleError(ticketId);
    seen.add(cursor);
    const row = store.db
      .prepare('SELECT subtask_parent_id FROM tickets WHERE id = ?')
      .get(cursor) as { subtask_parent_id: number | null } | undefined;
    if (!row) break;
    cursor = row.subtask_parent_id ?? null;
    if (cursor !== null) count += 1;
  }
  return count;
}

/** Next unclaimed `<parentKey>-s<n>` suffix, scoped like every other key lookup. */
function nextSubtaskKey(store: Store, parentKey: string, scope: ProjectScope): string {
  for (let n = 1; n <= 999; n++) {
    const candidate = `${parentKey}-s${n}`;
    if (!getTicketByKey(store, candidate, scope)) return candidate;
  }
  throw new Error(`could not generate a unique sub-task key for ${parentKey}`);
}

/**
 * Create a sub-task ticket under an OPEN parent (design NDL-70 §3), the sibling
 * writer of `createFollowUpTicket`. Enforced here:
 *
 * - the parent exists, is not archived, and is in the caller's project;
 * - the parent is not at `ship`/`done` (a done parent takes follow-ups);
 * - nesting is at most `MAX_SUBTASK_DEPTH` (walked, which is also the cycle guard);
 * - the sub-task's repos are a subset of the parent's;
 * - `approach`/`agent`/`model`/`effort`/`agent_provider`/`agent_preset`/`type`/
 *   `env_overrides`/`selected_repos` are copied from the parent. `description`
 *   is the new ask. `base_refs` is deliberately NOT copied — the base is
 *   derived from the parent's branch (slice 2), never inherited as an override.
 *
 * The key is `<parentKey>-s<n>` with `n` per parent.
 */
export function createSubtask(
  store: Store,
  parentId: number,
  fields: SubtaskFields,
  scope: ProjectScope = {},
  debug?: (message: string) => void,
): TicketWithStages {
  const parent = findTicketById(store, parentId);
  if (!parent) {
    debug?.(`[driver] sub-task under #${parentId}: parent not found — refusing`);
    throw new SubtaskParentMissingError(parentId);
  }
  const parentKey = parent.key ?? `#${parent.id}`;
  debug?.(
    `[driver] sub-task under #${parentId}: parent stage is '${parent.stageCurrent ?? 'none'}'`,
  );
  if (parent.archivedAt !== null) {
    debug?.(`[driver] sub-task under #${parentId}: parent archived — refusing`);
    throw new SubtaskParentArchivedError(parentId);
  }
  if (scope.projectId !== undefined && parent.projectId !== scope.projectId) {
    debug?.(`[driver] sub-task under #${parentId}: project mismatch — refusing`);
    throw new SubtaskProjectMismatchError(parentId, parent.projectId, scope.projectId);
  }
  if (parent.stageCurrent === 'ship' || parent.stageCurrent === 'done') {
    debug?.(`[driver] sub-task under #${parentId}: parent in '${parent.stageCurrent}' — refusing`);
    throw new SubtaskParentStageError(parentId, parent.stageCurrent);
  }

  const depth = subtaskAncestorCount(store, parent.id) + 1;
  if (depth > MAX_SUBTASK_DEPTH) {
    debug?.(
      `[driver] sub-task under #${parentId}: depth ${depth} exceeds ${MAX_SUBTASK_DEPTH} — refusing`,
    );
    throw new SubtaskDepthExceededError(parentId, depth);
  }

  const repos = fields.repos ?? parent.selectedRepos;
  const parentRepos = new Set(parent.selectedRepos);
  const outside = repos.filter((repo) => !parentRepos.has(repo));
  if (outside.length > 0) {
    debug?.(
      `[driver] sub-task under #${parentId}: repos not in parent (${outside.join(', ')}) — refusing`,
    );
    throw new SubtaskRepoNotInParentError(parentKey, outside);
  }

  const key = nextSubtaskKey(store, parentKey, scope);
  debug?.(`[driver] sub-task under #${parentId}: creating child '${key}'`);
  const child = createTicket(store, {
    key,
    title: fields.title,
    description: fields.description,
    source: 'karst',
    projectId: parent.projectId ?? scope.projectId,
    subtaskParentId: parent.id,
    blocksParent: fields.blocking ?? false,
    autostartPending: fields.start ?? true,
  });

  updateTicketFields(store, child.id, {
    approach: parent.approach ?? undefined,
    agent: parent.agent ?? undefined,
    selectedRepos: repos,
    model: parent.model ?? undefined,
    effort: parent.effort ?? undefined,
    agentProvider: parent.agentProvider ?? undefined,
    agentPreset: parent.agentPreset ?? undefined,
    type: parent.type ?? undefined,
  });

  // env_overrides has its own per-scope writer, so copy each scope through it
  // rather than reaching into the column directly (single-writer discipline).
  const overrides = getEnvOverrides(store, parent.id);
  for (const [envScope, entries] of Object.entries(overrides)) {
    setServiceEnvOverrides(store, child.id, envScope, entries);
  }

  debug?.(`[driver] sub-task under #${parentId}: child #${child.id} ('${key}') created`);
  return getTicket(store, child.id);
}
