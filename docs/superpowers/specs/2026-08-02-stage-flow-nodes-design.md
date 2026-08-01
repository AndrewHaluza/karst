# Stage flow nodes — segmented track (variant E)

Ticket: 869ecpmwe — [FEAT] Revamp stages flow nodes
Scope: the dashboard stage rail only (`src/ui/dashboard/webview.html`, `src/model/stageRail.ts`, and the state that feeds them).

## Problem

The shipped rail (variant A, `docs/design/stages/variant-a-circuit.html`) draws seven circles joined by lines, with a band underneath carrying `fix` and impl's approach. Four things are wrong with it, in the reporter's own words plus two found while reading the code:

1. **Needs-you is invisible on the rail.** `needsUser` exists and every other surface honours it — glyph, badge, sidebar facet, status bar. The rail comment says so outright: "the rail shows stage status only". A ticket parked on a human at `ship` or `merge` looks identical on the rail to one quietly running.
2. **`fix` reads wrong.** It is drawn as a seventh station hanging under a bracket. It is not a station: `STAGE_GRAPH` reaches `fix` only by a failed verdict and its only outgoing edge returns to `uat`, so nothing can ever be *after* fix and the ticket never leaves the failed gate's neighbourhood.
3. **The collapsed fix toggle is a stray pill.** Because the band is permanent layout for a stage most tickets never enter, the rail needs a `+ fix ⌄` control — a button whose entire job is to announce that nothing is happening.
4. **impl's approach chip is weak beside it.** It is a `<details>` chip docked to the same band, competing with the fix node for the same strip of space.

Two defects found in the code while reading it:

5. **A topology error is shipping.** The CSS comment at `src/ui/dashboard/webview.html` and the rendered label both claim `fix ─pass→ review`. `graph.ts` says `uat`, and the drawn geometry follows the comment, so the rail states a transition the machine does not have.
6. **The rail has a 560px floor** and scrolls sideways below it. A default VS Code side panel is narrower than that.

## Decision

Replace the rail with a **segmented track**: one chevron-segmented object the ticket travels through, rather than seven nodes joined by connectors with a band beneath. Mockup: `docs/design/stages/variant-e-track.html` (8 cases, including a 430px panel). The mockup's needs-you segment draws its button as though it performs the action; the spec below narrows that to a navigational control, and the spec wins.

Three rules carry the whole design.

**The current segment is wide; every other segment is compact.** The stage you are on gets the room to say what it needs — meta, action, phase pips — and the rest give a glyph and a word. This is what makes seven stages fit a narrow panel, and it removes the 560px floor and the sideways scroll with it.

**`fix` is drawn on the gate it is retrying, and drawn nowhere when it has not run.** No band, no node, no toggle, no `fix idle` state. The retried gate carries a **retry meter** inside its own segment: one tick per allowed attempt, filled per attempt spent. Ticks, not a bar — a bar reads as progress toward completion, and spending fix attempts is the opposite. The meter costs zero layout on a ticket that never looped, and it makes "one retry left before this parks" visible; karst shows that nowhere today.

**Needs-you outranks the stage.** A segment whose stage is parked on the user fills amber, carries a pause glyph, states the reason in words, and names the action — four carriers, so colour is never the only one (UI-R28).

### What is deliberately not done

- **The rail never performs an irreversible action.** The needs-you segment's button is navigational: it scrolls the control that owns the action into view and focuses it. It posts no new host message and duplicates no actor. `merge` is per-repo and its confirmation modal lives in the host (`workflow/mergePr.ts`), so a rail-level Merge button could neither pick a repo nor carry the confirmation; making ship's button an actor and merge's a pointer would be two rules where one will do.
- **No new needs-you source.** The rail consults the existing `needsUser` derivation via the state builder. Re-deriving `needsConfirm(stage) && status === 'pending'` inside the rail would create a second answer to a question that must have one.
- **A conflict is never red.** `merge` has no `failed` edge; rendering it red would imply a retry could clear it. Conflicted and awaiting are the same amber state with different words and a warning glyph — the distinction `mergeGateState` already draws for the Now line.

## Model changes

### `src/model/stageRail.ts` — reshaped

`StageRail` today is `{ main, branch, geometry, armed, cap }`. `branch`, `geometry`, `armed` and `cap` all exist to draw the band; all four go.

```ts
export interface RailSegment {
  cell: StepperCell;          // the stage's own row (status, reason, times, attempt)
  current: boolean;           // === ticket.stageCurrent
  needsUser: boolean;         // current && the ticket's needs-you, passed in
  retry: RetryMeter | null;   // present only on the gate that was retried
}

export interface RetryMeter {
  gate: GateStageKey;         // 'uat' | 'review'
  spent: number;              // countFixAttempts(stages, gate)
  cap: number;                // per-gate; see capForGate below
  live: boolean;              // the fix stage is running right now
  returnsTo: StageKey | null; // set only when the loop lands on a different gate
}

export interface StageRail {
  main: RailSegment[];        // MAIN_LINE order, unchanged
}
```

Derivation rules:

- `main` stays `MAIN_LINE.map(cellFor)`. `fix` is still structurally absent from the array — the reason `branch` was a separate field in the first place holds, it just no longer needs a field of its own.
- `retry` attaches to `lastFailedGate(stages)` and stays attached after that gate passes. A spent meter is a **record** of what the ticket cost, and renders dimmed; it is not an alarm. It is absent entirely while `spent === 0`.
- `live` is true when the `fix` stage's own row is running. `fix` is still read out of the stepper (`cellFor(stepper, 'fix')`) — it just no longer leaves as a field of its own.
- `returnsTo` is `STAGE_GRAPH.fix.passed` when `gate !== STAGE_GRAPH.fix.passed`, else `null`. Derived, never hardcoded: the shipped rail hardcoded this and got it wrong. Today that means the meter on `review` says `↩ uat` and the meter on `uat` says nothing, because returning to where you already are is not information.
- `needsUser` is a passed-in boolean, true on the current segment only.

### `src/workflow/fixAttempts.ts` — one new export

`driveTicket.ts:40` owns the per-gate cap rule (`uat` honours `manifest.uat.maxFixAttempts`, `review` keeps `FIX_ATTEMPT_CAP` until its own redesign). The meter must draw exactly that number of ticks or it lies about the budget. Extract the rule so both callers share it rather than the rail growing a second copy:

```ts
export function capForGate(gate: GateStageKey, uatMax?: number): number
```

`driveTicket` calls it in place of its inline conditional. No behaviour change there.

### `src/ui/dashboard/state.ts` — two threads

- Compute needs-you once: `needsUser(ticket)` (already imported by the badge path) and pass it with `ticket.stageCurrent` into `buildStageRail`.
- Add an injected `fixCapFor: (gate: GateStageKey) => number = () => FIX_ATTEMPT_CAP`, bound by the host to `capForGate(gate, manifest.uat?.maxFixAttempts)`. The state builder never reads the manifest — this follows the existing `approachPhases` / `isRepoRunnable` injection convention, and the default degrades to the graph's own cap rather than to a wrong number.
- `approach` and `inside` are unchanged. The impl segment's pips read the declared phases from `state.approach.phases`; the filled ones come from the phase marks the Inside strip already derives (`reportedPhases`: this stage, this attempt, each phase at its first mark). Export that helper from `model/inside/agent.ts` rather than re-deriving it — two answers to "which phase is the agent in" is the same class of bug as two answers to needs-you. With no marks, every pip renders hollow and the caption is the approach id alone; declared is not observed and the pips must not claim otherwise.

## Webview changes

`renderRail` and `renderApproach` are replaced by one `renderTrack`. Deleted: the `.loop` band and everything in it (`.drop`, `.ret`, `.retlbl`, `.faillbl`, `.fixnode`, `.implstem`, `.approach` details chip, `.noapproach`), the `fixtoggle` control and the `fixExpanded` webview state, the `--cols/--impl/--uat/--review` calc geometry, and the 560px `min-width`.

Structure per segment, following the mockup:

- A `<div class="seg">` **wrapper** carrying the chevron `clip-path`, the stage-hue wash and the status class. It is a `div` because a `<button>` may not contain a `<button>`: nested, the parser closes the outer one and the track loses its structure.
- An absolutely-positioned `<button class="pick">` filling the wrapper, so the whole segment is the selection hit area. `aria-pressed` for selection, `aria-label` and `title` carrying the same string (UI-R21/R24): stage title, status, and — when a meter is present — `fix attempt N of M` plus whether it is running. A screen-reader user must not have to infer a live retry from a meter they cannot see.
- Siblings with `pointer-events:auto` for the two real controls: the needs-you action button, and the retry meter.
- **The retry meter is itself a `<button data-stage="fix">`.** It is how `fix` stays selectable now that the node is gone — the Inside strip for `fix` is still built and still has content, and this is where a user would look for it.

Segment content by state:

| State | Segment shows |
|---|---|
| pending | glyph `·`, name |
| running | spinner, name, meta |
| passed | `✓`, name, duration |
| failed (gate) | `✕`, name, hatched wash in the failure token, retry meter |
| skipped | `–`, name |
| needs-you | pause glyph `❚❚` (or `⚠` when conflicted), name, reason, action button, amber wash |
| current + impl | name, one pip per declared phase, reported ones filled, latest reported phase name |

Degradation is two steps, measured rather than a breakpoint, because the threshold depends on the current stage's name length and on whether a meter is riding along:

1. **snug** — compact segments drop annotations (duration, the meter's numeral) and keep every stage name.
2. **tight** — compact segments also drop names, keeping the glyph. The current segment always says everything.

The single measurement is `lane.scrollWidth > lane.clientWidth`, re-run on `resize`, on the next animation frame, on `load` and on `fonts.ready`. Nothing is *positioned* from a measured rect — that was the earlier draft's weakest point against a codebase whose geometry is derived CSS.

Motion: the spinner and the needs-you breathe are both dropped under `prefers-reduced-motion` (UI-R30). The wash transition is a token duration.

Every value is a `--k-*` token (UI-R04/R05): the stage ramp via the existing `stg-<stage>` classes, the status ramp for needs-you/failed, and the design system's spacing, radius and duration tokens. No hex, no raw px, no second definition of a ramp.

## Testing

TDD, RED first, per the repo's workflow.

**`src/model/stageRail.test.ts`** (rewritten):
- `main` is `MAIN_LINE` order and never contains `fix`.
- No meter before any gate fails; meter on `uat` after a uat failure; meter stays after the gate passes, with `live: false`.
- `spent` is per-gate, not summed across uat and review (the bug `countFixAttempts` was written to fix).
- `cap` comes from the injected resolver — a narrowed `uat.maxFixAttempts` changes the tick count.
- `returnsTo` is `'uat'` for a review retry and `null` for a uat retry, and is read from `STAGE_GRAPH`, not a literal.
- `needsUser` lands on the current segment and no other.

**`src/workflow/fixAttempts.test.ts`**: `capForGate` honours `uatMax` for uat and ignores it for review.

**`src/ui/dashboard/state.test.ts`**: a ticket parked pending at `ship` produces a rail whose ship segment has `needsUser: true`; a ticket with `agentState: 'waiting'` at `impl` puts it on impl.

**`src/ui/dashboard/webview.test.ts`**: the existing mirror pins keep passing untouched (UI-R34 — none of `SECTION_FIELDS`, `TICKET_TYPES`, `CONVENTION_PRESETS`, `TRANSFORM_NAMES`, `deriveKey`, `MAX_PASTE_BYTES`, `briefToText` is touched). New pins: the track markup contains no nested `<button>`; every segment's `pick` carries matching `aria-label` and `title`; a segment with a meter carries the attempt count in its accessible name.

**`src/ui/designSystem.test.ts`** and **`src/ui/webviewCsp.test.ts`** are unchanged and must stay green — the dashboard is a discovered directory in both.

## Out of scope

Sidebar chips, the onboarding stepper, the status bar, the Inside strip's content, the ship/merge strips, and the Now line. The rail's inputs (`stepper`, `needsUser`, `countFixAttempts`) are all existing derivations; nothing outside `model/stageRail.ts`, `workflow/fixAttempts.ts`, `ui/dashboard/state.ts` and the dashboard webview changes shape.

## Risks

- **`fix` becomes harder to find.** Mitigated by making the meter the control, but a user who knows the old node is gone will look for it. Accepted: the meter is on the stage the loop belongs to, which is where it should have been.
- **The measured degradation is the one non-derived piece.** It only toggles two classes and cannot detach anything, but it is still a measurement in a codebase that avoids them. Accepted as the price of killing the 560px floor.
- **Two entry points to one selection** (`pick` and the meter's `data-stage="fix"`) inside one segment. Both post the existing selection message; no new host handler.
