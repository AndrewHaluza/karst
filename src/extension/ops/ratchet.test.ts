import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// The number ratchets down as extractions land and is, with the exception of
// the planned servers seed wiring below, never raised. The value is the
// measured line count plus 3 lines of deliberate slack. It was raised once for
// the ONBOARDING-SETUP-AGENT binding: the setup feature's activation call is a
// thin deps object in `activate()`, and its launch/proposal/watch logic lives in
// `src/extension/setupWiring.ts` + `src/extension/ops/setup*.ts`. Anything
// larger than a thin binding belongs in src/extension/ops/. Raised by 2 for the
// graph-ticket mailbox binding (one import + one `visitMailboxOf` line in the
// driver deps; the logic lives in `src/approaches/graph/visitMailbox*.ts`).
// Raised by 2 for the 'Karst: Run Doctor' binding (one import + one registration;
// logic is in `src/ui/doctor/host.ts` and `ops/doctorOps.ts`).
// Raised by 2 for the draft-constraints bindings (`archDocs` on the proposal ops,
// `repoPaths`/`commitExists`/`onWarnings` on the outbox); the checks live in
// `ops/planningConstraintChecks.ts`.
// Raised by 10 for the sub-task provider sync binding (`syncSubtask: makeSubtaskSync({...})`
// in the lifecycle deps + 2 imports; logic is in `ops/subtaskSyncOps.ts`).
// Raised by 10 for the baseline-review bindings (@arch:BASELINE-REVIEW): the
// shared `vscodeNotify`, the `makeBaselineActions` spread, the panel-host worktree
// roots and the rows loader; the logic is in `ops/baselineDecisionOps.ts` and
// `ui/dashboard/baselineRows.ts`.
// Raised by 2 for the artifact-store retention binding (one import + one
// `sweepArtifactRetention` line in the PR-sync tick; logic is in `src/artifacts/retention.ts`).
// Raised by 19 for the artifact-capture binding (`wireArtifactCapture` call, its
// four hook bindings and the SessionEnd line); logic is in `src/artifacts/service.ts`
// and `src/extension/artifactCaptureWiring.ts`.
// Raised by 7 for the Settings pending-outputs bindings (`readPendingOutputs`,
// `clearPendingOutputs` and the manager arg); logic is in `src/approaches/pendingOutputs.ts`.
// Raised by 10 for the dashboard Artifacts binding (`createStoredArtifactBinding`
// call, its disposal, the `forTicket` arg and the action spread); logic is in
// `src/extension/ops/storedArtifactOps.ts`, the vscode half in `storedArtifactBinding.ts`.
// Raised by 5 more for the sidebar artifact-count badge (`makeSidebarArtifactCounts`
// call and the `artifactCount` arg); logic is in `src/artifacts/countCache.ts`.
// Raised by 19 for the fix-delivery bindings (@arch:V77): the `fixDelivery` wiring
// object + its sweep timer, the seed path's one-transaction snapshot write, the two
// mailbox deps, and the `deliverFix` seam; logic is in `ops/fixDelivery*.ts`.
// Raised by 18 for the reviewer-conformance bindings (`makeReviewArtifactsBinding` arg,
// the `onRevision` feed and the `makeAlignmentTrigger` call + disposal); logic is in
// `src/extension/reviewArtifactsBinding.ts` and `src/extension/alignmentBinding.ts`.
// Raised by 2 (8531 -> 8533): #583 (MCP-first delivery pointers) landed on develop one line over the cap.
// Raised by 8 (8533 -> 8541): launch MCP channel binding for the seed (`launchHasMcp`); logic is in `agent/karstCommandText.ts`.
// Raised by 39 (8541 -> 8580): opencode2 pre-launch auth warning. The check
// itself lives in `ops/opencode2AuthWarning.ts` and the parser in
// `agent/opencode2Auth.ts`; what stays here is the one binding the ops module
// cannot own — the `vscode.window.showWarningMessage` seam, the login command,
// the isolated-env-capable output probe, and the `karst.openSession` call site.
// Raised by 7 (8580 -> 8587): sbx backend (AC-32) — one import, the
// `backendSessionOptions` spread at the launch site and the `karst.sandbox.sync`
// registration; logic is in `ops/sandboxSyncOps.ts` and `agent/backendResolver.ts`.
// Raised by 14 (8587 -> 8601): sandbox evidence bridge lifecycle (arch:AC-34) — imports,
// the registry built from the hook endpoint's own dispatch closures, the boot
// re-attach sweep, terminal-close detach, the `bridgeFor` launch spread and the
// `karst.sandbox.dispose` registration; logic is in `ops/bridgeWiring.ts`,
// `ops/bootSweeps.ts:runBridgeSweep`, `ops/sandboxSyncOps.ts` and `agent/bridge/bridgeRegistry.ts`.
// Raised by 2 (8601 -> 8603): `deactivate` stops every bridge poller (`detachAll`), keeping the dirs.
// Raised by 4 (8603 -> 8607): sandbox rollout UI (ST9) — the settings `probeBackends` dep and its
// import, the Sandbox card's four dashboard actions, the `sandboxLife` module-level handle those
// actions reach, and the `showDiff`/`warn`/`ticketOverride` seams; logic is in `ops/sandboxDiffOp.ts`,
// `ops/sandboxWiring.ts`, `ops/sandboxSyncOps.ts`, `agent/backendProbe.ts` and `ui/dashboard/sandboxView.ts`.
// Raised by 58 (8580 -> 8638): the per-core subscription-quota binding (D163).
// The decision half (badge text/warning) lives in `ops/quotaOps.ts` and the
// reader service in `agent/quota/`; what stays here is the two vscode seams the
// ops layer cannot own — the status-bar item and `window.showWarningMessage` —
// plus the service lifecycle (construct, start, dispose) and the panel's two
// quota deps.
// Raised by 4 (8580 -> 8584): UAT probe bindings (KARST_UAT_PROBE=1 only) — one
// import plus the `installProbeRecorder()` call (it must patch vscode.window
// before anything else is created) and the `registerProbeCommand()` line in
// `activate()`. All probe logic lives in `src/uatHost/probe/*`.
// Both raises branched from 8580; the merge carries them together (measured 8639
// lines + 3 slack: 8580 + 58 + 4 = 8642).
// Merge of the sandbox branch (+27: 8580 -> 8607) with develop (8642): 8642 + 27 = 8669.
// Sandbox dependency provisioning (D195, +1: 8669 -> 8670): the `karst.sandbox.setup` palette registration; logic is in `ops/sandboxSetupOp.ts` / `sandboxTicketOps.ts`.
// T715 ship CI actions: +13 (ciHost seam, ciActionsInput, two handlers, imports): 8670 + 13 = 8683.
// Deliver to PR: +6 (tracker, runPrSync sweep, ciHost deliver seam, runShipSaga option, action binding): 8683 + 6 = 8689.
// Sidebar "Send CI failure to agent" peek CTA (T742, +2: 8689 -> 8691): one binding line + its comment; logic is `ops/ciFailureOps.ts`.
const MAX_EXTENSION_LINES = 8691;

describe('extension.ts ratchet', () => {
  it('extension.ts does not exceed the recorded line count', () => {
    const source = readFileSync(join(process.cwd(), 'src', 'extension.ts'), 'utf8');
    const lineCount = source.split('\n').length;
    expect(lineCount).toBeLessThanOrEqual(MAX_EXTENSION_LINES);
  });
});

describe('ops/ has no vscode import', () => {
  it('no file under src/extension/ops/ imports vscode', () => {
    const opsDir = join(process.cwd(), 'src', 'extension', 'ops');
    const files = readdirSync(opsDir).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));
    const vscodeRe = /from ['"]vscode['"]|require\(['"]vscode['"]\)/;
    const violations: string[] = [];
    for (const file of files) {
      const content = readFileSync(join(opsDir, file), 'utf8');
      if (vscodeRe.test(content)) {
        violations.push(file);
      }
    }
    expect(violations).toEqual([]);
  });
});
