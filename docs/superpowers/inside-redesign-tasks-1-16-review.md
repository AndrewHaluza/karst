# Inside Redesign — Tasks 1–16 Implementation Review

Date: 2026-08-08
Plan: `docs/superpowers/plans/2026-08-08-inside-redesign.md`
Reviewed range: `9f5bfdb..a6dca4b` and the current integrated worktree
Verdict: **Needs revision — Task 16 incomplete**

## Executive Summary

The implementation compiles and the complete automated suite passes, but it does not yet satisfy the full 16-task execution plan. The review found **1 blocking incomplete delivery, 11 high-severity defects, and 5 medium-severity defects**. The largest risks are nonfunctional process-disable settings, incorrect recovery/session ownership, unsafe Ship error handling, premature merged/delivered presentation, and the missing Task 16 fixture/preview deliverables.

## Task Coverage

| Task | Result | Summary |
| --- | --- | --- |
| 1. Six-stage contract and registry | Pass | Closed stage/process/evidence contracts are present and tested. |
| 2. Durable process evidence schema | Pass | Schema and process-run persistence align with the planned contract. |
| 3. Token/finding process links | Pass | Durable links exist; later binding defects are covered under Tasks 4–6. |
| 4. Implementation runs and segments | Gaps | Resume leaves the canonical Session process interrupted. |
| 5. Interactive usage deltas | Gaps | Live Fix attribution and transaction-boundary defects. |
| 6. Recovery rounds | Gaps | Ownership, provenance, delivery failure, and exhaustion defects. |
| 7. Process assignments | Gaps | `enabled: false` has no runtime effect. |
| 8. Tester/Review execution | Gaps | Review cancellation can validate/advance; Tester cap is applied per repo. |
| 9. Ship saga | Gaps | Git status failure is treated as clean; baseline provenance is unbounded. |
| 10. Scope/Implementation reducers | Gaps | Configured identity disappears during prepared-but-unconfirmed launch. |
| 11. UAT/Review/Fix reducers | Pass with upstream caveats | Reducers are implemented, but consume incorrect recovery state from Tasks 6/8. |
| 12. Ship/Done reducers | Gaps | Absence becomes pass and `mergedAt` overrides current PR status. |
| 13. Dashboard state/actions | Gaps | Ship still uses a legacy target-bearing progress/render path. |
| 14. Generic ledger webview | Gaps | Ship execution bypasses the ledger and retains webview business derivation. |
| 15. Specialized renderers | Pass | Closed evidence kinds and specialized presentation are integrated and tested. |
| 16. Responsive/accessibility/scale verification | **Incomplete** | Required fixtures, preview command, mode boundary, and manual verification path are absent. |

## Blocking / Incomplete

### 1. Task 16 deliverables are absent

Expected but missing:

- `src/ui/dashboard/insideFixtures.ts` and its test
- `src/ui/dashboard/insidePreview.ts` and its test
- `karst.dev.openInsidePreview` contribution and development-only registration
- Mode/import-isolation verification and the planned deterministic 2/5/10/15/20-repository fixture matrix

Commit `a6dca4b` adds a few static scale/accessibility assertions, but not the fixture matrix, production-renderer preview, development-only safety boundary, or manual Extension Dev Host workflow required by Task 16.

Required work: implement the planned fixture and preview modules, register the command only in Development mode, prove Production/Test do not register it, prove normal dashboard dependencies cannot reach fixtures, and record the manual width/keyboard/reduced-motion verification.

## High-Severity Findings

### 2. Task 7 — `processes.*.enabled` is ignored at runtime

Locations: `src/agent/processAssignment.ts:65-90`, `src/extension.ts:757-772`, `src/extension.ts:1982-1987`

The manifest and Settings UI persist an enable toggle, but `resolveProcessAssignment` drops `enabled` and the extension constructs Tester/Review processes unconditionally. Setting `enabled: false` still spends tokens and opens process runs.

Required work: make disabled assignments resolve to no executable process at the execution boundary and add disabled Tester/Review integration tests proving no adapter call or process run occurs.

### 3. Task 8 — Review cancellation can be recorded as validated and advance

Location: `src/workflow/review/findingsLane.ts:157-196`

When the signal is aborted, the target loop merely breaks and returns an ordinary `ran` outcome. `runReview` can consequently close the Review process as validated and aggregate/transition normally after Stop.

Required work: return an explicit stopped/interrupted outcome, interrupt the process, prevent verdict/round creation and transition, and test abort-before-first-target and abort-between-targets.

### 4. Task 4 — Resumed Implementation does not reopen its canonical Session process

Locations: `src/store/implementationRuns.ts:300-324`, `src/store/sessionLaunchIntents.ts:318-325`

SessionEnd interrupts both the implementation run and process run. Resume flips only `implementation_runs` back to running. The final marker updates only a running process, so Implementation can pass while its Inside Session row remains interrupted; resumed usage can also point to that terminal process.

Required work: resume/reopen the canonical process consistently with the implementation run and add a launch → end → resume → marker lifecycle assertion over both records.

### 5. Tasks 5/6 — Live Fix usage is attributed to the old Implementation process

Locations: `src/store/interactiveUsageSamples.ts:156-205`, `src/store/recoveryRounds.ts:417-446`

Session binding selects the latest confirmed launch intent. A live Fix nudge opens a Fix process but no new session intent, so UsageUpdate from the same provider session remains `implementation` and retains the Implementation segment instead of `fix-resume` and the Fix process.

Required work: resolve active, provider/session-owned Fix execution before the old Implementation binding and add an end-to-end live-nudge UsageUpdate test.

### 6. Task 6 — False live-nudge delivery strands a round in `fixing`

Locations: `src/workflow/fixExecution.ts:91-110`, `src/ui/session.ts:555-560`

`resumeFixExecution` ignores `nudge(prompt) === false`. If the terminal disappears after the liveness check, the function reports `nudged` although no brief was delivered, leaving a running process and `fixing` round indefinitely.

Required work: treat false as delivery failure, interrupt both records, and add a persisted-state regression test.

### 7. Tasks 6/8 — Blocking Review findings lose their causal process-run ID

Location: `src/workflow/stages/review.ts:175-189`

The recovery trigger identifies `sourceProcessId = 'review'` but always stores `sourceProcessRunId = null`, even though the findings lane exposes its durable Review run.

Required work: carry `findingsLane.processRunId` for blocking findings while keeping deterministic gate failures null, and assert the link in Review tests.

### 8. Task 6 — Recovery executions can attach across tickets

Locations: `src/store/recoveryRounds.ts:417-446`, `src/store/recoveryRounds.ts:467-490`

The live update constrains only round ID/status, and the closed-session intent validates existence/status but not ticket ownership. A stale/wrong round ID can attach ticket A's process or intent to ticket B's recovery round.

Required work: enforce ticket identity transactionally in both paths and add rollback/rejection tests for cross-ticket IDs.

### 9. Task 9 — Failed `git status` is treated as a clean worktree

Location: `src/workflow/stages/ship.ts:874-881`

The Ship path treats both a nonzero `git status --porcelain` exit and empty stdout as “nothing to commit”, then may continue to push/open a PR. A Git failure can silently omit dirty work.

Required work: only exit 0 plus empty output is clean; nonzero must throw/park Ship. Add a nonzero-status regression.

### 10. Task 12 — Ship aggregate converts absence/notes into pass

Location: `src/model/inside/ship.ts:101-106`

After checking fail/run, `aggregateStatus` returns pass for every nonempty row set. A repository containing only `note` evidence such as “no push recorded” or “PR step not recorded” therefore makes the top-level process green; mixed pass+note is also green.

Required work: preserve note/partial status and test process-level aggregation, not only evidence row status.

### 11. Task 12 — `mergedAt` is treated as equivalent to current status `merged`

Locations: `src/model/inside/ship.ts:208-235`, `src/model/inside/done.ts:85`

Ship and Done accept `mergedAt` even when current PR status is open/unknown. The project invariant and plan require the current PR's status to be literally `merged`; stale or partial metadata must never produce a green merge row or completed receipt.

Required work: remove the `mergedAt` fallback and add open/unknown-with-mergedAt regressions.

### 12. Tasks 13/14 — Live Ship still bypasses the generic ledger protocol

Locations: `src/ui/dashboard/messages.ts:85-96`, `src/ui/dashboard/webview.html:1039-1087`, `src/ui/dashboard/webview.html:1418-1424`

Legacy `ship-progress`, `SHIP_STEP_ORDER`, `flattenShipOps`, and `shippingView` remain active. During Ship, `renderInside` explicitly switches to `renderInsideFlat`, so the redesigned ledger disappears and the webview derives Ship business state—the exact path Task 14 required retiring.

Required work: translate Ship progress into the generic host-owned `InsideProgressEvent`/process views, remove the legacy protocol and flat fallback, and invert tests so obsolete derivation is rejected.

## Medium-Severity Findings

### 13. Task 8 — Tester observation cap is applied per repository

Location: `src/workflow/uat/tester.ts:148-178`

Each target parses up to `maxObservations`, so a 10-repository run can persist ten times the documented execution cap.

Required work: apply one combined cap across the complete Tester execution and test multi-repository truncation.

### 14. Task 5 — Binding resolution is outside the sample transaction

Location: `src/store/interactiveUsageSamples.ts:227-244`

The plan requires current binding resolution, sample insertion, and delta insertion in one transaction. Binding is resolved before the transaction, allowing another window to supersede/close ownership between read and write.

Required work: move binding resolution and the unattributed decision inside the existing transaction and add a snapshot/transaction-boundary test.

### 15. Task 6 — Exhaustion is never persisted

Location: `src/workflow/driveTicket.ts:294-315`

The schema and UI support `exhausted`, but the driver only logs the cap decision. The round remains `pending`, history is misleading, and every later drive reconsiders it.

Required work: atomically transition the constrained pending round to `exhausted` with `ended_at`, and test idempotence and subsequent drive behavior.

### 16. Task 9 — “Before Ship” provenance records full repository ancestry

Locations: `src/workflow/stages/ship.ts:859-868`, `src/integrations/git.ts:589-601`

Ship calls `listCommitsFrom(..., null)`, which resolves to `git rev-list --reverse HEAD`. This stores the entire reachable repository history per ticket and inflates/mislabels “before ship” evidence.

Required work: bound provenance at the ticket's persisted baseline/base SHA or ref and test that base ancestry is excluded.

### 17. Task 10 — Configured identity disappears before SessionStart

Location: `src/model/inside/agent.ts:389-405`

`configuredExecution` is emitted only when there is no timeline. A launch-prepared run creates timeline evidence before a confirmed segment, so the row shows neither the configured identity nor a recorded execution identity during that window.

Required work: show configured identity until recorded execution exists (`!execution`), and test a prepared intent with no confirmed segment.

## Verification Performed

- Full suite: **302 files, 4,898 tests passed** (`npm test`).
- Typecheck: passed (`npm run typecheck`).
- Production build and asset copy: passed (`npm run build`).
- Tasks 1–4/7–10 focused audit: **16 files, 351 tests passed**.
- Tasks 9–15 focused audit: **18 files, 573 tests passed**.
- Original Tasks 5/6 focused audit: **20 files, 533 tests passed**.
- Task implementation range whitespace/error check passed (`git diff 1e39b00..d1aa9dc --check`).

The automated gates establish regression stability for covered paths; they do not cover the failure modes above. Task 16's required manual verification cannot be performed through the planned path because that preview path is not implemented.

## Recommended Execution Order

1. Finish Task 16's missing fixture/preview boundary so visual and scale verification is possible.
2. Enforce identity and ownership: disabled assignments, recovery ticket checks, Implementation resume, live Fix usage binding.
3. Repair recovery state transitions: false delivery, causal Review run, cancellation, exhaustion, and transactional usage binding.
4. Repair Ship correctness: nonzero Git status, bounded baseline history, note aggregation, and literal merged status.
5. Remove the legacy Ship protocol/flat renderer and exercise Ship through the generic ledger.
6. Apply the Tester global cap and pending configured identity correction.
7. Add every listed regression, then rerun focused suites, full tests, typecheck, build, and diff checks; finally perform and record the Task 16 manual Dev Host matrix.
