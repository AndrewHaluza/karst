# RESEARCH — [FIX] legacy Now text on the dashboard (869e883ry)

## Decision

**GO.** High confidence. This is a well-scoped consolidation onto an existing, already-proven pattern — not new architecture.

## Feature Overview

- **Type**: UI consistency bug fix on the dashboard webview.
- **Component**: `src/ui/dashboard/webview.html`, `src/model/inside/*`, `src/workflow/stages/ship.ts`, `src/ui/dashboard/panel.ts`, `src/model/nowLine.ts`.
- **Complexity**: Medium (mechanical, but touches a live message-passing contract and existing tests).

## Codebase findings

The `StageOp`/`StageInside` model (`src/model/inside/types.ts`, `src/model/inside/index.ts`) and its single renderer `renderInside()` (`webview.html:566-592`) already exist and already are the standard for 5 of 6 stages. There is exactly one bypass and one systemic gap:

1. **Ship's live progress bypasses the Inside block entirely.** `ship.ts`'s `onProgress()` emits free-text labels ("Committing changes…", "Writing PR description…", …) that flow through `panel.ts:postShipProgress` → webview `ship-progress` message → `renderShipProgress()`, which overwrites the **Now line** (`#now`), never touching `#inside`. This is the "Writing PR description… → Done" text in the ticket.
2. **No stage synthesizes pending rows before it starts running**, except `scopeInside` (derives rows from `selectedRepos` even with no evidence). `gateOp()` (`gates.ts:45-68`, used by review/uat) only synthesizes `pending` rows once `stageRunning` is true — before that, review/uat also fall back to blurb prose, same gap as ship's pre-run state.
3. **Ship has no static step manifest.** Unlike review/uat (`REVIEW_GATES`/`UAT_GATE` in `src/workflow/gates/scripts.ts`, typed `GateSpec[]`), ship's steps exist only as inline strings inside `onProgress()` calls in `ship.ts` — never exposed to the model layer.
4. Ship's **completed** state (`shipInside`, `index.ts:87-124`) already renders correctly (`pr`/`merge` ops per repo) — this part is not broken.

Reference pattern to extend: `gateOp()`/`gateOps()` in `src/model/inside/gates.ts` — static spec list + synthesized `pending`/`run` rows.

## Scope (confirmed with user)

- **Ship + Review + UAT** all get the "predefined processes shown pending before the stage runs" treatment — not Ship-only. Review/UAT already do this correctly once `stageRunning`; extend backward to the not-yet-started state too, sourced from `REVIEW_GATES`/`UAT_GATE`.
- **Ship granularity**: one `StageOp` row per sub-step per repo (commit, push, describe, open-PR), each transitioning `pending → run → pass/fail` live — not one collapsed row per repo. Matches the gate-stage precedent.
- `impl`/`fix` stay exempt (agent-declared steps, not karst-predefined — confirmed by existing code comments distinguishing "declared, never observed").
- The bottom "Now" line (next-action CTA sentence) stays a distinct concern; only Ship's hijacking of it via `ship-progress`/`shipLabel` is removed. `nowLine.ts`'s existing ship pending/failed prose (lines 86-95) and `'Done.'` terminal text (96-97) are fine as-is — they're the CTA, not a process listing.

## Technical approach

1. Add a static per-repo step manifest for ship (`SHIP_STEPS`-equivalent: commit, push, describe, pr), analogous to `GateSpec`, in the model layer (not `ship.ts`'s imperative flow).
2. Thread `ship.ts`'s existing `onProgress` calls (or a structured replacement) into per-step live state that `shipInside()` can read, so it emits `run`/`pending`/`pass` ops per repo per step while the stage is in flight — same shape it already emits for finished PR/merge rows.
3. Extend `gateOp()`/`reviewInside`/`uatInside` to synthesize `pending` rows from `REVIEW_GATES`/`UAT_GATE` even when `!stageRunning` (currently gated behind `stageRunning`).
4. Retire the parallel channel: `panel.ts:postShipProgress`, webview `shipping`/`shipLabel`/`shipDone`/`renderShipProgress`/`resolveShipping` (`webview.html:436-444, 616-654, 814-835`) once ship's in-flight state is fully representable via `state.inside.ship`.
5. Preserve the evidence-vs-prediction discipline already documented in `model/inside/*.ts` (`note` status, `stageRunning` guards) — pending/running rows are clearly derived from static config or live-not-yet-persisted state, never fabricated as recorded evidence.

## Risks

- `ship.ts`'s `onProgress` signature change touches `ship.test.ts` and `extension.ts:739` call site — needs test updates, not just prod code.
- Removing `shipping`/`shipDone` webview-local state must preserve the "click registers before host round-trip" UX guarantee noted in existing comments.
- Ship has no failed→retry edge distinct from running (per `graph.ts`) — failed-state rendering logic tied to `resolveShipping` needs a new home, not deletion.

## Next steps

Proceed to plan phase for a concrete task breakdown (model layer changes, ship.ts step threading, webview retirement of legacy channel, gate stage pending-row extension), then implement.
