import * as vscode from 'vscode';
import { type Store } from '../store/db.js';
import { graphRecoveryRefusalNotice, graphRefusalHandling } from './ops/graphRecovery.js';
import { SessionManager } from '../ui/session.js';
import { recoverGraphRun, type RecoveryDeps } from '../approaches/graph/coordinator/recovery.js';
import type { ReplanLaunchRequest } from '../approaches/graph/coordinator/replan.js';
import type { BootstrapRelaunchRequest } from '../approaches/graph/coordinator/recovery.js';
import { resumeBlockedStage } from '../workflow/stageResume.js';
import { transition } from '../workflow/machine.js';
import type { InsideActionHost } from '../ui/dashboard/insideActions.js';
import { getPrById } from '../store/prs.js';
import { getShipCommitById } from '../store/shipRuns.js';
import { type Capability } from '../runtime/deps.js';
import { formatId } from '../model/entityId.js';

/** True when the capability's tools are present; otherwise tells the user why not. */
export type CapabilityGuard = (capability: Capability, ticketId?: number, silent?: boolean) => boolean;

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
    graphConfirm: (ticketId: number, graphRunId: number) => void | Promise<void>;
    graphMarkImpl: (ticketId: number, graphRunId: number) => void | Promise<void>;
    graphDiscardNode: (ticketId: number, nodeRunId: number) => void | Promise<void>;
    graphEditOverride: (ticketId: number, nodeRunId: number) => void | Promise<void>;
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
  /** Run either explicit graph recovery control. `recoverGraphRun` owns every
   * state transition; this host binding only launches the planner it elected
   * and reports the resulting non-verdict outcome. */
  const recoverBlockedGraph = (
    ticketId: number,
    graphRunId: number,
    mode: 'resume' | 'replan' | 'force-resume',
  ): void => {
    try {
      const recovery = recoverGraphRun(
        graphRecoveryDeps(graphRunId),
        { ticketId, graphRunId, mode },
      );
      if (recovery.kind === 'replanned' && recovery.launch) {
        graphReplanLaunch(recovery.launch);
      }
      if (recovery.kind === 'relaunched' && recovery.launch) {
        graphBootstrapRelaunch(recovery.launch);
      }
      if (recovery.kind === 'refused') {
        // A plain Resume on a node that already exited before starting twice is
        // the loop, not a recovery: offer the explicit Force retry the guard
        // refused to do on its own. Every other refusal is informational.
        const handling = graphRefusalHandling(ticketId, mode, recovery.reason);
        if (handling.offerForce) {
          void vscode.window
            .showWarningMessage(handling.message, { modal: true }, 'Force retry')
            .then((choice) => {
              if (choice === 'Force retry') recoverBlockedGraph(ticketId, graphRunId, 'force-resume');
            });
          return;
        }
        void vscode.window.showInformationMessage(handling.message);
        return;
      }
      if (recovery.kind !== 'no-op') {
        onGraphRecovered(ticketId, graphRunId);
        void vscode.window.showInformationMessage(
          mode === 'replan'
            ? `Ticket ${formatId('ticket', ticketId)}: the implementation graph is replanning (graph run ${graphRunId}).`
            : `Ticket ${formatId('ticket', ticketId)}: the implementation graph recovery started (graph run ${graphRunId}).`,
        );
      }
    } catch (err) {
      void vscode.window.showErrorMessage(
        `Could not ${mode} the implementation graph: ${err instanceof Error ? err.message : String(err)}`,
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
          void vscode.window.showWarningMessage(`Cannot open the file at ${path}.`);
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
        void vscode.window.showInformationMessage(
          `Commit ${commit.sha.slice(0, 8)} — recorded by ship in ${commit.repo}`,
        );
      }
    },
    resumeStage: (ticketId, stageKey) => {
      const outcome = resumeBlockedStage(store, ticketId, ticketId, stageKey);
      if (outcome.kind === 'cleared') {
        void vscode.commands.executeCommand('karst.openDashboard', ticketId);
        return;
      }
      if (outcome.kind === 'graph-recovery') {
        // The generic Resume refuses the graph block by design (Slice-3 T9);
        // the typed action runs graph-aware recovery: a retry on the same
        // revision, clearing the block only after it durably entered.
        const recovery = recoverGraphRun(
          graphRecoveryDeps(outcome.graphRunId),
          { ticketId: outcome.ticketId, graphRunId: outcome.graphRunId },
        );
        if (recovery.kind === 'retried') {
          void vscode.window.showInformationMessage(
            `Ticket ${formatId('ticket', ticketId)}: the implementation graph was retried (graph run ${outcome.graphRunId}).`,
          );
        } else if (recovery.kind === 'confirmation-restored') {
          void vscode.window.showInformationMessage(
            `Ticket ${formatId('ticket', ticketId)}: the accepted implementation graph is ready to start again.`,
          );
        } else if (recovery.kind === 'replanned') {
          if (recovery.launch) graphReplanLaunch(recovery.launch);
          void vscode.window.showInformationMessage(
            `Ticket ${formatId('ticket', ticketId)}: the implementation graph was replanned (graph run ${outcome.graphRunId}).`,
          );
        } else if (recovery.kind === 'relaunched') {
          if (recovery.launch) graphBootstrapRelaunch(recovery.launch);
          void vscode.window.showInformationMessage(
            `Ticket ${formatId('ticket', ticketId)}: the implementation graph's bootstrap planner was relaunched (graph run ${outcome.graphRunId}).`,
          );
        } else if (recovery.kind === 'refused') {
          void vscode.window.showInformationMessage(
            graphRecoveryRefusalNotice(ticketId, 'resume', recovery.reason),
          );
        }
        // Keep this legacy Resume route on the same post-recovery seam as the
        // typed graph controls. It owns neither a second recovery nor launch:
        // it only refreshes the surfaces and wakes work recovery made ready.
        if (
          recovery.kind === 'retried' ||
          recovery.kind === 'confirmation-restored' ||
          recovery.kind === 'replanned' ||
          recovery.kind === 'relaunched'
        ) {
          onGraphRecovered(ticketId, outcome.graphRunId);
        }
      }
    },
    openFullEvidence: (ticketId, processRunId) => {
      void vscode.window.showInformationMessage(`Inside evidence: process run #${processRunId} on ticket ${formatId('ticket', ticketId)}`);
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
    graphConfirm: (ticketId, graphRunId) => graphHost.graphConfirm(ticketId, graphRunId),
    graphMarkImpl: (ticketId, graphRunId) => graphHost.graphMarkImpl(ticketId, graphRunId),
    graphDiscardNode: (ticketId, nodeRunId) => graphHost.graphDiscardNode(ticketId, nodeRunId),
    graphEditOverride: (ticketId, nodeRunId) => graphHost.graphEditOverride(ticketId, nodeRunId),
    retryShipRepo: (ticketId, repo) => retryShipRepo(ticketId, repo),
  };
}
