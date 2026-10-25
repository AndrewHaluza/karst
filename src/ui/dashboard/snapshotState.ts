import type { Store } from '../../store/db.js';
import type { AgentProvider, Manifest, TicketProvider } from '../../manifest/types.js';
import { getTicket } from '../../store/tickets.js';
import type { GateStageKey } from '../../workflow/fixAttempts.js';
import type { SharedServerView } from '../../store/sharedServers.js';
import type { GraphInsideInput } from '../../model/inside/graph.js';
import { resolveBaselineBranchForPath } from '../../manifest/baselineBranch.js';
import { withBaselines } from './baselineRows.js';
import {
  buildDashboardState,
  type DashboardAgentContext,
  type DashboardState,
  type PathContext,
} from './state.js';
import { toRegisteredGraphTarget, type SnapshotRegistry } from './snapshotRegistry.js';
import type { DashboardSelections } from './selections.js';
import type { SupplementalLoaders } from './supplementalLoaders.js';
import { agentContextFor, assignmentFor, repoNameFor, serviceNamesFor } from './resolvers.js';

/** Everything the snapshot is built from, as the manager was constructed with it. */
export interface SnapshotInputs {
  store: Store;
  registry: SnapshotRegistry;
  selections: DashboardSelections;
  loaders: SupplementalLoaders;
  pathContext?: () => PathContext | undefined;
  ticketing?: () => { provider?: TicketProvider } | undefined;
  approachPhases?: (approachId: string | null) => string[];
  isRepoRunnable?: (repo: string) => boolean;
  defaultProvider?: () => AgentProvider | undefined;
  agentContext?: () => DashboardAgentContext;
  fixCapFor?: (gate: GateStageKey) => number;
  manifest?: () => Manifest | undefined;
  launchCheckout?: (path: string) => boolean;
  graphInsideFor?: (ticketId: number) => GraphInsideInput | null;
  sharedServersFor: (ticketId: number) => SharedServerView[];
}

/** Mint this snapshot's action registry and build the state it describes. */
export function buildSnapshotState(
  i: SnapshotInputs,
  ticketId: number,
  supplemental: boolean,
): DashboardState {
  // A fresh action registry PER SNAPSHOT: every state push is authoritative,
  // so the ids it mints are the only live capabilities. The registry itself
  // (with its host-only targets) never leaves this manager.
  //
  // A LIVE repaint is the SAME snapshot re-read, and the webview only updates
  // running clocks in place — it does not re-render its rows, so it keeps
  // displaying the ids of the build it last RENDERED. Superseding the
  // registry once a second would push those displayed ids into the grace
  // window and let them age out of it while a long-running stage (a gate, a
  // review findings lane) is still ticking, turning a click on a finding's
  // file link into "This action is no longer available" (869eja6uv). So a
  // repaint REUSES the current registry — the ids it already holds stay live,
  // and `register` memoizes by target so a re-mint of the same row is the
  // same id rather than unbounded growth. A real push (which re-renders the
  // webview with freshly minted ids) is what supersedes.
  const registry = i.registry.beginSnapshot(ticketId, supplemental);
  // The graph projection's controls (Slice 3 Task 11 / Slice 4 Task 4) ride
  // the SAME opaque typed-action seam: the projection is pure, so the host
  // injects the attach closure that mints ids in THIS snapshot's registry.
  const graphInside = i.graphInsideFor?.(ticketId) ?? null;
  if (graphInside) {
    graphInside.attach = (target) => {
      const action = registry.register(toRegisteredGraphTarget(target, ticketId));
      return action ?? undefined;
    };
  }
  const ticket = getTicket(i.store, ticketId);
  const built = buildDashboardState(
    i.store,
    ticketId,
    i.pathContext?.(),
    i.ticketing?.(),
    i.approachPhases,
    i.isRepoRunnable,
    i.defaultProvider?.(),
    agentContextFor(
      i.agentContext?.(),
      i.manifest?.(),
      ticket?.agentPreset ?? null,
      ticket?.agentProvider ?? null,
    ),
    i.fixCapFor,
    (id) => {
      const manifest = i.manifest?.();
      return manifest ? serviceNamesFor(i.store, manifest, id) : [];
    },
    (processId) => assignmentFor(i.store, i.manifest?.(), ticketId, processId),
    registry,
    i.loaders.gateOptionsFor(ticketId),
    i.launchCheckout,
    // The inside ship rows name the repository, never the path the runtime
    // tables key by — the manifest's name for a recorded repoPath.
    (repo) => {
      const manifest = i.manifest?.();
      return manifest ? repoNameFor(manifest, repo) : undefined;
    },
    // The graph runtime's read-only projection (Slice 3 Task 11): built
    // host-side, null for a ticket with no graph run.
    graphInside,
    // The round switcher's current selection (Option B, T5): the state
    // builder resolves a stale/unknown key to that stage's latest attempt
    // itself, so the panel need not validate it against the snapshot.
    i.selections.attemptSelectionFor(ticketId),
    // The manifest's resolved default base branch, for the scope card's
    // "changed" affordance (§ per-repo base branch — live change). Absent
    // manifest → `''`, which never marks a real branch as overridden.
    (repoPath) => {
      const manifest = i.manifest?.();
      return manifest ? resolveBaselineBranchForPath(manifest, repoPath) : '';
    },
    // Cached candidates, warmed by the loaders below — never fetched HERE,
    // since this builder must stay synchronous.
    (repoPath) => i.loaders.branchCandidatesFor(repoPath),
    // Task 4.1: the ship-stage warning row's threshold. Absent manifest, or
    // the findings lane switched off entirely (`enabled: false` — the
    // shipped example config's alternative to lowering blockingSeverity),
    // both read as `'none'`: an `enabled: false` project records no
    // findings at all, so a leftover `blockingSeverity: 'high'` beside it
    // must not light up a row nothing on record can ever satisfy.
    (() => {
      const findings = i.manifest?.()?.review?.findings;
      return findings?.enabled === false ? 'none' : (findings?.blockingSeverity ?? 'none');
    })(),
    // The findings repo scope selection per stage (§ findings severity ramp):
    // panel memory, passed through to the quality reducers. Absent → "all".
    i.selections.findingsRepoSelectionFor(ticketId),
    (() => {
      const manifest = i.manifest?.();
      return {
        review: manifest?.review?.findings?.blockingSeverity,
        tester: manifest?.uat?.testerObservations?.blockingSeverity,
      };
    })(),
    // The shared half of the Servers panel (D203): manifest + store, so it
    // arrives as an injected provider and never from the state builder.
    (id) => i.sharedServersFor(id),
  );
  const stored = i.loaders.storedArtifactsFor(ticketId);
  // The ship preview rides ONLY while the ship slot is confirm/retry (D142):
  // outside those states it is absent from the snapshot, so the webview has
  // no empty card to render. The cache itself is kept, so re-entering the
  // slot shows the last read until the fresh one lands.
  const shipPreview = i.loaders.shipPreviewFor(ticketId);
  const state = {
    ...withBaselines(built, i.loaders.baselinesFor(ticketId)),
    ...(stored ? { storedArtifacts: stored } : {}),
    ...(shipPreview && (built.ship.kind === 'confirm' || built.ship.kind === 'retry')
      ? { shipPreview }
      : {}),
  };
  return state;
}
