# Stage flow nodes — segmented track Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the dashboard's seven-node stage rail plus its fix/approach band with one chevron-segmented track in which the current stage is wide, `fix` is a retry meter on the gate it retries, and a stage parked on the user reads amber.

**Architecture:** The host keeps owning every derivation and every string. `src/model/stageRail.ts` is reshaped from `{main, branch, geometry, armed, cap}` into `{main: RailSegment[]}`, where each segment carries its stepper cell, whether it is current, whether it needs the user, the host-rendered needs-you copy, and — on the gate that was retried — a `RetryMeter`. `src/ui/dashboard/state.ts` threads three existing derivations in (`needsUser`, `ticket.stageCurrent`, a per-gate cap resolver injected the same way `approachPhases` already is) and gains one new one (`railNeeds`, the needs-you wording). The webview replaces `renderRail` + `renderApproach` with a single `renderTrack` and one measured three-step degradation that only ever toggles CSS classes.

**Tech Stack:** TypeScript (ESM, `moduleResolution: Bundler`, `.js` import suffixes), vitest, standalone HTML webview (no framework, no bundler, CSP `default-src 'none'`).

## Global Constraints

- **TDD, RED first.** Every task writes a failing test, runs it to see it fail, implements, re-runs, commits. Conventional commit messages (`feat:`, `fix:`, `refactor:`, `docs:`, `test:`).
- **`vscode` is not a runtime dependency.** Nothing in `src/model/`, `src/workflow/` or `src/ui/dashboard/state.ts` may import it. Only `panel.ts`'s host wrapper and `extension.ts` bind vscode.
- **Tokens are the only legal style values (UI-R04/R05).** No hex, no `rgba()`, no raw px/rem/radius/shadow/duration in the webview CSS. Spacing scale is closed: `--k-space-0..9` = `0,2px,4px,6px,8px,10px,12px,16px,20px,26px`. Radii: `--k-radius-xs 3px`, `sm 5px`, `md 6px`, `lg 9px`, `xl 12px`, `pill 999px`, `circle 50%`. Text: `--k-text-2xs 10px`, `xs 11px`, `sm 11.5px`, `md 12px`, `base`, `lg 14px`. Durations: `--k-dur-fast 120ms`, `base 180ms`, `slow 280ms`, `spin 900ms`, `flash-done 2400ms`. The one permitted exception is a **component dimension** (a height, a notch depth, a tick size) declared as a local `--trk-*` custom property with a comment saying so — the same exception the deleted `min-width:560px` rule documented.
- **Stage hue comes from `stg-<stage>` / `--stg-color`** (`src/model/stagePalette.ts`), status colour from the `--k-*` ramp (`src/model/palette.ts`). Neither ramp may be redefined in the webview.
- **Every new CSS selector in the track block is scoped under `.track`.** The dashboard already owns `.act` (the activity strip), `.phead`/`.phrow`/`.pbody`, and `.seg` (the old connector). Unscoped new names collide silently.
- **Colour is never the only carrier (UI-R28).** Needs-you carries wash + glyph + word + action. Failed carries wash + hatch + glyph.
- **Icon-only controls carry `aria-label` and `title` with the same string, ≤80 chars (UI-R19–R21/R24).**
- **The rail performs no irreversible action and posts no new host message.** Its two controls are local: select a stage, and scroll/focus the control that owns the needs-you action.
- **Mirrored TS→HTML constants must not be touched (UI-R34):** `SECTION_FIELDS`, `TICKET_TYPES`, `CONVENTION_PRESETS`, `TRANSFORM_NAMES`, `deriveKey`/`TITLE_KEY_MAX`, `MAX_PASTE_BYTES`, `briefToText`. None of them is in the dashboard webview; if a test touching them changes, something went wrong.
- **Verify with:** `npm test`, `npm run typecheck`. Single file: `npx vitest run src/path/to.test.ts`.
- **Spec:** `docs/superpowers/specs/2026-08-02-stage-flow-nodes-design.md`. Mockup and empirical width record: `docs/design/stages/variant-e-track.html`.

---

## File Structure

**Modified**

| File | Responsibility after this plan |
|---|---|
| `src/workflow/fixAttempts.ts` | Gains `capForGate` — the one per-gate cap rule, previously inline in `driveTicket.ts`. |
| `src/workflow/driveTicket.ts` | Calls `capForGate` instead of its inline conditional. No behaviour change. |
| `src/model/inside/agent.ts` | `reportedPhases` becomes exported. Body unchanged. |
| `src/model/stageRail.ts` | Reshaped to `{main: RailSegment[]}` with `RetryMeter`. Loses `branch`, `geometry`, `armed`, `cap`. |
| `src/ui/dashboard/state.ts` | Threads `needsUser`, `stageCurrent`, injected `fixCapFor`, and `approach.reported` into the state. |
| `src/ui/dashboard/panel.ts` | Passes a `fixCapFor` dep through to `buildDashboardState`. |
| `src/extension.ts` | Binds `fixCapFor` to the live manifest's `uat.maxFixAttempts`. |
| `src/ui/dashboard/webview.html` | Track CSS replaces rail/band CSS; `renderTrack` replaces `renderRail` + `renderApproach`; `fixExpanded` and the fix toggle are deleted. |
| `src/model/stageRail.test.ts` | Rewritten for the new shape. |
| `src/ui/dashboard/state.test.ts` | Gains needs-you / cap / reported-phase cases. |
| `src/ui/dashboard/webview.test.ts` | Old band pins retired; track, a11y and narrow-width pins added. |

**Created**

| File | Responsibility |
|---|---|
| `src/model/railNeeds.ts` | Renders the needs-you segment's copy (`detail`, `action`) from the stage, the merge gate and the agent state. Host-side, vscode-free, ~60 lines. |
| `src/model/railNeeds.test.ts` | Its tests. |

**Deleted** — nothing as a whole file. Within `webview.html`: the `.loop` band and every rule in it (`.drop`, `.ret`, `.retlbl`, `.faillbl`, `.fixnode`, `.implstem`, `.approach`, `.noapproach`, `.phrow`), `.fixtoggle`, `.st`/`.node`/`.lbl`/`.meta` and the `--cols/--impl/--uat/--review` calc geometry, `min-width:560px`, `segClass`, `renderApproach`, `fixExpanded` and its toggle/persistence.

---

### Task 1: `capForGate` — one per-gate cap rule

The retry meter must draw exactly as many ticks as the driver will actually spend, or it lies about the budget. `driveTicket.ts` owns that rule inline today; extract it so the rail cannot grow a second copy.

**Files:**
- Modify: `src/workflow/fixAttempts.ts`
- Modify: `src/workflow/driveTicket.ts` (the `cap` line inside `fixResumeDecision`)
- Test: `src/workflow/fixAttempts.test.ts`

**Interfaces:**
- Consumes: `FIX_ATTEMPT_CAP`, `GateStageKey` (both already in `fixAttempts.ts`).
- Produces: `export function capForGate(gate: GateStageKey, uatMax?: number): number` — used by Task 6 (`extension.ts`) and, through the injected resolver, by Tasks 3 and 5.

- [ ] **Step 1: Write the failing test**

Append to `src/workflow/fixAttempts.test.ts` (add `capForGate` to the existing import from `./fixAttempts.js`):

```ts
describe('capForGate', () => {
  it('honours a narrowed uat budget', () => {
    expect(capForGate('uat', 1)).toBe(1);
  });

  it('falls back to the default cap when uat declares no budget', () => {
    expect(capForGate('uat', undefined)).toBe(FIX_ATTEMPT_CAP);
  });

  it('ignores uatMax for review — only UAT s budget is configurable', () => {
    // `uat.maxFixAttempts` can never narrow a gate it does not name; review
    // keeps the default until its own redesign.
    expect(capForGate('review', 1)).toBe(FIX_ATTEMPT_CAP);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/workflow/fixAttempts.test.ts`
Expected: FAIL — `capForGate is not exported by ./fixAttempts.js` (or `capForGate is not defined`).

- [ ] **Step 3: Write minimal implementation**

Add to `src/workflow/fixAttempts.ts`, directly above `fixAttemptsRemain`:

```ts
/**
 * The fix budget for ONE gate. Only UAT's is configurable — `uat.maxFixAttempts`
 * can never narrow a gate it does not name, and review keeps the default until
 * its own redesign.
 *
 * Extracted from `fixResumeDecision` so the driver (which spends the budget) and
 * the rail's retry meter (which draws one tick per allowed attempt) resolve the
 * same number. A meter with more ticks than the driver will spend is a lie about
 * how many retries are left, which is the one thing the meter exists to say.
 */
export function capForGate(gate: GateStageKey, uatMax?: number): number {
  return gate === 'uat' ? (uatMax ?? FIX_ATTEMPT_CAP) : FIX_ATTEMPT_CAP;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/workflow/fixAttempts.test.ts`
Expected: PASS.

- [ ] **Step 5: Use it in the driver**

In `src/workflow/driveTicket.ts`, inside `fixResumeDecision`, replace:

```ts
  // Only UAT's budget is configurable; review keeps the default until its own
  // redesign, so `uat.maxFixAttempts` can never narrow a gate it does not name.
  const cap = gate === 'uat' ? (manifest?.uat?.maxFixAttempts ?? FIX_ATTEMPT_CAP) : FIX_ATTEMPT_CAP;
```

with:

```ts
  const cap = capForGate(gate, manifest?.uat?.maxFixAttempts);
```

and add `capForGate` to the existing import from `./fixAttempts.js`. If `FIX_ATTEMPT_CAP` is now unused in that file, drop it from the import — `noUnusedLocals` is not on, but the typecheck-clean rule is.

- [ ] **Step 6: Run the driver's own tests to prove no behaviour changed**

Run: `npx vitest run src/workflow/driveTicket.test.ts src/workflow/fixAttempts.test.ts`
Expected: PASS, with no test edited.

- [ ] **Step 7: Commit**

```bash
git add src/workflow/fixAttempts.ts src/workflow/fixAttempts.test.ts src/workflow/driveTicket.ts
git commit -m "refactor: extract capForGate so the driver and the rail share one cap rule"
```

---

### Task 2: Export `reportedPhases`

The impl segment's pips fill from phase marks. The Inside strip already derives exactly which marks this render is entitled to use; a second derivation would be two answers to "which phase is the agent in".

**Files:**
- Modify: `src/model/inside/agent.ts:79` (the `function reportedPhases` line only)
- Test: `src/model/inside/agent.test.ts` — if that file does not exist, use `src/model/inside/index.test.ts`; the assertion is the same.

**Interfaces:**
- Produces: `export function reportedPhases(marks: readonly PhaseMark[], cell: StepperCell): PhaseMark[]` — consumed by Task 5 (`state.ts`).

- [ ] **Step 1: Write the failing test**

Add to the inside test file (importing `reportedPhases` from `./agent.js`, and `PhaseMark` from `../../store/phaseMarks.js`):

```ts
describe('reportedPhases', () => {
  const mark = (id: number, phaseName: string, attempt = 0): PhaseMark => ({
    id,
    ticketId: 1,
    stageKey: 'impl',
    attempt,
    phaseName,
    markedAt: '2026-08-02T10:00:00.000Z',
  });

  it('is exported so the rail and the strip cannot disagree about the phase', () => {
    const cell = { stageKey: 'impl', status: 'running' } as StepperCell;
    expect(reportedPhases([mark(2, 'plan'), mark(1, 'research')], cell).map((m) => m.phaseName))
      .toEqual(['research', 'plan']);
  });

  it('reports a repeated phase once, at its first mark', () => {
    const cell = { stageKey: 'impl', status: 'running' } as StepperCell;
    const out = reportedPhases([mark(1, 'research'), mark(2, 'plan'), mark(3, 'research')], cell);
    expect(out.map((m) => m.phaseName)).toEqual(['research', 'plan']);
    expect(out[0]!.id).toBe(1);
  });

  it('ignores marks from another attempt', () => {
    const cell = { stageKey: 'impl', status: 'running', attempt: 1 } as StepperCell;
    expect(reportedPhases([mark(1, 'research', 0)], cell)).toEqual([]);
  });
});
```

If the real `PhaseMark` has different field names, read `src/store/phaseMarks.ts` and match it exactly rather than casting.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/model/inside/`
Expected: FAIL — `reportedPhases is not exported`.

- [ ] **Step 3: Write minimal implementation**

In `src/model/inside/agent.ts`, change the declaration only:

```ts
export function reportedPhases(marks: readonly PhaseMark[], cell: StepperCell): PhaseMark[] {
```

Leave the doc comment and the body untouched.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/model/inside/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/model/inside/agent.ts src/model/inside/*.test.ts
git commit -m "refactor: export reportedPhases so the rail reads the strip's derivation"
```

---

### Task 3: Reshape `StageRail`

**Files:**
- Modify: `src/model/stageRail.ts` (rewrite)
- Test: `src/model/stageRail.test.ts` (rewrite)

**Interfaces:**
- Consumes: `MAIN_LINE`, `STAGE_GRAPH` (`../workflow/graph.js`); `FIX_ATTEMPT_CAP`, `lastFailedGate`, `countFixAttempts`, `GateStageKey` (`../workflow/fixAttempts.js`); `StepperCell` (`./stepper.js`); `StageKey` (`./types.js`); `RailNeeds` (Task 4 — do Task 4 first, or stub the import and finish this task after it).
- Produces: `RailSegment`, `RetryMeter`, `StageRail`, and

```ts
export function buildStageRail(
  stepper: readonly StepperCell[],
  stages: readonly { stageKey: string; status?: string; endedAt?: string | null; attempt?: number }[],
  opts: BuildRailOptions,
): StageRail
```

where

```ts
export interface BuildRailOptions {
  current: string | null;
  needsUser: boolean;
  needs: RailNeeds | null;
  capFor?: (gate: GateStageKey) => number;
}
```

Consumed by Task 5 (`state.ts`) and Task 8 (the webview, via the pushed state).

- [ ] **Step 1: Write the failing test**

Replace the whole of `src/model/stageRail.test.ts` with:

```ts
import { describe, it, expect } from 'vitest';
import { MAIN_LINE, STAGE_GRAPH } from '../workflow/graph.js';
import { FIX_ATTEMPT_CAP } from '../workflow/fixAttempts.js';
import { buildStepper, type StepperStageRow } from './stepper.js';
import { buildStageRail } from './stageRail.js';
import type { StageKey, StageStatus } from './types.js';

type Row = { stageKey: StageKey; status: StageStatus; attempt?: number; endedAt?: string };

function rail(rows: Row[], opts: Partial<Parameters<typeof buildStageRail>[2]> = {}) {
  const stages: StepperStageRow[] = rows.map((r) => ({ ...r }));
  return buildStageRail(buildStepper(stages), stages, {
    current: null,
    needsUser: false,
    needs: null,
    ...opts,
  });
}

const seg = (r: ReturnType<typeof rail>, k: StageKey) => r.main.find((s) => s.cell.stageKey === k)!;

describe('buildStageRail', () => {
  it('lays the main line out in MAIN_LINE order and never contains fix', () => {
    // The bug the rail exists to fix: `fix` is reached only by a failed verdict
    // and its only edge returns to uat, so a forward slot for it claims a path
    // the graph does not have.
    const r = rail([]);
    expect(r.main.map((s) => s.cell.stageKey)).toEqual([...MAIN_LINE]);
    expect(r.main.map((s) => s.cell.stageKey)).not.toContain('fix');
  });

  it('carries no retry meter before any gate has failed', () => {
    // A meter on an untravelled ticket would reserve layout — and attention —
    // for a loop most tickets never enter.
    const r = rail([{ stageKey: 'impl', status: 'running' }]);
    expect(r.main.every((s) => s.retry === null)).toBe(true);
  });

  it('attaches the meter to the gate that failed, not to fix', () => {
    const r = rail([
      { stageKey: 'uat', status: 'failed', attempt: 2, endedAt: '2026-08-02T10:00:00.000Z' },
    ]);
    expect(seg(r, 'uat').retry).toMatchObject({ gate: 'uat', spent: 2, cap: FIX_ATTEMPT_CAP });
    expect(seg(r, 'review').retry).toBeNull();
  });

  it('counts attempts per gate, never summed across uat and review', () => {
    // The bug countFixAttempts was written to fix: two review failures must not
    // spend UAT's budget.
    const r = rail([
      { stageKey: 'uat', status: 'passed', attempt: 1, endedAt: '2026-08-02T09:00:00.000Z' },
      { stageKey: 'review', status: 'failed', attempt: 2, endedAt: '2026-08-02T10:00:00.000Z' },
    ]);
    expect(seg(r, 'review').retry?.spent).toBe(2);
  });

  it('reads the cap from the injected resolver, so a narrowed uat budget shows fewer ticks', () => {
    const r = rail(
      [{ stageKey: 'uat', status: 'failed', attempt: 1, endedAt: '2026-08-02T10:00:00.000Z' }],
      { capFor: (gate) => (gate === 'uat' ? 1 : FIX_ATTEMPT_CAP) },
    );
    expect(seg(r, 'uat').retry?.cap).toBe(1);
  });

  it('defaults the cap to the graph s own, never to a guess', () => {
    const r = rail([
      { stageKey: 'uat', status: 'failed', attempt: 1, endedAt: '2026-08-02T10:00:00.000Z' },
    ]);
    expect(seg(r, 'uat').retry?.cap).toBe(FIX_ATTEMPT_CAP);
  });

  it('marks the meter live only while fix is actually running', () => {
    const running = rail([
      { stageKey: 'uat', status: 'failed', attempt: 1, endedAt: '2026-08-02T10:00:00.000Z' },
      { stageKey: 'fix', status: 'running' },
    ]);
    expect(seg(running, 'uat').retry?.live).toBe(true);

    const idle = rail([
      { stageKey: 'uat', status: 'failed', attempt: 1, endedAt: '2026-08-02T10:00:00.000Z' },
      { stageKey: 'fix', status: 'passed' },
    ]);
    expect(seg(idle, 'uat').retry?.live).toBe(false);
  });

  it('keeps the meter after the gate passes — a spent meter is a record, not an alarm', () => {
    const r = rail([
      { stageKey: 'uat', status: 'passed', attempt: 2, endedAt: '2026-08-02T10:00:00.000Z' },
      { stageKey: 'fix', status: 'passed' },
      { stageKey: 'ship', status: 'pending' },
    ]);
    // lastFailedGate needs a failure to name a gate, so a ticket whose only
    // record is a spent attempt still reports it.
    expect(seg(r, 'uat').retry).toMatchObject({ spent: 2, live: false });
  });

  it('reads returnsTo from the graph, and says nothing when the loop lands where it left', () => {
    // The shipped rail hardcoded `pass → review`; the graph says uat.
    const review = rail([
      { stageKey: 'review', status: 'failed', attempt: 1, endedAt: '2026-08-02T10:00:00.000Z' },
    ]);
    expect(seg(review, 'review').retry?.returnsTo).toBe(STAGE_GRAPH.fix.passed);
    expect(seg(review, 'review').retry?.returnsTo).toBe('uat');

    const uat = rail([
      { stageKey: 'uat', status: 'failed', attempt: 1, endedAt: '2026-08-02T10:00:00.000Z' },
    ]);
    expect(seg(uat, 'uat').retry?.returnsTo).toBeNull();
  });

  it('marks exactly one segment current', () => {
    const r = rail([{ stageKey: 'impl', status: 'running' }], { current: 'impl' });
    expect(r.main.filter((s) => s.current).map((s) => s.cell.stageKey)).toEqual(['impl']);
  });

  it('marks no segment current when the ticket sits at a stage off the main line', () => {
    // A ticket AT `fix` has no forward segment to highlight, and highlighting
    // the gate it came from would claim the ticket is there.
    const r = rail([{ stageKey: 'fix', status: 'running' }], { current: 'fix' });
    expect(r.main.some((s) => s.current)).toBe(false);
  });

  it('lands needs-you on the current segment and nowhere else', () => {
    const r = rail([{ stageKey: 'ship', status: 'pending' }], {
      current: 'ship',
      needsUser: true,
      needs: { detail: '2 repos ready', action: 'Confirm ship' },
    });
    expect(seg(r, 'ship')).toMatchObject({ needsUser: true });
    expect(seg(r, 'ship').needs).toEqual({ detail: '2 repos ready', action: 'Confirm ship' });
    expect(r.main.filter((s) => s.needsUser)).toHaveLength(1);
    expect(seg(r, 'merge').needs).toBeNull();
  });

  it('never marks needs-you without a current segment to carry it', () => {
    const r = rail([], { current: null, needsUser: true, needs: { detail: 'x', action: 'y' } });
    expect(r.main.some((s) => s.needsUser)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/model/stageRail.test.ts`
Expected: FAIL — `buildStageRail` takes two arguments and returns the old shape; most assertions error on `s.cell` being undefined.

- [ ] **Step 3: Write the implementation**

Replace the whole of `src/model/stageRail.ts` with:

```ts
import { MAIN_LINE, STAGE_GRAPH } from '../workflow/graph.js';
import {
  FIX_ATTEMPT_CAP,
  countFixAttempts,
  lastFailedGate,
  type GateStageKey,
} from '../workflow/fixAttempts.js';
import type { RailNeeds } from './railNeeds.js';
import type { StepperCell } from './stepper.js';
import type { StageKey } from './types.js';

export type { RailNeeds };

/**
 * The fix loop, drawn on the gate it retries.
 *
 * `fix` is not a station: STAGE_GRAPH reaches it only by a failed verdict and
 * its only outgoing edge returns to `uat`, so nothing can ever be AFTER fix and
 * the ticket never leaves the failed gate's neighbourhood. Drawing it as a
 * seventh node bought permanent layout for a stage most tickets never enter.
 *
 * Ticks, not a bar: a bar reads as progress toward completion, and spending fix
 * attempts is the opposite of progress.
 */
export interface RetryMeter {
  /** The gate whose budget this spends — the loop belongs to it, not to fix. */
  gate: GateStageKey;
  /** Attempts spent, per gate (never summed across uat and review). */
  spent: number;
  /** Attempts allowed for THIS gate — one tick each. */
  cap: number;
  /** The fix stage is running right now. A spent-but-idle meter is a record. */
  live: boolean;
  /**
   * Where the loop lands, when that is not the gate it left. Derived from the
   * graph, never written down: the shipped rail hardcoded `pass → review` and
   * the graph says `uat`. Null when the loop returns where it already is —
   * returning to where you are is not information.
   */
  returnsTo: StageKey | null;
}

/** One segment of the track: a stage, plus everything drawn inside it. */
export interface RailSegment {
  cell: StepperCell;
  /** This is the stage the ticket sits at. Exactly one, or none. */
  current: boolean;
  /** The ticket is blocked on the user, here. Only ever the current segment. */
  needsUser: boolean;
  /** Host-rendered needs-you copy; null unless `needsUser`. */
  needs: RailNeeds | null;
  /** The retry loop, on the gate that was retried; null everywhere else. */
  retry: RetryMeter | null;
}

/**
 * The stage graph as it is drawn: one track the ticket travels through.
 *
 * `fix` stays structurally absent from `main` — the reason the old `branch`
 * field existed still holds. It just no longer needs a field of its own, because
 * it is now drawn INSIDE the gate it retries.
 */
export interface StageRail {
  main: RailSegment[];
}

export interface BuildRailOptions {
  /** `ticket.stageCurrent`. A stored string: it may name no main-line stage. */
  current: string | null;
  /** The ticket's existing needs-you derivation (`model/ticketGlyph.ts`). */
  needsUser: boolean;
  /** The words for it, rendered host-side. */
  needs: RailNeeds | null;
  /**
   * The fix budget for one gate. Injected so the manifest's
   * `uat.maxFixAttempts` reaches the meter without this module reading a
   * manifest; the default is the graph's own cap, never a guess.
   */
  capFor?: (gate: GateStageKey) => number;
}

/** A cell for a stage that has no row yet — the pre-run default. */
function pending(stageKey: StageKey): StepperCell {
  return { stageKey, status: 'pending' };
}

function cellFor(stepper: readonly StepperCell[], stageKey: StageKey): StepperCell {
  return stepper.find((c) => c.stageKey === stageKey) ?? pending(stageKey);
}

/**
 * The meter for the gate that was retried, or null.
 *
 * Attached to `lastFailedGate` and left attached after that gate passes: the
 * spent attempts are what the ticket COST, and that stays true once it is green.
 */
function meterFor(
  stages: BuildStages,
  fixRunning: boolean,
  capFor: (gate: GateStageKey) => number,
): RetryMeter | null {
  const gate = lastFailedGate(stages);
  if (!gate) return null;
  const spent = countFixAttempts(stages, gate);
  if (spent === 0) return null;
  const returnsTo = STAGE_GRAPH.fix.passed ?? null;
  return {
    gate,
    spent,
    cap: capFor(gate),
    live: fixRunning,
    returnsTo: returnsTo === gate ? null : returnsTo,
  };
}

type BuildStages = readonly {
  stageKey: string;
  status?: string;
  endedAt?: string | null;
  attempt?: number;
}[];

/**
 * Split a flat stepper into the shape the track is drawn in.
 *
 * `buildStepper` keeps its canonical 8-cell projection — that is correct, and
 * onboarding relies on it. This is the dashboard's view on top of it.
 */
export function buildStageRail(
  stepper: readonly StepperCell[],
  stages: BuildStages,
  opts: BuildRailOptions,
): StageRail {
  const capFor = opts.capFor ?? (() => FIX_ATTEMPT_CAP);
  const meter = meterFor(stages, cellFor(stepper, 'fix').status === 'running', capFor);

  return {
    main: MAIN_LINE.map((k): RailSegment => {
      const current = opts.current === k;
      const needsUser = current && opts.needsUser;
      return {
        cell: cellFor(stepper, k),
        current,
        needsUser,
        needs: needsUser ? opts.needs : null,
        retry: meter && meter.gate === k ? meter : null,
      };
    }),
  };
}
```

A note on `lastFailedGate` in the "keeps the meter after the gate passes" case: it selects rows whose `status === 'failed'`. A gate that failed and then passed has one row, now `passed`, so `lastFailedGate` returns null and the meter would vanish. If that test fails at Step 4, fix it in `meterFor` — not in the test — by falling back to the gate with the highest `attempt` among `GATE_STAGES` when `lastFailedGate` returns null:

```ts
function retriedGate(stages: BuildStages): GateStageKey | null {
  const failed = lastFailedGate(stages);
  if (failed) return failed;
  // A gate that failed and then PASSED has one row, now green — but its
  // `attempt` still records what the ticket cost, and that stays true.
  const spent = (['uat', 'review'] as const)
    .map((g) => ({ gate: g, n: countFixAttempts(stages, g) }))
    .filter((x) => x.n > 0);
  if (spent.length === 0) return null;
  return spent.reduce((a, b) => (b.n > a.n ? b : a)).gate;
}
```

and call `retriedGate` from `meterFor` in place of `lastFailedGate`. Keep `GATE_STAGES` imported from `../workflow/graph.js` rather than re-listing the two keys if the type narrows cleanly; a literal tuple is acceptable here because `GateStageKey` is defined by one.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/model/stageRail.test.ts`
Expected: PASS (all 13). Typecheck will still fail elsewhere — `state.ts` calls the old signature; Task 5 fixes it.

- [ ] **Step 5: Commit**

```bash
git add src/model/stageRail.ts src/model/stageRail.test.ts
git commit -m "feat: reshape StageRail into segments with a per-gate retry meter"
```

---

### Task 4: `railNeeds` — the needs-you wording

The segment must state the reason and name the action (UI-R28: four carriers, not colour alone). Copy is rendered host-side, like every other dashboard string, because the webview is standalone HTML and cannot import a formatter. This is a **new module rather than a field on the Now line** because the Now line is a sentence with room to explain and a segment has room for three or four words; merging them would force one of the two to be wrong.

**Files:**
- Create: `src/model/railNeeds.ts`
- Test: `src/model/railNeeds.test.ts`

**Interfaces:**
- Consumes: `MergeGateState` from `../workflow/mergeGate.js` — read that file for its exact exported type name and shape before writing the import; its `kind` is one of `'conflicted' | 'awaiting' | 'merged' | 'nothing-to-merge'` and the first two carry `repos: string[]`.
- Produces:

```ts
export interface RailNeeds { detail: string; action: string }
export function railNeeds(input: RailNeedsInput): RailNeeds | null
export interface RailNeedsInput {
  stage: string | null;
  agentWaiting: boolean;
  mergeGate: MergeGateState | null;
}
```

Consumed by Task 3 (type only) and Task 5 (call site).

- [ ] **Step 1: Write the failing test**

Create `src/model/railNeeds.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { railNeeds } from './railNeeds.js';

describe('railNeeds', () => {
  it('says the agent is waiting, and names the way back to it', () => {
    expect(railNeeds({ stage: 'impl', agentWaiting: true, mergeGate: null })).toEqual({
      detail: 'the agent asked you something',
      action: 'Open session',
    });
  });

  it('lets the waiting agent outrank the stage — it is the live question', () => {
    // A waiting agent at ship is still a question on screen right now.
    expect(railNeeds({ stage: 'ship', agentWaiting: true, mergeGate: null })?.action)
      .toBe('Open session');
  });

  it('names the confirm at ship', () => {
    expect(railNeeds({ stage: 'ship', agentWaiting: false, mergeGate: null })).toEqual({
      detail: 'ready to open the PRs',
      action: 'Confirm ship',
    });
  });

  it('names the merge, with the repo count that is still waiting', () => {
    expect(
      railNeeds({
        stage: 'merge',
        agentWaiting: false,
        mergeGate: { kind: 'awaiting', repos: ['a', 'b'] } as never,
      }),
    ).toEqual({ detail: '2 repos to merge', action: 'Merge' });
  });

  it('uses the singular for one repo', () => {
    expect(
      railNeeds({
        stage: 'merge',
        agentWaiting: false,
        mergeGate: { kind: 'awaiting', repos: ['a'] } as never,
      })?.detail,
    ).toBe('1 repo to merge');
  });

  it('words a conflict as a conflict, never as a failure', () => {
    // merge has no failed edge: a conflict must never read as something a retry
    // could clear. Same amber state, different words.
    expect(
      railNeeds({
        stage: 'merge',
        agentWaiting: false,
        mergeGate: { kind: 'conflicted', repos: ['a'], pending: [] } as never,
      }),
    ).toEqual({ detail: '1 repo no longer merges cleanly', action: 'Resolve' });
  });

  it('has nothing to say at merge once everything has landed', () => {
    expect(
      railNeeds({
        stage: 'merge',
        agentWaiting: false,
        mergeGate: { kind: 'merged', repos: [] } as never,
      }),
    ).toBeNull();
  });

  it('has nothing to say at a stage that is not parked on anyone', () => {
    expect(railNeeds({ stage: 'impl', agentWaiting: false, mergeGate: null })).toBeNull();
    expect(railNeeds({ stage: null, agentWaiting: false, mergeGate: null })).toBeNull();
  });
});
```

Replace each `as never` with the real `MergeGateState` shape once you have read `src/workflow/mergeGate.ts`; the cast is there only so the test compiles before you have.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/model/railNeeds.test.ts`
Expected: FAIL — `Cannot find module './railNeeds.js'`.

- [ ] **Step 3: Write minimal implementation**

Create `src/model/railNeeds.ts`:

```ts
import type { MergeGateState } from '../workflow/mergeGate.js';

/**
 * The words a needs-you segment carries: why the ticket stopped, and what the
 * button beside it goes to.
 *
 * Rendered host-side like every other dashboard string — the webview is
 * standalone HTML and cannot import a formatter, and a webview-side wording
 * would be untested and would drift from the Now line's.
 *
 * Deliberately NOT the Now line itself: that is a sentence with room to explain,
 * and this is three or four words inside a segment. One string cannot be both,
 * and the segment is what a user reads first.
 */
export interface RailNeeds {
  /** Why, in a few words. Never a sentence — the segment has no room for one. */
  detail: string;
  /** The label of the control this points AT. Never a new actor. */
  action: string;
}

export interface RailNeedsInput {
  /** `ticket.stageCurrent`, a stored string that may name no known stage. */
  stage: string | null;
  /** The agent asked a question (`agentState === 'waiting'`). */
  agentWaiting: boolean;
  /** The merge gate's current read, when the ticket is at merge. */
  mergeGate: MergeGateState | null;
}

const count = (repos: readonly string[]): string =>
  `${repos.length} ${repos.length === 1 ? 'repo' : 'repos'}`;

/**
 * The two needs-you sources are genuinely different situations, and a live
 * question outranks a parked stage: the agent is asking right now, and the
 * confirm will still be there afterwards.
 */
export function railNeeds(input: RailNeedsInput): RailNeeds | null {
  if (input.agentWaiting) {
    return { detail: 'the agent asked you something', action: 'Open session' };
  }
  if (input.stage === 'ship') {
    return { detail: 'ready to open the PRs', action: 'Confirm ship' };
  }
  if (input.stage === 'merge') {
    const gate = input.mergeGate;
    if (!gate) return null;
    // A conflict is a WORDING difference, not a new state: merge has no failed
    // edge, so it must never read as something a retry could clear.
    if (gate.kind === 'conflicted') {
      return { detail: `${count(gate.repos)} no longer merges cleanly`, action: 'Resolve' };
    }
    if (gate.kind === 'awaiting') {
      return { detail: `${count(gate.repos)} to merge`, action: 'Merge' };
    }
    return null;
  }
  return null;
}
```

If `MergeGateState`'s `conflicted`/`awaiting` variants name their repo list something other than `repos`, use the real field. The singular/plural verb in the conflicted string reads correctly for one repo and slightly off for several; if you prefer, use `${count(gate.repos)} ${gate.repos.length === 1 ? 'no longer merges' : 'no longer merge'} cleanly` and update the test's expected string to match.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/model/railNeeds.test.ts`
Expected: PASS (8).

- [ ] **Step 5: Commit**

```bash
git add src/model/railNeeds.ts src/model/railNeeds.test.ts
git commit -m "feat: word the needs-you segment host-side"
```

---

### Task 5: Thread the state

**Files:**
- Modify: `src/ui/dashboard/state.ts`
- Test: `src/ui/dashboard/state.test.ts`

**Interfaces:**
- Consumes: `buildStageRail` + `BuildRailOptions` (Task 3), `railNeeds` (Task 4), `capForGate` (Task 1, only as the shape of the injected default), `reportedPhases` (Task 2), `needsUser` (`../../model/ticketGlyph.js`), `mergeGateState` (already imported).
- Produces: `DashboardState.rail` in the new shape, `DashboardState.approach` widened to `{ id: string; phases: string[]; reported: string[] }`, and a new trailing parameter on `buildDashboardState`:

```ts
  fixCapFor: (gate: GateStageKey) => number = () => FIX_ATTEMPT_CAP,
```

Consumed by Task 6 (`panel.ts`/`extension.ts`) and Task 8 (the webview).

- [ ] **Step 1: Write the failing test**

Append to `src/ui/dashboard/state.test.ts`, following whatever ticket/store fixture the file already uses (read its existing helpers first and reuse them — do not build a second one):

```ts
describe('dashboard state — the stage track', () => {
  it('marks the current segment needs-you when the ticket is parked at ship', () => {
    // ship is a CONFIRM stage: nothing runs, and the ticket waits on a click.
    // Every other surface already reports this; the rail is the last one that did not.
    const state = stateFor({ stageCurrent: 'ship', stages: { ship: 'pending' } });
    const ship = state.rail.main.find((s) => s.cell.stageKey === 'ship')!;
    expect(ship.needsUser).toBe(true);
    expect(ship.needs).toEqual({ detail: 'ready to open the PRs', action: 'Confirm ship' });
  });

  it('puts needs-you on impl when the agent is the one waiting', () => {
    const state = stateFor({
      stageCurrent: 'impl',
      agentState: 'waiting',
      stages: { impl: 'running' },
    });
    const impl = state.rail.main.find((s) => s.cell.stageKey === 'impl')!;
    expect(impl.needsUser).toBe(true);
    expect(impl.needs?.action).toBe('Open session');
    expect(state.rail.main.filter((s) => s.needsUser)).toHaveLength(1);
  });

  it('leaves every segment clear when nothing is blocked on the user', () => {
    const state = stateFor({ stageCurrent: 'impl', stages: { impl: 'running' } });
    expect(state.rail.main.some((s) => s.needsUser)).toBe(false);
  });

  it('draws the meter with the manifest s narrowed uat budget', () => {
    const state = stateFor(
      { stageCurrent: 'uat', stages: { uat: 'failed' }, attempts: { uat: 1 } },
      { fixCapFor: () => 1 },
    );
    const uat = state.rail.main.find((s) => s.cell.stageKey === 'uat')!;
    expect(uat.retry).toMatchObject({ spent: 1, cap: 1 });
  });

  it('reports which declared phases the agent has actually marked', () => {
    // Declared is not observed: an unmarked phase renders hollow and must never
    // be claimed as done.
    const state = stateFor({
      stageCurrent: 'impl',
      stages: { impl: 'running' },
      approach: 'rpi',
      phases: ['research', 'plan', 'implement'],
      marks: [{ stageKey: 'impl', attempt: 0, phaseName: 'research' }],
    });
    expect(state.approach).toMatchObject({
      id: 'rpi',
      phases: ['research', 'plan', 'implement'],
      reported: ['research'],
    });
  });

  it('reports no phases when the agent has marked none', () => {
    const state = stateFor({
      stageCurrent: 'impl',
      stages: { impl: 'running' },
      approach: 'rpi',
      phases: ['research'],
    });
    expect(state.approach?.reported).toEqual([]);
  });
});
```

`stateFor` is a helper you add on top of the file's existing fixture: it seeds a ticket with the given stage rows / attempts / phase marks in the in-memory store, then returns `buildDashboardState(store, ticketId, …)`. Its second argument threads `fixCapFor`. Write it in terms of the store helpers the file already imports (`createTicket`, `setStage`, `recordPhaseMark` or equivalent — check the file). If seeding phase marks is not already possible there, insert them with the same store function `listPhaseMarks` reads.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/ui/dashboard/state.test.ts`
Expected: FAIL — `s.cell` is undefined (old rail shape), `state.approach.reported` is undefined, and `buildDashboardState` takes no `fixCapFor`.

- [ ] **Step 3: Write the implementation**

In `src/ui/dashboard/state.ts`:

Add imports:

```ts
import { needsUser } from '../../model/ticketGlyph.js';
import { railNeeds } from '../../model/railNeeds.js';
import { reportedPhases } from '../../model/inside/agent.js';
import { FIX_ATTEMPT_CAP, countFixAttempts, lastFailedGate, type GateStageKey } from '../../workflow/fixAttempts.js';
```

(the last line replaces the existing `countFixAttempts, lastFailedGate` import).

Widen the `approach` field's declaration:

```ts
  /**
   * The approach driving impl, the workflow phases it DECLARES, and the phases
   * the agent actually REPORTED by running a marker command.
   *
   * Declared is not observed. `reported` is the only thing that may fill a pip:
   * a phase mark is a fact with a timestamp, the same class of evidence as the
   * impl done marker, and its absence stays evidence of nothing.
   */
  approach: { id: string; phases: string[]; reported: string[] } | null;
```

Add the new trailing parameter to `buildDashboardState`, after `agentContext`:

```ts
  /**
   * The fix budget for one gate, so the retry meter draws exactly as many ticks
   * as the driver will spend. Injected — the state builder never reads the
   * manifest — and defaults to the graph's own cap rather than to a guess.
   */
  fixCapFor: (gate: GateStageKey) => number = () => FIX_ATTEMPT_CAP,
```

Inside the body, after `const phases = approachPhases(ticket.approach);`, add:

```ts
  // ONE read of the merge gate for the whole snapshot: the Now line, the rail's
  // needs-you wording and the merge rows must not describe the same three-valued
  // fact from three different reads.
  const mergeGate = mergeGateState(store, ticketId);
  const blocked = needsUser(ticket);
  const implCell = stepper.find((c) => c.stageKey === 'impl') ?? null;
  const reported = implCell
    ? reportedPhases(listPhaseMarks(store, ticketId), implCell).map((m) => m.phaseName)
    : [];
```

`listPhaseMarks(store, ticketId)` is already called further down for `buildStageInside`. Hoist it to a single `const marks = listPhaseMarks(store, ticketId);` above and use `marks` in both places — two reads of the same table in one snapshot is the thing this codebase keeps avoiding.

Reuse `mergeGate` in the existing `buildNowLine` call (replace the inline `mergeGate: mergeGateState(store, ticketId)` with `mergeGate`).

Replace the `rail:` line:

```ts
    rail: buildStageRail(stepper, ticket.stages, {
      current: ticket.stageCurrent,
      needsUser: blocked,
      needs: blocked
        ? railNeeds({
            stage: ticket.stageCurrent,
            agentWaiting: (ticket.agentState ?? 'none') === 'waiting',
            mergeGate,
          })
        : null,
      capFor: fixCapFor,
    }),
```

Replace the `approach:` line:

```ts
    approach: ticket.approach ? { id: ticket.approach, phases, reported } : null,
```

`fixAttempts` (the existing local) is still used by `buildNowLine` and `buildStageInside`; leave it alone.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/ui/dashboard/state.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: errors only in `panel.ts` / `extension.ts` (Task 6) and `webview.html` is not typechecked. If `state.ts` itself errors, fix it here.

- [ ] **Step 6: Commit**

```bash
git add src/ui/dashboard/state.ts src/ui/dashboard/state.test.ts
git commit -m "feat: thread needs-you, the per-gate cap and reported phases into the dashboard state"
```

---

### Task 6: Bind the cap to the live manifest

**Files:**
- Modify: `src/ui/dashboard/panel.ts` (constructor dep + the `buildDashboardState` call)
- Modify: `src/extension.ts` (the `new DashboardManager(` argument list)
- Test: `src/ui/dashboard/panel.test.ts`

**Interfaces:**
- Consumes: `capForGate` (Task 1), `buildDashboardState`'s new trailing parameter (Task 5).
- Produces: nothing new for later tasks.

- [ ] **Step 1: Write the failing test**

Append to `src/ui/dashboard/panel.test.ts`, using the file's existing `FakePanel`/manager fixture:

```ts
it('pushes the manifest s uat fix budget into the rail s meter', () => {
  // The meter must draw exactly the number of attempts the driver will spend.
  // A cap resolved anywhere but from the live manifest is a different number.
  const manager = makeManager({ fixCapFor: () => 1 });
  // …seed a ticket with a failed uat at attempt 1, open its panel, then:
  const state = lastStatePush(manager);
  const uat = state.rail.main.find((s) => s.cell.stageKey === 'uat')!;
  expect(uat.retry?.cap).toBe(1);
});
```

Adapt `makeManager` / `lastStatePush` to whatever the file already provides — read it first and extend its helpers rather than adding parallel ones.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/ui/dashboard/panel.test.ts`
Expected: FAIL — `DashboardManager` takes no `fixCapFor`, so the meter reports the default `3`.

- [ ] **Step 3: Write minimal implementation**

In `src/ui/dashboard/panel.ts`, add a constructor parameter after `loadStats`:

```ts
    /**
     * The fix budget for one gate, from the live manifest. Optional: an
     * unresolved manifest degrades to the graph's own cap rather than to a
     * number that would misreport how many retries remain.
     */
    private readonly fixCapFor?: (gate: GateStageKey) => number,
```

with `import type { GateStageKey } from '../../workflow/fixAttempts.js';` at the top, and pass it as the last argument of the `buildDashboardState` call in `pushState`:

```ts
      this.agentContext?.(),
      this.fixCapFor,
```

Passing `undefined` positionally lets `buildDashboardState`'s own default apply, exactly as `approachPhases` and `isRepoRunnable` already do.

In `src/extension.ts`, add a final argument to `new DashboardManager(`, after the `loadWorktreeStats` line:

```ts
    // The rail's retry meter must draw the budget the driver will actually
    // spend, so it resolves through the SAME rule fixResumeDecision uses.
    (gate) => capForGate(gate, currentManifest()?.uat?.maxFixAttempts),
```

with `capForGate` added to the existing import from `./workflow/fixAttempts.js` (add the import if there is none).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/ui/dashboard/panel.test.ts && npm run typecheck`
Expected: PASS, and a clean typecheck across `src/`.

- [ ] **Step 5: Commit**

```bash
git add src/ui/dashboard/panel.ts src/ui/dashboard/panel.test.ts src/extension.ts
git commit -m "feat: bind the rail's retry meter to the manifest's uat fix budget"
```

---

### Task 7: The track's CSS

Replaces every rule from the `/* The stage graph as a circuit… */` comment (currently line 74) through the `.approach .foot` rule (currently line 330). Keep `.stepper` (the outer panel), `.spin` and `@keyframes spin` — re-declare them inside the new block so the region stays one contiguous edit.

**Files:**
- Modify: `src/ui/dashboard/webview.html` (the `<style>` region above)
- Test: `src/ui/dashboard/webview.test.ts` (Task 9 pins it; this task's own gate is Step 4's manual check)

**Interfaces:**
- Consumes: `--k-*` tokens and `stg-<stage>` / `--stg-color` from the injected design system and stage palette.
- Produces: the class contract Task 8's `renderTrack` emits — `.track`, `.track.snug/.tight/.bare`, `.lane`, `.seg`, `.seg.cur/.passed/.running/.failed/.skipped/.needs`, `.seg .pick`, `.seg .g`, `.seg .nm`, `.seg .nm .full`, `.seg .nm .abbr`, `.seg .mt`, `.seg .go`, `.seg .pips`, `.seg .pips .p`, `.seg .pips .pn`, `.seg .fixm`, `.fixm .ticks`, `.fixm .tk`, `.fixm .tx`, `.fixm .ret`, `.fixm.spent`.

- [ ] **Step 1: Delete the old block**

Delete from the `/* The stage graph as a circuit, not a line. … */` comment through the `.approach .foot{…}` rule inclusive. Do not touch the `/* ── activity strip … */` block that follows, nor the `/*KARST_DS_CSS*/`, `/*KARST_PALETTE*/`, `/*KARST_PROVIDER_CSS*/` markers above.

- [ ] **Step 2: Write the new block in its place**

```css
  /* The stage graph as ONE OBJECT the ticket travels through, not seven circles
     joined by connectors. The current stage is the wide segment and every other
     is compact — that is what fits seven stages into a narrow panel, and it is
     what removed the old 560px floor and the sideways scroll with it.

     `fix` is NOT a segment. STAGE_GRAPH reaches it only by a failed verdict and
     its only edge returns to uat, so nothing can be after it; it is a retry
     cycle on the gate that failed, and it is drawn inside that gate (.fixm).

     Status is never colour alone (UI-R28): each state also carries a distinct
     glyph, and failed adds a hatch, so the track survives colourblindness and
     high-contrast themes. */
  .stepper{margin:var(--k-space-8) 0 var(--k-space-9);
    padding:calc(var(--k-space-6) + var(--k-space-1)) var(--k-space-4) var(--k-space-4);
    border:var(--k-border-w) solid var(--k-border);
    border-radius:calc(var(--k-radius-lg) + var(--k-border-w));background:var(--k-surface)}
  .railwrap{padding-top:var(--k-space-3)}

  /* COMPONENT DIMENSIONS, not spacing (UI-R04 exception — the same category the
     deleted 560px floor was declared under). The closed 0–26px scale has no step
     at a control-strip height or at a chevron depth, and both are geometry: the
     notch depth is what every horizontal padding below is derived FROM. */
  .track{position:relative;--trk-h:46px;--trk-notch:11px;--trk-tick-w:4px;--trk-tick-h:11px}

  /* overflow-x:auto, NEVER hidden. The three degradation steps below keep the
     track inside its lane at every width a VS Code panel can be dragged to (300px
     measured, docs/design/stages/variant-e-track.html), so this scrollbar is
     unreachable in practice — but if a width ever gets past them, the honest
     failure is a scrollbar the user can act on. overflow:hidden is what turned an
     over-wide track into an invisible defect: the current segment's own action
     button was clipped away with nothing to say so. */
  .lane{display:flex;align-items:stretch;height:var(--trk-h);
    border-radius:var(--k-radius-lg);background:var(--k-surface-sunken);
    border:var(--k-border-w) solid var(--k-border);
    overflow-x:auto;overflow-y:hidden;scrollbar-width:thin}

  /* A segment is a WRAPPER, not a button: it holds the select control and, when
     the stage is parked on the user, the action control too — and a <button> may
     not contain a <button> (nested, the parser closes the outer one and the whole
     track loses its structure). The chevron clip and the wash live here. */
  .track .seg{position:relative;display:flex;align-items:center;gap:var(--k-space-3);
    flex:0 0 auto;min-width:0;color:var(--k-pending);--stg-color:var(--k-pending);
    padding:0 var(--k-space-6) 0 calc(var(--trk-notch) + var(--k-space-5));
    clip-path:polygon(0 0,calc(100% - var(--trk-notch)) 0,100% 50%,
      calc(100% - var(--trk-notch)) 100%,0 100%,var(--trk-notch) 50%);
    margin-left:calc(var(--trk-notch) * -1);
    transition:background var(--k-dur-base) var(--k-ease-standard)}
  .track .seg:first-child{margin-left:0;padding-left:var(--k-space-6);
    clip-path:polygon(0 0,calc(100% - var(--trk-notch)) 0,100% 50%,
      calc(100% - var(--trk-notch)) 100%,0 100%)}
  .track .seg:last-child{padding-right:var(--k-space-7);
    clip-path:polygon(0 0,100% 0,100% 100%,0 100%,var(--trk-notch) 50%)}
  .track .seg:hover{background:var(--k-surface-hover)}

  /* The select control fills the wrapper, so the WHOLE segment is the hit area
     while still being one real <button> for Tab and Enter (UI-R09). */
  .track .seg .pick{position:absolute;inset:0;background:transparent;border:0;padding:0;cursor:pointer}
  .track .seg .pick:focus-visible{outline:var(--k-focus-w) solid var(--k-focus);
    outline-offset:calc(var(--k-focus-offset) * -1)}
  .track .seg > *:not(.pick){position:relative;z-index:1;pointer-events:none}
  /* The two REAL controls take their events back. */
  .track .seg > .go,.track .seg > .fixm{pointer-events:auto}
  .track .seg.sel .pick{box-shadow:inset 0 0 0 calc(var(--k-border-w) * 2) var(--k-series-2)}

  /* Travelled segments carry their own stage hue, so the route changes colour as
     the ticket advances — the one thing a flat progress bar cannot say. */
  .track .seg.passed{background:color-mix(in srgb,var(--stg-color) 20%,transparent);color:var(--stg-color)}
  .track .seg.running{background:color-mix(in srgb,var(--stg-color) 34%,transparent);color:var(--k-success-fg)}
  .track .seg.failed{color:var(--k-failed);
    background-image:repeating-linear-gradient(135deg,
      color-mix(in srgb,var(--k-failed) 26%,transparent) 0 var(--k-space-3),
      transparent var(--k-space-3) var(--k-space-6))}
  /* Skipped leaves the stage ramp: a stage that never ran has no identity to
     assert, so it reads neutral. */
  .track .seg.skipped{background:color-mix(in srgb,var(--k-pending) 22%,transparent);color:var(--k-text-faint)}
  /* Needs-you OUTRANKS the stage: the stage is no longer the point, the human is.
     Amber wash + pause glyph + the reason in words + the action = four carriers. */
  .track .seg.needs{background:color-mix(in srgb,var(--k-attention) 30%,transparent);
    color:var(--k-attention);animation:seg-breathe var(--k-dur-flash-done) ease-in-out infinite}
  @keyframes seg-breathe{0%,100%{background:color-mix(in srgb,var(--k-attention) 30%,transparent)}
    50%{background:color-mix(in srgb,var(--k-attention) 16%,transparent)}}

  /* min-content, not 0: at 0 the current segment absorbs every overflow by
     shrinking, so its own action button is clipped by the chevron AND the lane
     never reports an overflow — the degradation below would never fire. The extra
     right padding is not spacing either: clip-path clips CHILDREN, so the notch
     was slicing the action button's right edge. */
  .track .seg.cur{flex:1 1 auto;min-width:min-content;padding-right:var(--k-space-9)}

  .track .seg .g{flex:none;width:var(--k-space-7);height:var(--k-space-7);
    display:grid;place-items:center;font-size:var(--k-text-xs);font-weight:var(--k-weight-semibold)}
  .track .seg .nm{font-size:var(--k-text-xs);letter-spacing:.05em;text-transform:uppercase;
    white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .track .seg.cur .nm{font-size:var(--k-text-md);font-weight:var(--k-weight-semibold);
    letter-spacing:.03em;flex:none}
  .track .seg .mt{font-family:var(--k-font-mono);font-size:var(--k-text-2xs);opacity:.85;
    white-space:nowrap;padding-left:var(--k-space-4);margin-left:var(--k-space-1);
    border-left:var(--k-border-w) solid currentColor;flex:none}
  /* Inside the current segment the META gives way, never the name and never the
     action: an unbounded fact (a repo pair, a conflict summary) must not be able
     to push the button it belongs to out of the clip. */
  .track .seg.cur .mt{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis}

  /* The needs-you control. NOT `.act` — that is the activity strip's class. It is
     navigational: it scrolls the control that owns the action into view and
     focuses it, so the rail never becomes a second actor for an irreversible
     step. */
  .track .seg .go{font:inherit;font-size:var(--k-text-2xs);border:var(--k-border-w) solid currentColor;
    border-radius:var(--k-radius-sm);background:transparent;color:inherit;
    padding:var(--k-space-1) var(--k-space-4);cursor:pointer;flex:none;margin-left:auto}
  .track .seg .go:hover{background:color-mix(in srgb,currentColor 18%,transparent)}
  .track .seg .go:focus-visible{outline:var(--k-focus-w) solid var(--k-focus);
    outline-offset:var(--k-focus-offset)}

  /* impl's approach lives INSIDE impl's segment: one pip per declared phase, the
     reported ones filled. No stem, no chip, nothing hanging off the track. A
     hollow pip is "not reported", never "not done". */
  .track .seg .pips{display:flex;align-items:center;gap:var(--k-space-2);flex:none;
    margin-left:auto;padding-left:var(--k-space-5)}
  .track .seg .pips .p{width:var(--k-space-3);height:var(--k-space-3);
    border-radius:var(--k-radius-circle);border:var(--k-border-w) solid currentColor;opacity:.55}
  .track .seg .pips .p.on{background:currentColor;opacity:1}
  .track .seg .pips .pn{font-family:var(--k-font-mono);font-size:var(--k-text-2xs);
    margin-left:var(--k-space-2);opacity:.9}

  /* ── the retry meter ──────────────────────────────────────────────────────
     One tick per allowed attempt, filled per attempt spent, inside the gate being
     retried. Ticks and not a bar: a bar reads as progress toward completion, and
     spending fix attempts is the opposite of progress. It costs zero layout on a
     ticket that never looped, and it makes "one retry left before this parks"
     visible — which karst shows nowhere else. */
  .track .fixm{display:inline-flex;align-items:center;gap:var(--k-space-3);flex:none;
    font:inherit;background:transparent;border:0;border-left:var(--k-border-w) solid currentColor;
    padding:0 0 0 var(--k-space-4);margin-left:var(--k-space-1);color:inherit;cursor:pointer}
  .track .fixm:focus-visible{outline:var(--k-focus-w) solid var(--k-focus);
    outline-offset:var(--k-focus-offset)}
  .track .fixm .ticks{display:inline-flex;gap:var(--k-space-1)}
  .track .fixm .tk{width:var(--trk-tick-w);height:var(--trk-tick-h);border-radius:var(--k-radius-xs);
    border:var(--k-border-w) solid var(--stage-fix);opacity:.45;display:inline-block}
  .track .fixm .tk.on{background:var(--stage-fix);opacity:1}
  .track .fixm .tx{font-family:var(--k-font-mono);font-size:var(--k-text-2xs);
    color:var(--stage-fix);white-space:nowrap}
  /* review ─fail→ fix ─pass→ uat is the one loop that lands on a gate it did not
     leave. Said in WORDS, inside the segment — a backwards arc across the track
     is the shape this design exists to avoid. */
  .track .fixm .ret{font-family:var(--k-font-mono);font-size:var(--k-text-2xs);
    color:var(--stage-fix);white-space:nowrap}
  /* Spent-but-idle is a RECORD, not an alarm: the meter stays so the cost of the
     ticket is legible, and stops claiming attention. */
  .track .fixm.spent .tk{border-color:var(--k-text-faint)}
  .track .fixm.spent .tk.on{background:var(--k-text-faint)}
  .track .fixm.spent .tx,.track .fixm.spent .ret{color:var(--k-text-faint)}

  /* ── narrow widths: THREE measured steps ──────────────────────────────────
     Measured, not a breakpoint: the threshold depends on the current stage's name
     length and on whether a meter is riding along. In order of what costs least to
     lose — SNUG drops what a segment merely annotates and keeps every NAME; TIGHT
     drops the names too; BARE is the floor, where the passed-by segments become
     position markers and the current segment sheds its own annotations, keeping
     glyph, name and action.

     THREE, not two: two was the first draft and at a 397px lane five of the eight
     mockup cases were still over after TIGHT. Three clear every case to 300px.

     Anything a step drops is already in the accessible name, which never degrades. */
  .track.snug .seg:not(.cur) .mt,
  .track.snug .seg:not(.cur) .fixm .tx{display:none}
  .track.snug .seg:not(.cur) .fixm{padding-left:var(--k-space-3);margin-left:0}
  .track.snug .seg.cur .pips .pn{display:none}
  .track.tight .seg:not(.cur) .nm{display:none}
  .track.tight .seg:not(.cur){padding-left:var(--k-space-8);padding-right:var(--k-space-4)}
  .track.tight .seg:not(.cur) .fixm .ret{display:none}
  .track.bare .seg:not(.cur){padding-left:var(--k-space-6);padding-right:var(--k-space-2);min-width:0}
  .track.bare .seg:not(.cur) .fixm{display:none}
  .track.bare .seg:not(.cur) .g{width:var(--k-space-6)}
  .track.bare .seg.cur{padding-right:var(--k-space-8)}
  .track.bare .seg.cur .mt,
  .track.bare .seg.cur .pips,
  .track.bare .seg.cur .fixm .tx,
  .track.bare .seg.cur .fixm .ret{display:none}
  /* …and the current segment's name shortens to the stage KEY — the same word
     every other segment shows, so it is a shortening and not a different label.
     Both forms ship and CSS picks one; swapping text in JS would mean
     re-rendering on resize. */
  .track .seg .nm .abbr{display:none}
  .track.bare .seg.cur .nm .full{display:none}
  .track.bare .seg.cur .nm .abbr{display:inline}

  /* Running = a live spinner, not a glyph. ⟳ misreads as "reload/retry", the
     wrong affordance on a clickable segment. Under reduced motion it stops as a
     broken ring — still shape-distinct from ✓ ✕ · –, so status never rides on
     colour alone. */
  .spin{display:block;border-radius:var(--k-radius-circle);
    border:calc(var(--k-border-w) * 2) solid currentColor;border-top-color:transparent;
    animation:spin var(--k-dur-spin) linear infinite}
  .track .seg .spin{width:var(--k-space-6);height:var(--k-space-6)}
  .oglyph .spin{width:var(--k-space-4);height:var(--k-space-4);margin:0 auto;
    border-width:calc(var(--k-border-w) * 1.5);color:var(--k-running)}
  @keyframes spin{to{transform:rotate(360deg)}}
  @media (prefers-reduced-motion:reduce){
    .spin,.track .seg.needs{animation:none}
  }
```

- [ ] **Step 3: Check no deleted class is still referenced**

Run:

```bash
grep -nE '\.(loop|fixnode|implstem|drop|retlbl|faillbl|noapproach|phrow|fixtoggle)\b|--cols|--impl:|--uat:|--review:|min-width:560' src/ui/dashboard/webview.html
```

Expected: only hits inside the JS, which Task 8 removes. If a CSS hit remains, the deletion in Step 1 was incomplete.

- [ ] **Step 4: Confirm the token rule holds**

Run:

```bash
awk '/^<style/,/^<\/style>/' src/ui/dashboard/webview.html | grep -nE '#[0-9a-fA-F]{3,8}\b|rgba?\(' | grep -v 'KARST_'
```

Expected: no new hits attributable to the track block. Pre-existing hits elsewhere in the file are out of scope; the track block must contribute none.

- [ ] **Step 5: Commit**

```bash
git add src/ui/dashboard/webview.html
git commit -m "feat(ui): segmented stage track replaces the rail and its branch band (UI-R04, UI-R28)"
```

---

### Task 8: `renderTrack`

**Files:**
- Modify: `src/ui/dashboard/webview.html` (the `<script>` region)
- Test: Task 9 pins it; this task's own gates are the greps in Steps 5–6.

**Interfaces:**
- Consumes: `state.rail.main` (Task 3/5), `state.approach.{id,phases,reported}` (Task 5), the existing `STAGE_TITLE`, `SPINNER`, `esc`, `el`, `durationText`, `selectedStage`.
- Produces: the DOM contract Task 7's CSS styles, and the `data-stage` selection hooks the existing click listener already handles.

- [ ] **Step 1: Delete what the band needed**

Remove, in `src/ui/dashboard/webview.html`:
- `let fixExpanded = false;` and its comment (~line 727–729)
- `function segClass(cell, prev) {…}` (~line 841) — used only by `renderRail`
- `function renderRail(…) {…}` in full (~line 872–940)
- `function renderApproach(…) {…}` in full (~line 942–967)
- `const STEP_CLASS = …` and `const STEP_GLYPH = …` (~line 711, 715) — replaced below. Keep `SPINNER` and `OP_GLYPH`; `OP_GLYPH` belongs to the Inside strip.
- the `if (e.target.closest('[data-fixtoggle]')) { toggleFix(); return; }` line (~1508) and the `toggleFix` function (~1477–1480)
- `fixExpanded` from the `persist` call (~1470) and from the restore block (~1741)

- [ ] **Step 2: Add the track's constants and glyph rule**

Where `STEP_CLASS`/`STEP_GLYPH` were:

```js
  // Stage status -> segment CSS class. Needs-you is NOT here: it outranks the
  // stage status and is applied from the segment's own `needsUser`, which the
  // host derives once (model/ticketGlyph.needsUser) for every surface.
  const SEG_CLASS = { passed: 'passed', running: 'running', failed: 'failed', pending: '', skipped: 'skipped' };
  const SEG_GLYPH = { passed: '✓', running: SPINNER, failed: '✕', pending: '·', skipped: '–' };
  // A parked confirm stage carries a pause; a conflicted merge carries a warning.
  // Two glyphs, one state — merge has no failed edge, so a conflict is a wording
  // difference and must never render as something a retry could clear.
  const NEEDS_GLYPH = '❚❚';
  const CONFLICT_GLYPH = '⚠';
```

- [ ] **Step 3: Add `renderTrack`**

In place of the deleted `renderRail`/`renderApproach`:

```js
  // The track: one object the ticket travels through. The current segment is
  // wide, the rest compact — that is what fits seven stages in a narrow panel.
  //
  // No geometry is pushed from the host any more. The old rail positioned its
  // band from `--cols/--impl/--uat/--review` calc() inputs because it had a
  // second lane to bolt to specific columns; there is no second lane now, so the
  // only measurement left is `place()` below, and it positions nothing — it just
  // picks one of three degradation classes.
  function renderTrack(rail, approach, sel) {
    const segs = rail.main.map((s) => {
      const cell = s.cell;
      const k = cell.stageKey;
      const status = cell.status;
      const needs = s.needsUser === true;
      const conflict = needs && s.needs && s.needs.action === 'Resolve';
      const running = status === 'running' || (s.retry && s.retry.live);
      const cls = [
        needs ? 'needs' : (SEG_CLASS[status] || ''),
        s.current ? 'cur' : '',
        sel === k ? 'sel' : '',
      ].filter(Boolean).join(' ');

      const glyph = running ? SPINNER
        : conflict ? CONFLICT_GLYPH
        : needs ? NEEDS_GLYPH
        : (SEG_GLYPH[status] || '');

      // Both name forms ship and the CSS picks one: the current segment normally
      // shows the human title and falls back to the stage key at the narrowest
      // step. Swapping the text in JS would mean re-rendering on every resize.
      const title = STAGE_TITLE[k] || k;
      const name = s.current
        ? `<span class="full">${esc(title)}</span><span class="abbr">${esc(k)}</span>`
        : esc(k);

      let extra = '';
      if (s.current && needs) {
        extra = `<span class="mt">${esc(s.needs ? s.needs.detail : '')}</span>`
          + `<button type="button" class="go" data-goto="${esc(s.needs ? s.needs.action : '')}"`
          + `>${esc(s.needs ? s.needs.action : 'Open')}</button>`;
      } else if (s.current && k === 'impl' && approach) {
        extra = renderPips(approach);
      } else {
        const d = durationText(cell);
        if (d) extra = `<span class="mt">${esc(d)}</span>`;
      }
      if (s.retry) extra += renderMeter(s.retry);

      // Icon-and-word, but the STATUS is carried by colour and glyph, so the
      // accessible name states it outright — and states the retry loop too: a
      // screen-reader user must not have to infer a live retry from a meter they
      // cannot see, nor lose the return target when `bare` drops the `↩ uat`.
      const aria = (needs ? `${title}: needs you` : `${title}: ${status}`)
        + (s.retry ? ` — fix attempt ${s.retry.spent} of ${s.retry.cap}${s.retry.live ? ', running' : ''}` : '')
        + (s.retry && s.retry.returnsTo ? `, revalidates from ${s.retry.returnsTo}` : '');

      return `<div class="seg stg-${esc(k)} ${cls}">`
        + `<button type="button" class="pick" data-stage="${esc(k)}" aria-pressed="${sel === k}"`
        + ` aria-label="${esc(aria)}" title="${esc(aria)}"></button>`
        + `<span class="g">${glyph}</span><span class="nm">${name}</span>${extra}</div>`;
    }).join('');

    el('rail').innerHTML = `<div class="track"><div class="lane">${segs}</div></div>`;
    place();
  }

  // impl's declared phases, as pips inside impl's own segment. DECLARED is not
  // observed: a pip fills only for a phase the agent actually reported by running
  // a marker command, and a hollow pip means "not reported" — never "not done".
  function renderPips(approach) {
    const phases = approach.phases || [];
    if (!phases.length) return '';
    const done = new Set(approach.reported || []);
    const pips = phases.map((p) => {
      const on = done.has(p);
      return `<span class="p ${on ? 'on' : ''}" title="${esc(p)}${on ? ' — reported' : ' — not reported'}"></span>`;
    }).join('');
    const latest = (approach.reported || []).slice(-1)[0];
    const caption = latest ? `${latest} · ${approach.id}` : approach.id;
    return `<span class="pips">${pips}<span class="pn">${esc(caption)}</span></span>`;
  }

  // The retry meter IS the fix control: it is how `fix` stays selectable now that
  // the node is gone, and it sits on the gate the loop belongs to, which is where
  // a user would look for it. One tick per allowed attempt, filled per attempt
  // spent — built from the cap the host resolved, never from a literal.
  function renderMeter(retry) {
    const ticks = Array.from({ length: retry.cap }, (_, i) =>
      `<span class="tk ${i < retry.spent ? 'on' : ''}"></span>`).join('');
    const ret = retry.returnsTo ? `<span class="ret">↩ ${esc(retry.returnsTo)}</span>` : '';
    const label = `Fix loop on ${STAGE_TITLE[retry.gate] || retry.gate}: `
      + `attempt ${retry.spent} of ${retry.cap}${retry.live ? ', running' : ''}`;
    return `<button type="button" class="fixm ${retry.live ? '' : 'spent'}" data-stage="fix"`
      + ` aria-label="${esc(label)}" title="${esc(label)}">`
      + `<span class="ticks">${ticks}</span>`
      + `<span class="tx">fix ${retry.spent}/${retry.cap}</span>${ret}</button>`;
  }
```

- [ ] **Step 4: Add the measured degradation and the navigational click**

After `renderTrack`:

```js
  // THREE steps, measured rather than keyed to a breakpoint: the threshold
  // depends on the current stage's name length and on whether a meter is riding
  // along. This is the ONLY measurement in the track and it POSITIONS NOTHING —
  // it toggles one of three classes, so a measurement taken pre-layout can never
  // detach anything, only under-degrade for one frame.
  function place() {
    const track = document.querySelector('.track');
    if (!track) return;
    const lane = track.querySelector('.lane');
    if (!lane) return;
    const over = () => lane.scrollWidth > lane.clientWidth + 1;
    track.classList.remove('snug', 'tight', 'bare');
    if (!over()) return;
    track.classList.add('snug');
    if (!over()) return;
    track.classList.add('tight');
    if (over()) track.classList.add('bare');
  }
  // Once now, again on the frame the browser actually lays out in, and again once
  // web fonts have settled — a track measured against pre-layout metrics reports
  // no overflow and degrades one step too late.
  window.addEventListener('resize', place);
  window.addEventListener('load', place);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(place);

  // The needs-you button is NAVIGATIONAL. It scrolls the control that owns the
  // action into view and focuses it; it posts no host message and duplicates no
  // actor. `merge` is per-repo and its confirmation modal lives in the host
  // (workflow/mergePr.ts), so a rail-level Merge button could neither pick a repo
  // nor carry the confirmation — and making ship's an actor while merge's is a
  // pointer would be two rules where one will do.
  function gotoAction() {
    // The Now line's own primary action, when it has one (ship). Otherwise the
    // PR panel, where the per-repo Merge and Resolve buttons live (merge).
    const target = document.querySelector('#now [data-act]')
      || document.querySelector('#prs .mgbtn');
    const scrollTo = target || el('prs');
    if (!scrollTo) return;
    scrollTo.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    if (target && typeof target.focus === 'function') target.focus();
  }
```

In the existing click listener, immediately before the `const node = e.target.closest('[data-stage]');` line:

```js
    if (e.target.closest('[data-goto]')) { gotoAction(); return; }
```

The retry meter carries `data-stage="fix"`, so the existing `[data-stage]` handler already selects fix from it — no new branch.

- [ ] **Step 5: Update the render call**

At `render(state)` (~line 1444), replace:

```js
    renderRail(state.rail, state.approach, sel, fixExpanded);
```

with:

```js
    renderTrack(state.rail, state.approach, sel);
```

- [ ] **Step 6: Prove nothing dangles**

Run:

```bash
grep -nE 'renderRail|renderApproach|fixExpanded|data-fixtoggle|segClass|STEP_CLASS|STEP_GLYPH|rail\.(branch|geometry|armed|cap)' src/ui/dashboard/webview.html
```

Expected: no output.

- [ ] **Step 7: Check the JS parses**

Run:

```bash
node -e "const fs=require('fs');const h=fs.readFileSync('src/ui/dashboard/webview.html','utf8');const m=[...h.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)];m.forEach((s,i)=>{new Function(s[1]);console.log('script',i,'parses')})"
```

Expected: every script block reports `parses`. A `SyntaxError` here names the line to fix.

- [ ] **Step 8: Commit**

```bash
git add src/ui/dashboard/webview.html
git commit -m "feat(ui): render the stage track, with fix as a retry meter on its gate"
```

---

### Task 9: Pin the track

**Files:**
- Modify: `src/ui/dashboard/webview.test.ts`

**Interfaces:**
- Consumes: the rendered `webview.html` as text (the file already reads it into `HTML`).
- Produces: nothing.

- [ ] **Step 1: Delete the pins for the deleted band**

Remove these `it(…)` blocks — each asserts a structure that no longer exists:
- `renders fix as the optional branch, never on the main line`
- `renders the fix branch status and paints a successful fix green`
- `hides the fix branch by default, behind an expand/collapse toggle`
- `forces the fix branch open while the loop is armed`
- `persists the fix toggle beside the host state, like the selection`
- `makes every stage node a real button, so the rail is keyboard-reachable`
- `names every rail/fix node for a screen reader, not just a hover title`
- `pulses the armed fix node by scale only, never opacity`
- `never lifts a rail column into its own stacking context`
- `keeps the rail mask opaque, because it is a mask and not just a tint`
- `separates the focus outline from the selection ring by colour`
- `keeps the rail scroll container padded, so the ring is not sliced off`

Keep `draws the rail from state.rail, not from the flat stepper`.

- [ ] **Step 2: Write the new failing pins**

Add, in the same `describe('dashboard webview.html')`:

```ts
  it('keeps fix off the forward path — it is drawn on the gate it retries', () => {
    // The bug the track exists to fix. `fix` appears exactly once, as the retry
    // meter's own data-stage, and never as a segment mapped out of rail.main.
    expect(HTML).toContain('rail.main.map');
    expect(HTML).not.toMatch(/rail\.(branch|geometry|armed|cap)\b/);
    const fixHits = HTML.match(/data-stage="fix"/g) || [];
    expect(fixHits).toHaveLength(1);
    expect(HTML).toMatch(/class="fixm[^"]*"[^>]*data-stage="fix"/);
  });

  it('never nests a button inside a button — the parser would close the outer one', () => {
    // The segment is a <div> wrapper holding the select control AND, when the
    // stage is parked on the user, the action control. Nested, the parser closes
    // the outer button and the whole track loses its structure.
    expect(HTML).toMatch(/<div class="seg stg-\$\{esc\(k\)\}/);
    expect(HTML).not.toMatch(/<button[^>]*class="pick"[^>]*>[^<]*<button/);
  });

  it('names every segment for a screen reader, with the same string as the title', () => {
    expect(HTML).toMatch(/aria-label="\$\{esc\(aria\)\}" title="\$\{esc\(aria\)\}"/);
    expect(HTML).toMatch(/aria-label="\$\{esc\(label\)\}" title="\$\{esc\(label\)\}"/);
  });

  it('puts the retry loop in the accessible name, not only in the meter', () => {
    // Everything the narrow steps drop must already be in the name, because the
    // name does not degrade.
    expect(HTML).toContain('fix attempt ${s.retry.spent} of ${s.retry.cap}');
    expect(HTML).toContain('revalidates from ${s.retry.returnsTo}');
  });

  it('draws one tick per allowed attempt, from the host s cap', () => {
    // A meter with more ticks than the driver will spend lies about how many
    // retries are left, which is the one thing it exists to say.
    expect(HTML).toContain('{ length: retry.cap }');
    expect(HTML).not.toMatch(/length:\s*3\b/);
  });

  it('keeps the lane scrollable, never clipped', () => {
    // overflow:hidden is what turned an over-wide track into an invisible
    // defect: the current segment's own action button was clipped with nothing
    // to say so.
    expect(HTML).toMatch(/\.lane\{[^}]*overflow-x:auto/);
    expect(HTML).not.toMatch(/\.lane\{[^}]*overflow:hidden/);
  });

  it('degrades in three steps, each of which drops something', () => {
    for (const step of ['snug', 'tight', 'bare']) {
      const rules = HTML.match(new RegExp(`\\.track\\.${step}[^{]*\\{[^}]*\\}`, 'g')) || [];
      expect(rules.length, `no .track.${step} rule`).toBeGreaterThan(0);
      expect(rules.some((r) => /display:none|min-width:0|padding/.test(r)),
        `.track.${step} drops nothing`).toBe(true);
    }
  });

  it('never hides the current segment s name or its action, at any step', () => {
    // The floor: the name says where the ticket is and the button says what is
    // wanted. Both survive to 300px.
    for (const step of ['snug', 'tight', 'bare']) {
      const rules = HTML.match(new RegExp(`\\.track\\.${step}[^{]*\\{[^}]*display:none[^}]*\\}`, 'g')) || [];
      for (const rule of rules) {
        expect(rule, `${step} hides the current name`).not.toMatch(/\.seg\.cur \.nm\{|\.seg\.cur \.nm,/);
        expect(rule, `${step} hides the current action`).not.toMatch(/\.seg\.cur \.go/);
      }
    }
  });

  it('measures rather than positions — the track pushes no geometry from the host', () => {
    // The old rail bolted a second lane to specific columns with calc() inputs.
    // There is no second lane, so the one measurement left picks a class and
    // positions nothing.
    expect(HTML).toContain('lane.scrollWidth > lane.clientWidth');
    expect(HTML).not.toMatch(/--cols:\$\{/);
  });

  it('makes the needs-you button navigational, never a second actor', () => {
    // karst never performs an irreversible step from the rail: merge is per-repo
    // and its confirmation lives in the host.
    expect(HTML).toContain('data-goto');
    expect(HTML).toMatch(/function gotoAction\(\)/);
    expect(HTML).toMatch(/gotoAction[\s\S]{0,400}scrollIntoView/);
    // It must post nothing.
    const fn = HTML.slice(HTML.indexOf('function gotoAction()'));
    expect(fn.slice(0, fn.indexOf('\n  }'))).not.toContain('post(');
  });

  it('fills a phase pip only for a phase the agent reported', () => {
    // Declared is not observed. A hollow pip means "not reported", never "not
    // done".
    expect(HTML).toContain('approach.reported');
    expect(HTML).toMatch(/done\.has\(p\)/);
  });

  it('stops the spinner and the needs-you breathe under reduced motion', () => {
    expect(HTML).toMatch(/prefers-reduced-motion:reduce\)\{[^}]*\.track \.seg\.needs\{?animation:none|prefers-reduced-motion:reduce\)\{\s*\.spin,\.track \.seg\.needs\{animation:none/);
  });

  it('scopes every new track selector, so it cannot collide with the strip', () => {
    // The dashboard already owns `.act` (the activity strip) and `.ph*`.
    expect(HTML).not.toMatch(/^\s*\.seg\{/m);
    expect(HTML).not.toMatch(/^\s*\.fixm\{/m);
    expect(HTML).toMatch(/\.track \.seg\{/);
  });
```

- [ ] **Step 3: Run to verify they fail before the file is right, then pass**

Run: `npx vitest run src/ui/dashboard/webview.test.ts`
Expected: PASS if Tasks 7 and 8 landed exactly as written. Any failure is a real mismatch between the pin and the markup — fix whichever is wrong, and prefer changing the markup when the pin states the rule from the spec.

The reduced-motion pin's regex is brittle by nature; if it fails only on whitespace, simplify it to two assertions (`expect(HTML).toMatch(/prefers-reduced-motion:reduce/)` and `expect(HTML).toMatch(/\.track \.seg\.needs\b[^}]*animation:none|\.spin,\.track \.seg\.needs\{animation:none/)`) rather than loosening it to nothing.

- [ ] **Step 4: Run the whole webview guard set**

Run: `npx vitest run src/ui/designSystem.test.ts src/ui/webviewCsp.test.ts src/ui/dashboard/`
Expected: PASS, with `designSystem.test.ts` and `webviewCsp.test.ts` unedited — both discover the dashboard directory, so a track that shipped outside the system would fail there.

- [ ] **Step 5: Commit**

```bash
git add src/ui/dashboard/webview.test.ts
git commit -m "test: pin the stage track's structure, a11y and narrow-width degradation"
```

---

### Task 10: Full verification and the design record

**Files:**
- Modify: `docs/design/stages/README.md`

- [ ] **Step 1: Run everything**

Run: `npm run typecheck && npm test`
Expected: PASS. Note the totals.

- [ ] **Step 2: Build**

Run: `npm run build`
Expected: success, and `dist/ui/dashboard/webview.html` contains the track (`scripts/copy-assets.mjs` mirrors it). Verify:

```bash
grep -c 'renderTrack' dist/ui/dashboard/webview.html
```

Expected: `1` or more. Never edit the `dist/` copy.

- [ ] **Step 3: Walk the UI rules**

Read `docs/ui/UI-RULES.md` and check the track against each rule with a Check that applies. The ones this change touches directly: R01 (no framework), R04/R05 (tokens only, `--trk-*` declared as component dimensions with a comment), R08 (no bespoke pill), R09 (action is a `<button>`, no clickable `div`), R10b (nothing destructive here), R11–R14 (no host round trip from the rail, so no pending state is required — say so if a reviewer asks), R16 (no `string` vocabularies added), R19–R21/R24 (matching `aria-label`/`title`, ≤80 chars — check the longest: a needs-you merge segment with a live meter), R28 (four carriers), R30 (reduced motion), R34 (untouched mirrors). Fix anything that fails before committing.

- [ ] **Step 4: Check the accessible name length**

Run:

```bash
node -e "
const t='Implementation: needs you — fix attempt 3 of 3, running, revalidates from uat';
console.log(t.length, t.length<=80 ? 'ok' : 'OVER — shorten the retry clause');
"
```

If it reports OVER, shorten the retry clause in `renderTrack`'s `aria` (e.g. `fix 3/3 running, revalidates from uat`) and update the Task 9 pin for `fix attempt … of …` to match the new wording.

- [ ] **Step 5: Update the design record**

In `docs/design/stages/README.md`, add one paragraph under the "Second round" section:

```markdown
Variant E shipped in `src/ui/dashboard/webview.html`. The plan it was built from
is `docs/superpowers/plans/2026-08-02-stage-flow-nodes.md`. As with variant A, the
mockup is kept as the record of what was approved and why — and, unlike A's, it
also carries the measurement loop that produced the 300px floor. Re-run that loop
rather than assuming the number holds if a segment gains content.
```

- [ ] **Step 6: Commit**

```bash
git add docs/design/stages/README.md
git commit -m "docs: record that variant E shipped, and where the 300px floor is measured"
```

---

## Notes for the implementer

**Two things the spec left open, resolved here.** The spec's `RailSegment` carries `needsUser: boolean` but its state table also demands the segment show a *reason* and *name an action*. Copy is host-rendered everywhere in this codebase, so this plan adds `RailNeeds { detail, action }` in a new module (Task 4) and hangs it on the segment beside the boolean. The boolean stays because it is the tested derivation flag; `needs` is only the wording, and it is null unless the boolean is true. Likewise, the spec says the impl pips' filled state comes from `reportedPhases` but does not say how it reaches the webview: it rides on `DashboardState.approach.reported` (Task 5).

**Order matters in two places.** Task 3 imports a type from Task 4, so do Task 4 first or stub the import. Task 6 will not typecheck until Task 5 has landed.

**`npm test` rebuilds `better-sqlite3` for Node** via `pretest`. After running tests, F5 in VS Code re-copies the Electron prebuild via `dev:extension` — this is normal and needs no action.
