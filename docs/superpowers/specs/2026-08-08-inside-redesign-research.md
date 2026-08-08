# Inside Redesign — Codebase Research

**Ticket:** 869effdx5
**Date:** 2026-08-08
**Decision:** Conditional GO — implement persistence and instrumentation before enabling evidence-backed UI claims.

## Executive conclusion

The approved prototype fits Karst's host-owned, evidence-driven architecture, but it is not an HTML-only redesign. The current Inside model is a flat `StageOp[]` projection and the database does not retain several histories the prototype presents after reload. Building the visual surface first would fabricate implementation segments, UAT Tester work, recovery policy history, Ship commit/push provenance, and parts of the Done receipt.

The safe delivery order is:

1. define the six-stage presentation contract while preserving the runtime `fix` node;
2. add durable process, recovery, implementation-segment, and Ship evidence;
3. instrument workflows at the moment evidence is produced;
4. build host-side process reducers and a Done receipt;
5. replace the flat webview with the generic ledger and specialized renderers;
6. add the unified live-operation channel and perform scale/accessibility verification.

## Current architecture

### Model boundary

- `src/model/inside/types.ts` defines seven truthful operation statuses, but `StageOp` carries only `status`, `name`, `detail`, and `duration`.
- `src/model/inside/index.ts`, `agent.ts`, and `gates.ts` are pure reducers. This is the correct ownership boundary and should remain pure.
- `src/ui/dashboard/state.ts` loads the ticket evidence once and builds every stage snapshot. It currently omits `stage_runs`, token usage, service context, and process execution history.
- `src/ui/dashboard/webview.html` renders a flat list and derives transient Ship process rows from `ship-progress`. That Ship derivation must move host-side.

### Lifecycle compatibility

- Runtime `StageKey` still includes `fix`, and the graph routes UAT/Review failure through it.
- The stage rail already projects Fix as a retry meter rather than a peer stop.
- Removing `fix` would affect driver routing, marker handling, session resume, stored tickets, and exhaustion behavior. The Inside redesign does not require that rewrite.
- The new Inside presentation should expose only `scope | impl | uat | review | ship | done`, map a live runtime `fix` back to its causal UAT/Review view, and insert a Fix process immediately after the process that caused recovery.
- Merge is already correctly absent from the lifecycle graph. Ship waits with `blocked_kind = 'awaiting-merge'` until every current PR is literally merged.

## Evidence truth matrix

| Approved fact | Current source | Readiness | Required change |
| --- | --- | --- | --- |
| Scope repositories/worktrees | selected repos, `worktrees` | ready | Aggregate top-level rows and bound detail lists. |
| Implementation phase reports | `phase_marks` | ready as events | Attach future marks to a stable implementation run/segment; do not backfill legacy marks. |
| Implementation switch history | none | missing | Persist one Karst implementation run containing provider/model segments. |
| Implementation tokens | none | missing provider seam | Keep absent until interactive providers expose trustworthy usage; never show zero or estimate it from text. |
| UAT gates | `stage_runs`, `gate_runs` | ready | Include run liveness/stale state and aggregate by process. |
| UAT Services | manifest/current server state | config-only | Render pending configured targets; do not claim historical readiness without a snapshot. |
| UAT Tester | none | missing | Add assignment resolution, execution record, structured result/findings, targets, tokens, and aggregation. |
| Review findings | `review_findings` | mostly ready | Add a Review execution snapshot and distinguish valid findings from execution failure. |
| Fix tokens | `token_usage` / `fix-resume` | partial | Link tokens to a Fix execution and distinguish UAT Fix from Review Fix. |
| Recovery cause/round/cap | stage attempts + live manifest | partial | Persist trigger, round, max-cap snapshot, Fix execution, revalidation, and exhaustion. |
| PR current status | `prs` | ready | Use current-PR ordering; keep identity and status separate. |
| Mergeability | `merge_checks` | ready as current state | Never repurpose it as history. Unknown remains unmerged. |
| Ship commit/push/description history | transient `ShipStepEvent` | missing | Persist a Ship run and per-repo saga evidence as each external step happens. |
| PR description tokens | `token_usage` / `pr-description` | partial | Link to the PR process execution/Ship run. |
| Done receipt | reducible after prerequisites | partial | Gate on actual Done and exclude estimated token rows from “recorded” totals. |

## Persistence findings

The schema is version 25. Existing append-only evidence includes `gate_runs`, `stage_runs`, `phase_marks`, `review_findings`, and `token_usage`; `prs` and `merge_checks` intentionally represent current re-probed state.

New durable evidence should be introduced without fabricating backfills:

- `process_runs`: immutable AI execution identity plus mutable run status/timestamps, linked to ticket/stage/process/attempt and an optional `stage_run_id`.
- `implementation_runs` and `implementation_segments`: one stable Karst run with provider-owned session segments. A provider switch creates a new segment, not a false continuation of the provider's session id.
- `recovery_rounds`: causal trigger, round, snapshotted maximum, Fix execution, revalidation, outcome, and handoff.
- `uat_findings`: structured Tester output linked to its process run.
- `ship_runs`, `ship_repo_steps`, and `ship_commits`: durable per-repo saga/provenance.
- nullable execution links on `phase_marks` and `token_usage`; legacy rows stay null.

Evidence must be written when it happens. A new run row opens before work starts; each result is appended or reconciled immediately; the deterministic stage verdict remains a separate transactional outcome.

## Workflow findings

### Implementation

`agent/sessionSwitch.ts` currently persists the new ticket provider/model, disposes the old terminal, and launches a fresh provider conversation with `allowResume: false`. The design phrase “same session” must therefore mean one stable Karst implementation-run id spanning multiple provider conversations. A new segment becomes recorded only after the provider's `SessionStart` confirms it; a launched terminal is intent, not execution evidence.

Interactive token usage is not instrumented by `instrumentedAdapter.ts`, which decorates `runHeadless` only. Production should omit Implementation totals until a trustworthy provider usage event exists. When added, cumulative provider totals must be converted to per-segment deltas before storage to avoid double counting.

### UAT and Review

UAT currently runs deterministic command gates only. Tester is a new workflow and cannot be represented by the inert `uat.author` config. Review already has an AI findings lane, but execution errors are currently collapsed into a no-findings result. The redesign requires an explicit process-run outcome so a blocking validation result can consume recovery while an agent crash can offer retry without spending a recovery round.

### Recovery

The current cap is re-read from `uat.maxFixAttempts` or `review.maxFixAttempts`, so Settings changes rewrite the meaning of an in-progress loop. The first failing result must atomically create the recovery series with its cap snapshot. Later decisions and display both read that stored cap.

### Ship

Commit, push, description, and PR reconciliation progress is transient. `commitAllIfDirty` returns only a boolean, so it cannot prove pre-Ship commits, dirty-file summary, or the SHA Ship created. External Git/GitHub effects cannot be transactionally atomic with SQLite; the writer must use a durable saga and retries must re-probe Git/GitHub before repeating an operation.

## Webview findings

- Replace the current `renderInside` and its flat `.op` layout rather than adding a parallel component.
- Move `SHIP_STEP_ORDER`, `flattenShipOps`, and `shippingView` business reduction host-side.
- Preserve selected stage and open disclosure ids as webview-only state across `innerHTML` rerenders.
- Render structured link/action objects; never regex-linkify prose or invent URLs/paths in HTML.
- Fold the separate Inside-specific fault/blocked cards into the causal process rows before removing them.
- Reuse the injected design system and token formatting. If agent icons are used, inject `model/agentIdentity.ts` rather than copying SVG/CSS into the dashboard.
- Add executed webview tests using the `node:vm` harness pattern from the diffs webview; the current dashboard tests are primarily source-contract assertions.
- Use the existing 20px design token for the Implementation rail cell so node and edge share one x-coordinate at every width.

## Locked implementation decisions

1. Preserve the runtime `fix` stage in this ticket; project it into the causal UAT/Review Inside view.
2. Define a separate six-member `InsideStageKey`; do not narrow `StageKey` globally.
3. Keep reducers pure and host-owned. The webview receives ordered, preformatted process views.
4. Unknown process ids render generically.
5. Legacy evidence remains partial. Missing history is omitted, never reconstructed.
6. “Recorded tokens” excludes `estimated = 1` rows. Estimates may be shown only when explicitly labeled as estimates outside the Done recorded total.
7. Current PR selection continues to prefer an open PR, otherwise the highest PR number.
8. A merge conflict is waiting/needs-user state, never a failed stage verdict.
9. Implementation provider/model switches create provider segments inside one Karst implementation run.
10. UAT Tester and Review execution crashes do not consume recovery rounds unless a valid blocking result exists.

## Risk register

| Risk | Mitigation |
| --- | --- |
| Orphaning tickets by removing `fix` | Keep the machine/store node; change presentation only. |
| Invented legacy history | Nullable foreign keys, no backfill, omission in reducers. |
| Double-counted interactive tokens | Store provider deltas tied to segments; reject negative/non-numeric deltas. |
| Repeating irreversible Ship work after restart | Open durable step before action, persist result, re-probe external state on retry. |
| Settings rewriting history | Snapshot agent identity and recovery cap at execution start. |
| Webview business-rule drift | Typed evidence unions and host-preformatted copy/order/status. |
| Large repository sets causing horizontal growth | Aggregate top-level processes; bound details at 6 repos/findings and 8 gates. |
| Duplicate error surfaces | Move actions/evidence into process rows, then retire the old cards in the same release. |

## Verification baseline

The focused model/dashboard suite covers `model/inside`, dashboard state/messages/panel, and the dashboard HTML contract. A delegated read-only audit ran 287 focused tests successfully. The implementation plan requires fresh RED/GREEN runs per task plus the full `npm test`, `npm run typecheck`, and `npm run build` gates before completion.
