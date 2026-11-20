import * as vscode from 'vscode';
import { type Store } from '../store/db.js';
import { dispatchGraphRecovery, type GraphRecoverySeams } from './ops/graphRecoveryDispatch.js';
import { recoverGraphRun } from '../approaches/graph/coordinator/recovery.js';
import { graphRecoveryRefusalNotice, graphRefusalHandling } from './ops/graphRecovery.js';
import { SessionManager } from '../ui/session.js';
import { type RecoveryDeps } from '../approaches/graph/coordinator/recovery.js';
import type { ReplanLaunchRequest } from '../approaches/graph/coordinator/replan.js';
import type { BootstrapRelaunchRequest } from '../approaches/graph/coordinator/recovery.js';
import { resumeBlockedStage } from '../workflow/stageResume.js';
import { fireGraphImplMarkerFromHost } from '../workflow/graphMarkerGuard.js';
import { transition } from '../workflow/machine.js';
import type { InsideActionHost } from '../ui/dashboard/insideActions.js';
import { getPrById } from '../store/prs.js';
import { getShipCommitById } from '../store/shipRuns.js';
import { type AsyncCapabilityGuard } from './ops/capabilityGuard.js';
import { markerAdvancedText, markerFailedText, reasonText } from '../model/notifyText.js';
import { ticketToastLabel } from './ticketToastLabel.js';
import { toast, ask } from './toastSeam.js';

/** True when the capability's tools are present; otherwise tells the user why not. */
export type CapabilityGuard = AsyncCapabilityGuard;

/** The vscode bindings for the inside-action dispatches (Task 13). Every
 *  target was already containment- and ownership-checked by the panel; these
 *  resolve the recorded object to its real-world surface. Graph controls
 *  (Slice 3 Task 11) arrive as host callbacks — the transport/session surface
 *  they need lives in `activate`, not here. */
export function makeInsideActionHost(
  store: Store,
  graphHost: {
    graphOpenSession: (
      ticketId: number,
      session: { kind: 'planner' | 'node'; runId: number },
    ) => void;
    graphStop: (ticketId: number, graphRunId: number) => void | Promise<void>;
    graphRestart: (ticketId: number, graphRunId: number) => void | Promise<void>;
    graphMarkImpl: (ticketId: number, graphRunId: number) => void | Promise<void>;
    graphDiscardNode: (ticketId: number, nodeRunId: number) => void | Promise<void>;
    graphEditOverride: (ticketId: number, nodeRunId: number) => void | Promise<void>;
    graphEditWorkspaceDeps: (ticketId: number, graphRunId: number) => void | Promise<void>;
  },
  // The impl stage's Session row: reveal (never launch) the ticket's own
  // interactive session terminal. The dispatch already proved a live
  // implementation run exists; this goes through `SessionManager.revealSession`
  // — the same reveal-or-adopt path `nudge` uses — so a reload that emptied
  // this window's bookkeeping still finds the still-running agent.
  revealSession: (ticketId: number) => void,
  // The graph recovery action's host binding (Slice-4 T6): the atomic claim
  // wrapper plus the prompt re-snapshot seam. Bound in activate where the
  // snapshot root is known; the panel host only routes Resume to it.
  graphRecoveryDeps: (graphRunId: number) => RecoveryDeps,
  // Launch the elected replan planner session (Slice-4 T5) — the recovery
  // election returns a launch request; the host starts the session.
  graphReplanLaunch: (launch: ReplanLaunchRequest) => void,
  // Launch a fresh bootstrap planner on a graph run whose previous bootstrap
  // planner died before ever submitting — the `planner-relaunch` recovery.
  graphBootstrapRelaunch: (launch: BootstrapRelaunchRequest) => void,
  /** Refresh the graph surfaces and immediately continue recoverable work. */
  onGraphRecovered: (ticketId: number, graphRunId: number) => void,
  retryShipRepo: (ticketId: number, repo: string) => void,
): InsideActionHost {
  // The ticket name every toast of this host uses (@arch:NTF-03).
  const label = (id: number): string => ticketToastLabel(store, id);
  const recoverySeams: GraphRecoverySeams = {
    recover: (input) => recoverGraphRun(graphRecoveryDeps(input.graphRunId), input),
    launchReplan: graphReplanLaunch,
    launchBootstrap: graphBootstrapRelaunch,
    onRecovered: onGraphRecovered,
  };

  /** Run either explicit graph recovery control. `recoverGraphRun` owns every
   * state transition; this host binding only launches the planner it elected
   * and reports the resulting non-verdict outcome. */
  const recoverBlockedGraph = (
    ticketId: number,
    graphRunId: number,
    mode: 'resume' | 'replan' | 'force-resume',
  ): void => {
    try {
      const recovery = dispatchGraphRecovery(recoverySeams, { ticketId, graphRunId, mode });
      if (recovery.kind === 'refused') {
        // A plain Resume on a node that already exited before starting twice is
        // the loop, not a recovery: offer the explicit Force retry the guard
        // refused to do on its own. Every other refusal is informational.
        const handling = graphRefusalHandling(ticketId, mode, recovery.reason);
        if (handling.offerForce) {
          void ask
            .warn(handling.message, { modal: true }, 'Force retry')
            .then((choice) => {
              if (choice === 'Force retry') recoverBlockedGraph(ticketId, graphRunId, 'force-resume');
            });
          return;
        }
        void toast.info(handling.message);
        return;
      }
      if (recovery.kind !== 'no-op') {
        void toast.info(
          mode === 'replan'
            ? `${label(ticketId)}: the implementation graph is replanning.`
            : `${label(ticketId)}: the implementation graph recovery started.`,
        );
      }
    } catch (err) {
      void toast.error(
        `${label(ticketId)}: could not ${mode === 'replan' ? 'replan' : 'resume'} the implementation graph (${reasonText(err)}).`,
      );
    }
  };

  return {
    openFile: (path, line) => {
      void (async () => {
        try {
          const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(path));
          const options: vscode.TextDocumentShowOptions = { preview: true };
          if (line !== undefined && line !== null && Number.isFinite(line) && line > 0) {
            // The evidence's 1-based line → the editor's 0-based caret position:
            // the cursor lands on the referenced line (869eja6uv).
            options.selection = new vscode.Range(line - 1, 0, line - 1, 0);
          }
          await vscode.window.showTextDocument(doc, options);
        } catch (e) {
          // The dispatch already proved the deepest ancestor exists, but the
          // file itself can be gone (worktree removed). Mirrors openStageLog's
          // failure copy: a missing file is "cannot open", never a verdict.
          void toast.warn(`Cannot open the file at ${path}. The worktree may be removed.`);
        }
      })();
    },
    openPr: (_ticketId, prId) => {
      const pr = getPrById(store, prId);
      if (pr) void vscode.env.openExternal(vscode.Uri.parse(pr.url));
    },
    openCommit: (_ticketId, shipCommitId) => {
      const commit = getShipCommitById(store, shipCommitId);
      if (commit) {
        void toast.info(
          `Commit ${commit.sha.slice(0, 8)} is recorded by Ship in ${commit.repo}.`,
        );
      }
    },
    resumeStage: (ticketId, stageKey) => {
      const outcome = resumeBlockedStage(store, ticketId, ticketId, stageKey);
      if (outcome.kind === 'cleared') {
        void vscode.commands.executeCommand('karst.openDashboard', ticketId);
        return;
      }
      if (outcome.kind === 'graph-mark-impl') {
        const result = fireGraphImplMarkerFromHost(store, outcome.ticketId);
        if (result.ok) {
          void toast.info(markerAdvancedText(label(outcome.ticketId)));
          void vscode.commands.executeCommand('karst.openDashboard', outcome.ticketId);
        } else {
          void toast.warn(markerFailedText(label(outcome.ticketId), reasonText(result.reason)));
        }
        return;
      }
      if (outcome.kind === 'graph-recovery') {
        // The generic Resume refuses the graph block by design (Slice-3 T9);
        // the typed action runs graph-aware recovery: a retry on the same
        // revision, clearing the block only after it durably entered.
        const recovery = dispatchGraphRecovery(recoverySeams, {
          ticketId: outcome.ticketId,
          graphRunId: outcome.graphRunId,
        });
        if (recovery.kind === 'retried') {
          void toast.info(`${label(ticketId)}: the implementation graph was retried.`);
        } else if (recovery.kind === 'run-restored') {
          void toast.info(`${label(ticketId)}: the accepted implementation graph runs again.`);
        } else if (recovery.kind === 'replanned') {
          void toast.info(`${label(ticketId)}: the implementation graph was replanned.`);
        } else if (recovery.kind === 'relaunched') {
          void toast.info(`${label(ticketId)}: the planner of the implementation graph started again.`);
        } else if (recovery.kind === 'refused') {
          void toast.info(
            graphRecoveryRefusalNotice(ticketId, 'resume', recovery.reason),
          );
        }
      }
    },
    openFullEvidence: (ticketId, _processRunId) => {
      void toast.info(`Full evidence for ${label(ticketId)} cannot open in this version.`);
    },
    openBoundedEvidence: (_ticketId, title, rows) => {
      const statusLabel: Record<string, string> = {
        pending: 'Pending',
        run: 'Running',
        wait: 'Waiting',
        pass: 'Passed',
        fail: 'Failed',
        note: 'Note',
        skip: 'Skipped',
      };
      void vscode.window.showQuickPick(
        rows.map((row) => ({
          label: row.label,
          ...(row.detail || row.status
            ? { description: [row.status ? (statusLabel[row.status] ?? 'Recorded') : '', row.detail ?? ''].filter(Boolean).join(' · ') }
            : {}),
          ...(row.duration ? { detail: row.duration } : {}),
        })),
        { title, placeHolder: 'Recorded repository evidence' },
      );
    },
    openSession: (ticketId) => revealSession(ticketId),
    graphOpenSession: (ticketId, session) => graphHost.graphOpenSession(ticketId, session),
    graphStop: (ticketId, graphRunId) => graphHost.graphStop(ticketId, graphRunId),
    graphRestart: (ticketId, graphRunId) => graphHost.graphRestart(ticketId, graphRunId),
    graphResume: (ticketId, graphRunId) => recoverBlockedGraph(ticketId, graphRunId, 'resume'),
    graphReplan: (ticketId, graphRunId) => recoverBlockedGraph(ticketId, graphRunId, 'replan'),
    graphMarkImpl: (ticketId, graphRunId) => graphHost.graphMarkImpl(ticketId, graphRunId),
    graphDiscardNode: (ticketId, nodeRunId) => graphHost.graphDiscardNode(ticketId, nodeRunId),
    graphEditOverride: (ticketId, nodeRunId) => graphHost.graphEditOverride(ticketId, nodeRunId),
    graphEditWorkspaceDeps: (ticketId, graphRunId) => graphHost.graphEditWorkspaceDeps(ticketId, graphRunId),
    retryShipRepo: (ticketId, repo) => retryShipRepo(ticketId, repo),
  };
}
