/**
 * T1258: a settings or ticket change during a graph run never applies silently.
 * Each live run keeps the identity snapshot it started with
 * (`approach_graph_runs.agent_identity`, @arch:GRAPHRUN). After a change this
 * module finds the runs whose snapshot differs from the new settings and asks
 * the user: Keep (no change) or Switch (replace the snapshot in one
 * transaction). A switch never stops a running session; the next planner or
 * node launch reads the new snapshot. A run with no snapshot resolves live, so
 * it is never asked.
 *
 * Host-agnostic: the db, the transaction, the manifest, the prompt and the log
 * are injected.
 */

import type { GraphApproachConfig, Manifest } from '../../manifest/types.js';
import type { GraphDb } from '../../store/graph/transitions.js';
import {
  graphRunAgentIdentity,
  graphRunById,
  graphRunsInStatuses,
  setGraphRunAgentIdentity,
} from '../../store/graph/graphRuns.js';
import { NON_TERMINAL_GRAPH_RUN_STATUSES } from './coordinator/reconcileScope.js';
import {
  identitiesDiffer,
  identityDifference,
  parseRunIdentities,
  resolveRunIdentities,
  serializeRunIdentities,
  summarizeRunIdentities,
} from './runIdentity.js';

/** No launch follows `completed-awaiting-impl-marker`, so a question there is noise. */
const NO_LAUNCH_STATUS = 'completed-awaiting-impl-marker';

/** The statuses in which a later launch can still happen. */
export const MODEL_CHANGE_STATUSES: readonly string[] = NON_TERMINAL_GRAPH_RUN_STATUSES.filter(
  (s) => s !== NO_LAUNCH_STATUS,
);

export interface ModelChangeScanDeps {
  readonly db: GraphDb;
  readonly manifest: Manifest;
  readonly graphConfigOf: (approachId: string) => GraphApproachConfig | undefined;
}

export interface ModelChangeSwitchDeps extends ModelChangeScanDeps {
  readonly transaction: <T>(fn: () => T) => T;
  readonly now: () => string;
  readonly debug: (message: string) => void;
}

export interface ModelChange {
  readonly graphRunId: number;
  readonly ticketId: number;
  readonly approachId: string;
  readonly status: string;
  readonly summary: { readonly from: string; readonly to: string; readonly difference: string };
}

/** The non-terminal runs whose snapshot differs from the identity the current settings give. */
export function findModelChanges(
  deps: ModelChangeScanDeps,
  filter: { ticketId?: number } = {},
): ModelChange[] {
  const changes: ModelChange[] = [];
  for (const run of graphRunsInStatuses(deps.db, MODEL_CHANGE_STATUSES, filter.ticketId)) {
    const from = parseRunIdentities(run.agent_identity);
    const config = deps.graphConfigOf(run.approach_id);
    if (!from || !config) continue;
    const to = resolveRunIdentities(deps.manifest, config);
    if (!identitiesDiffer(from, to)) continue;
    changes.push({
      graphRunId: run.id,
      ticketId: run.ticket_id,
      approachId: run.approach_id,
      status: run.status,
      summary: {
        from: summarizeRunIdentities(from),
        to: summarizeRunIdentities(to),
        difference: identityDifference(from, to),
      },
    });
  }
  return changes;
}

export type SwitchModelsOutcome = 'switched' | 'unchanged' | 'terminal' | 'not-found';

/**
 * Replace the run's snapshot with the identity the current settings give, in
 * one transaction. A run with no snapshot gets one. No session stops.
 */
export function switchGraphRunModels(deps: ModelChangeSwitchDeps, graphRunId: number): SwitchModelsOutcome {
  return deps.transaction(() => {
    const run = graphRunById(deps.db, graphRunId);
    if (!run) return 'not-found';
    if (!MODEL_CHANGE_STATUSES.includes(run.status)) return 'terminal';
    const config = deps.graphConfigOf(run.approach_id);
    if (!config) return 'not-found';
    const before = parseRunIdentities(graphRunAgentIdentity(deps.db, graphRunId));
    const next = resolveRunIdentities(deps.manifest, config);
    if (before && !identitiesDiffer(before, next)) return 'unchanged';
    setGraphRunAgentIdentity(deps.db, graphRunId, serializeRunIdentities(next), deps.now());
    deps.debug(
      `[process] graph run ${graphRunId} models switched: ${before ? identityDifference(before, next) : summarizeRunIdentities(next)}`,
    );
    return 'switched';
  });
}

export interface ModelChangeMessage {
  readonly message: string;
  readonly actions: { readonly switch: string; readonly keep: string };
}

/** One question: the single-run wording, or one list for several runs. */
export function modelChangeMessage(
  label: (ticketId: number) => string,
  changes: readonly Pick<ModelChange, 'graphRunId' | 'ticketId' | 'summary'>[],
): ModelChangeMessage {
  const lines = changes.map(
    (c) =>
      `Ticket ${label(c.ticketId)}: graph run ${c.graphRunId} uses ${c.summary.from}. The new settings give ${c.summary.to}.`,
  );
  if (lines.length === 1) {
    return { message: lines[0]!, actions: { switch: 'Switch to new models', keep: 'Keep current models' } };
  }
  return { message: lines.join(' '), actions: { switch: 'Switch all', keep: 'Keep all' } };
}

export interface AskModelChangeDeps extends ModelChangeSwitchDeps {
  readonly label: (ticketId: number) => string;
  readonly warn: (message: string, ...actions: string[]) => PromiseLike<string | undefined>;
  readonly refresh: (ticketId: number) => void;
}

/**
 * Ask once for every run the change affects. Only the explicit Switch action
 * changes a snapshot; Keep and a dismissed warning leave every run as it is.
 * Returns how many runs the question covered (0 = no question was shown).
 */
export async function askModelChange(
  deps: AskModelChangeDeps,
  filter: { ticketId?: number } = {},
): Promise<number> {
  const changes = findModelChanges(deps, filter);
  if (changes.length === 0) return 0;
  const { message, actions } = modelChangeMessage(deps.label, changes);
  const answer = await deps.warn(message, actions.switch, actions.keep);
  if (answer !== actions.switch) return changes.length;
  for (const change of changes) {
    if (switchGraphRunModels(deps, change.graphRunId) === 'switched') deps.refresh(change.ticketId);
  }
  return changes.length;
}

/** The manifest fields that decide a graph run's identity: the presets and each approach's graph profiles. */
function identityInputs(m: Manifest): string {
  return JSON.stringify({
    active: m.activeAgentPreset ?? m.defaultAgentPreset ?? null,
    presets: m.agentPresets ?? null,
    profiles: (m.approaches ?? []).map((a) => [a.id, a.graph?.profiles ?? null]),
  });
}

/** True when a Settings Save changed what a graph role resolves to. */
export function agentSettingsChanged(prev: Manifest, next: Manifest): boolean {
  return identityInputs(prev) !== identityInputs(next);
}

/**
 * The difference between a live run's snapshot and the identity the current
 * settings give (`worker: claude/a → codex/b`), or undefined when they are
 * equal, the run has no snapshot, is terminal, or is unknown.
 */
export function runModelDifference(deps: ModelChangeScanDeps, graphRunId: number): string | undefined {
  const run = graphRunById(deps.db, graphRunId);
  if (!run || !MODEL_CHANGE_STATUSES.includes(run.status)) return undefined;
  const from = parseRunIdentities(run.agent_identity);
  const config = deps.graphConfigOf(run.approach_id);
  if (!from || !config) return undefined;
  const to = resolveRunIdentities(deps.manifest, config);
  return identitiesDiffer(from, to) ? identityDifference(from, to) : undefined;
}
