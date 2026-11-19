/**
 * The vscode-facing binding for the graph-owned launch notice (T1138). It
 * takes every host seam as a dependency, so `extension.ts` only passes them.
 */

import type { GraphDb } from '../store/graph/transitions.js';
import type { ProcessFactsSource } from '../runtime/serverIdentity.js';
import type { KillOutcome } from '../runtime/processTree.js';
import type { SwitchModelsOutcome } from '../approaches/graph/modelChange.js';
import { cancelGraphRun } from '../approaches/graph/cancel.js';
import {
  graphOwnedChangeMessage,
  graphRunLiveness,
  showGraphOwnedNotice,
  type GraphOwnedRun,
} from '../approaches/graph/graphOwnedNotice.js';

export interface GraphOwnedBindingDeps {
  readonly db: () => GraphDb | undefined;
  readonly transaction: <T>(fn: () => T) => T;
  readonly facts: ProcessFactsSource;
  readonly killTree: (pid: number) => KillOutcome;
  readonly activeRun: (db: GraphDb, ticketId: number) => GraphOwnedRun | undefined;
  readonly label: (ticketId: number) => string;
  readonly warn: (message: string, ...actions: string[]) => PromiseLike<string | undefined>;
  readonly confirm: (message: string, accept: string) => PromiseLike<boolean>;
  readonly inform: (message: string) => void;
  readonly refresh: (ticketId: number) => void;
  readonly logError: (message: string, error: unknown) => void;
  readonly debug: (message: string) => void;
  /** T1258: the model-change question and the switch, bound to the live manifest in `extension.ts`. */
  readonly modelChange?: {
    /** Asks for the matching live runs; resolves with how many the question covered (0 = none shown). */
    readonly ask: (filter: { ticketId?: number }) => Promise<number>;
    readonly switchRun: (graphRunId: number) => SwitchModelsOutcome;
    readonly differenceOf?: (graphRunId: number) => string | undefined;
  };
}

export function makeGraphOwnedBinding(deps: GraphOwnedBindingDeps) {
  return {
    /** A launch on a graph-owned ticket started nothing: say why, offer Cancel graph. */
    async launchBlocked(ticketId: number, run: GraphOwnedRun): Promise<void> {
      const db = deps.db();
      if (!db) return;
      const liveness = await graphRunLiveness(db, deps.facts, run.graphRunId);
      await showGraphOwnedNotice(
        {
          warn: deps.warn,
          confirm: deps.confirm,
          cancel: (graphRunId) =>
            cancelGraphRun(
              {
                db,
                transaction: deps.transaction,
                facts: deps.facts,
                killTree: deps.killTree,
                debug: deps.debug,
              },
              graphRunId,
              'cancelled by user from a blocked launch',
            ),
          refresh: () => deps.refresh(ticketId),
          inform: deps.inform,
          logError: deps.logError,
        },
        { ticketLabel: deps.label(ticketId), run, liveness },
      );
    },
    /**
     * An agent, model or preset pick: ask Keep or Switch when the new settings
     * give a graph run another identity; otherwise say it applies to the next launch.
     */
    async agentChoiceChanged(ticketId: number): Promise<void> {
      const db = deps.db();
      const run = db ? deps.activeRun(db, ticketId) : undefined;
      if (!run) return;
      const asked = deps.modelChange ? await deps.modelChange.ask({ ticketId }) : 0;
      if (asked === 0) deps.inform(graphOwnedChangeMessage(deps.label(ticketId), run));
    },
    /** A Settings Save: ask once for every live run when it changed what a graph role resolves to. */
    async agentSettingsSaved(identityChanged: boolean): Promise<void> {
      if (!identityChanged || !deps.modelChange) return;
      await deps.modelChange.ask({});
    },
    /** The later Switch (dashboard action, blocked banner): the same function the question runs. */
    switchModels(ticketId: number, graphRunId: number): SwitchModelsOutcome {
      const outcome = deps.modelChange?.switchRun(graphRunId) ?? 'not-found';
      if (outcome === 'switched') deps.refresh(ticketId);
      return outcome;
    },
    /** How the live run's snapshot differs from the current settings; undefined when equal. */
    modelDifference(graphRunId: number): string | undefined {
      return deps.modelChange?.differenceOf?.(graphRunId);
    },
  };
}
