# Stale State of Inside Processes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Inside panel present each gate stage's CURRENT invocation — so a second (or later) recovery round never renders the previous round's failed gates, findings or observations as the live state.

**Architecture:** The inside model already scopes evidence per *attempt* (`model/inside/rounds.ts`), but "the latest attempt" is derived from the newest **recorded** row (`gate_runs.runAt`, greatest `process_runs.id`). A re-entered stage has recorded nothing yet, so that reduction hands back the *previous* round's rows and the ledger renders them as current — red gates, red findings. The fix threads the one table that records an invocation *at entry* rather than at outcome — `stage_runs` (v25) — into the inside model. A new pure selector resolves the stage's current attempt from `stage_runs` + the stage row's entry stamp; the quality reducers key their batch, AI process run and findings to it; when the current invocation has recorded nothing yet the ledger renders EMPTY (pending/running), never a predecessor's rows. Prior attempts stay reachable: the round switcher gains a synthetic `live` tab for the attempt with no rows yet.

**Tech Stack:** TypeScript (ESM, `.js` import suffixes), vitest, better-sqlite3 via `openStore(':memory:')`.

**Spec:** This plan is written from the ticket prompt (STALE-STATE-OF-INSIDE-PROCESSES). The binding reference documents for the code it touches are `docs/arch/stages-and-gates.md` (stage graph, append-only gate evidence), `docs/arch/store-and-schema.md` (store reads) and `docs/ui/UI-RULES.md` + `docs/ui/UI-INVARIANTS.md` (every banner is host-authored, UI-R31).

## Global Constraints

- ESM: every relative import carries a `.js` suffix; `moduleResolution: Bundler`.
- `noUncheckedIndexedAccess` is on: array access needs `!` or a guard.
- `strict: true`; `exactOptionalPropertyTypes` is NOT set, so assigning `undefined` to an optional property is legal.
- Host-agnostic: nothing under `src/model/` may import `vscode`.
- Append-only evidence: no task here deletes, rewrites or backfills a `gate_runs`, `process_runs`, `review_findings`, `uat_findings` or `stage_runs` row. This is a READ/PRESENTATION fix only — no schema change, no migration.
- No inferred verdicts: a status of `pass`/`fail`/`run` requires a RECORDED row. "Nothing recorded for the current invocation" renders as pending/running/absence, never as a verdict.
- UI-R31: all banner prose is host-authored and rendered verbatim by the webview; the webview composes no sentences.
- Strict TDD: RED → GREEN per task. Conventional commits. Files stay under ~400 lines where practical.
- Commands: `npm run test:unit`, `npm run typecheck`. Single test: `npx vitest run src/path/to.test.ts`.
- Commit trailer for every commit in this plan:
  `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`

---

## Background: exactly why it goes stale

Read this once before Task 1; every task below depends on it.

1. A gate stage (`uat` / `review`) fails. `commitGateOutcome` opens a recovery round; the ticket moves to `fix`.
2. The fix lands. `transition(store, id, 'fix', {kind:'passed'})` → `machine.ts`'s `entryPatch` writes the gate stage row `status:'running', verdict:null, startedAt:<now>, endedAt:null`.
3. The driver has not yet opened the new `stage_runs` row / has not yet finished the first gate, so `gate_runs`, `process_runs`, `review_findings` and `uat_findings` hold **only round 1's rows**.
4. `model/inside/gates.ts` resolves its batch through `batchForAttempt(runs, stageKey, null)` → `latestBatchLocal` → greatest `runAt` → **round 1's failed batch**. `processRunForAttempt(processRuns, 'review', null)` → greatest id → **round 1's Review run**, whose `endedAt` is non-null and which owns findings, so `scopeReviewFindings` returns **round 1's blocking findings**.
5. The ledger therefore renders round 1's red gates and red findings as the live picture of round 2 — until the new rows land and overwrite the reading. That is exactly the reported symptom.

The missing fact is "which invocation is the stage on RIGHT NOW". `gate_runs` cannot answer it (it records that a gate FINISHED). `stage_runs` can: `openStageRun` writes a row **before the first gate starts**. `src/store/stageRuns.ts` already exposes `listStageRuns(store, ticketId)`. Nothing in `src/ui/` reads it today — that is the gap this plan closes.

## File Structure

**Created**

- `src/model/inside/currentAttempt.ts` — one responsibility: resolve a gate stage's CURRENT attempt key from `stage_runs` plus the stage row's entry stamp. Pure, ~40 lines.
- `src/model/inside/currentAttempt.test.ts` — its unit tests.

**Modified**

- `src/model/inside/rounds.ts` — `listGateAttempts` gains an optional `currentAttempt`, so an in-flight attempt that has recorded no gate row still gets a tab; `attemptStatus` answers `pending` for an empty group.
- `src/model/inside/gates.ts` — `QualityProcessesInput` gains `currentAttempt`; one new private `effectiveAttempt` resolver; `gatesProcess`, `testerProcess` and `reviewProcess` read through it.
- `src/ui/dashboard/state.ts` — reads `listStageRuns` once, resolves each gate stage's current attempt, passes it to `listGateAttempts` and to both quality reducers; adds the host-authored superseded banner for a gate stage whose recorded result predates an in-flight recovery round.
- `src/model/inside/rounds.test.ts`, `src/model/inside/gates.test.ts`, `src/ui/dashboard/state.test.ts` — the tests for the above.

**Not modified** — and deliberately so:

- `src/store/*` — no schema change, no migration, no new column.
- `src/workflow/*` — the runtime already records everything needed.
- `src/ui/dashboard/webview.html` — `attemptNote` already exists and is rendered verbatim above the ledger (webview.html:2559); Task 5 reuses it rather than adding a second banner mechanism.
- `src/model/findingScope.ts` — `scopeReviewFindings` is already correct **given the right run**; this plan fixes which run it is given.

---

### Task 1: `currentAttemptFor` — which invocation is the stage on now

**Files:**
- Create: `src/model/inside/currentAttempt.ts`
- Test: `src/model/inside/currentAttempt.test.ts`

**Interfaces:**
- Consumes: `StageRun` from `../../store/stageRuns.js`; `attemptKey(stageRunId, runAt)` and `AttemptKey` from `./rounds.js`; `StageKey` from `../types.js`.
- Produces:
  - `export type CurrentAttempt = AttemptKey | null | undefined`
  - `export function currentAttemptFor(stageRuns: readonly StageRun[], stageKey: StageKey, enteredAt: string | undefined): CurrentAttempt`

  The three-valued return is the whole point and later tasks branch on it:
  - `undefined` — this stage has **no** `stage_runs` row at all (a pre-v25 ticket, or a stage that never ran). Callers must keep the existing latest-by-`runAt` behaviour byte-for-byte.
  - `null` — a stage run exists but the stage was **re-entered after** it: the current invocation has opened nothing yet, so the live ledger is EMPTY.
  - an `AttemptKey` — the rows of that stage run are the live picture.

- [ ] **Step 1: Write the failing test**

Create `src/model/inside/currentAttempt.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import type { StageRun } from '../../store/stageRuns.js';
import { currentAttemptFor } from './currentAttempt.js';

function run(over: Partial<StageRun> & { id: number }): StageRun {
  return {
    ticketId: 1,
    stageKey: 'uat',
    attempt: 0,
    runAt: '2026-09-18T10:00:00.000Z',
    status: 'finished',
    outcome: 'blocked',
    manifestHash: null,
    pid: null,
    startedAt: '2026-09-18T10:00:00.000Z',
    endedAt: '2026-09-18T10:01:00.000Z',
    ...over,
  } as StageRun;
}

describe('currentAttemptFor', () => {
  it('is undefined when the stage recorded no stage run at all', () => {
    expect(currentAttemptFor([], 'uat', '2026-09-18T10:00:00.000Z')).toBeUndefined();
  });

  it('is undefined when every recorded run belongs to another stage', () => {
    expect(currentAttemptFor([run({ id: 1, stageKey: 'review' })], 'uat', undefined)).toBeUndefined();
  });

  it('names the newest run of the stage when the stage entry predates it', () => {
    const runs = [
      run({ id: 1, startedAt: '2026-09-18T10:00:00.000Z' }),
      run({ id: 2, startedAt: '2026-09-18T12:00:00.000Z' }),
    ];
    expect(currentAttemptFor(runs, 'uat', '2026-09-18T11:59:00.000Z')).toBe('sr:2');
  });

  it('picks the newest run by id, never by array position', () => {
    const runs = [
      run({ id: 2, startedAt: '2026-09-18T12:00:00.000Z' }),
      run({ id: 1, startedAt: '2026-09-18T10:00:00.000Z' }),
    ];
    expect(currentAttemptFor(runs, 'uat', undefined)).toBe('sr:2');
  });

  it('is null when the stage was re-entered after its newest recorded run — round 2 with nothing recorded', () => {
    const runs = [run({ id: 1, startedAt: '2026-09-18T10:00:00.000Z' })];
    // The fix landed and `entryPatch` re-entered uat at 13:00.
    expect(currentAttemptFor(runs, 'uat', '2026-09-18T13:00:00.000Z')).toBeNull();
  });

  it('names the run when the stage entry is exactly the run start (same-instant open)', () => {
    const runs = [run({ id: 4, startedAt: '2026-09-18T13:00:00.000Z' })];
    expect(currentAttemptFor(runs, 'uat', '2026-09-18T13:00:00.000Z')).toBe('sr:4');
  });

  it('names the newest run when the stage row carries no entry stamp', () => {
    const runs = [run({ id: 7 })];
    expect(currentAttemptFor(runs, 'uat', undefined)).toBe('sr:7');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/model/inside/currentAttempt.test.ts`
Expected: FAIL — `Failed to resolve import "./currentAttempt.js"`.

- [ ] **Step 3: Write minimal implementation**

Create `src/model/inside/currentAttempt.ts`:

```ts
import type { StageRun } from '../../store/stageRuns.js';
import type { StageKey } from '../types.js';
import { attemptKey, type AttemptKey } from './rounds.js';

/**
 * Which invocation a gate stage is on RIGHT NOW — the fact no evidence table
 * can answer.
 *
 * `gate_runs`, `process_runs` and the findings tables all record that work
 * FINISHED, so a stage the fix cycle has just re-entered still reduces to its
 * PREVIOUS round's rows: the newest `runAt`, the greatest process-run id, the
 * findings that run owns. Rendering that as the live ledger is what showed a
 * fixed round's red gates and blocking findings under round 2.
 *
 * `stage_runs` (v25) is the one table written at ENTRY (`openStageRun`, before
 * the first gate starts), so it is the only thing that can say an invocation
 * exists before it has produced anything.
 *
 * Three answers, and the difference between the last two is the whole point:
 *
 *  - `undefined` — the stage has NO `stage_runs` row (a pre-v25 ticket, or a
 *    stage that never ran). Callers must fall back to the latest-by-`runAt`
 *    reduction, byte-for-byte: a legacy ticket's rows carry no stage run id and
 *    narrowing to one would empty its ledger.
 *  - `null` — a run exists, but the stage row was re-entered AFTER it started.
 *    The current invocation has opened nothing yet, so the live ledger is
 *    EMPTY. Absence, never a predecessor's verdict.
 *  - an `AttemptKey` — the rows of that stage run are the live picture.
 *
 * The newest run is chosen by `id`, never by array position: `listStageRuns`
 * orders by id today, but no query contract obliges it to, and this module
 * refuses to trust ordering anywhere (the same rule `rounds.ts` documents).
 */
export type CurrentAttempt = AttemptKey | null | undefined;

export function currentAttemptFor(
  stageRuns: readonly StageRun[],
  stageKey: StageKey,
  /** The stage row's current entry stamp — `StepperCell.startedAt`. */
  enteredAt: string | undefined,
): CurrentAttempt {
  let current: StageRun | undefined;
  for (const run of stageRuns) {
    if (run.stageKey !== stageKey) continue;
    if (current === undefined || run.id > current.id) current = run;
  }
  if (current === undefined) return undefined;
  // A stage entered after its newest run STARTED is on an invocation that has
  // not opened yet. `<` and not `<=`: `openStageRun` and `entryPatch` can land
  // on the same instant, and a run opened for THIS entry is this entry's run.
  if (enteredAt !== undefined && current.startedAt < enteredAt) return null;
  return attemptKey(current.id, current.runAt);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/model/inside/currentAttempt.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: exit 0, no output.

- [ ] **Step 6: Commit**

```bash
git add src/model/inside/currentAttempt.ts src/model/inside/currentAttempt.test.ts
git commit -m "$(cat <<'EOF'
feat: resolve a gate stage's current attempt from stage_runs

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: the quality reducers read the current attempt

**Files:**
- Modify: `src/model/inside/gates.ts` (`QualityProcessesInput`; new private `effectiveAttempt`; `gatesProcess`, `testerProcess`, `reviewProcess`, `uatProcesses`, `reviewProcesses`)
- Test: `src/model/inside/gates.test.ts` (append a new `describe`)

**Interfaces:**
- Consumes: `CurrentAttempt` / `currentAttemptFor` from `./currentAttempt.js` (Task 1).
- Produces: `QualityProcessesInput` gains
  ```ts
  currentAttempt?: CurrentAttempt;
  ```
  Absent/`undefined` reproduces today's behaviour exactly. Task 4 (`state.ts`) is the only production caller that sets it.

- [ ] **Step 1: Write the failing test**

Append to `src/model/inside/gates.test.ts`. Match the existing file's local fixture helpers — open it first and reuse whatever `gateRun(...)` / `processRun(...)` builders it already defines rather than adding parallel ones. If it defines none, add these two locally inside the new `describe`:

```ts
describe('the current attempt (round 2 staleness)', () => {
  const R1 = '2026-09-18T10:00:00.000Z';
  const NOW = '2026-09-18T13:05:00.000Z';

  function failedGate(stageRunId: number): GateRun {
    return {
      id: 1,
      ticketId: 1,
      stageKey: 'uat',
      attempt: 1,
      runAt: R1,
      gateName: 'test (web)',
      command: 'npm',
      args: 'test',
      exitCode: 1,
      skipped: false,
      repo: '/wt/web',
      stageRunId,
      startedAt: R1,
      endedAt: R1,
    } as unknown as GateRun;
  }

  function testerRun(id: number, stageRunId: number): ProcessRun {
    return {
      id,
      ticketId: 1,
      processId: 'tester',
      status: 'passed',
      resultKind: 'observed',
      stageRunId,
      provider: 'claude',
      model: 'opus',
      agentName: null,
      startedAt: R1,
      endedAt: R1,
    } as unknown as ProcessRun;
  }

  const runningCell = { stageKey: 'uat', status: 'running', startedAt: '2026-09-18T13:00:00.000Z' } as StepperCell;

  const base = {
    cell: runningCell,
    findings: [],
    uatFindings: [],
    rounds: [],
    services: [],
    now: NOW,
  };

  it('renders no gate rows for a fresh invocation that has recorded nothing (currentAttempt null)', () => {
    const processes = uatProcesses({
      ...base,
      gateRuns: [failedGate(1)],
      processRuns: [testerRun(10, 1)],
      currentAttempt: null,
    });
    const gates = processes.find((p) => p.id === 'gates')!;
    expect(gates.evidence).toMatchObject({ kind: 'gates', rows: [], failed: 0, passed: 0 });
    expect(gates.status).toBe('run');
    expect(gates.detail).not.toContain('failed');
  });

  it('renders no Tester observations for a fresh invocation', () => {
    const processes = uatProcesses({
      ...base,
      gateRuns: [failedGate(1)],
      processRuns: [testerRun(10, 1)],
      uatFindings: [
        {
          id: 1,
          ticketId: 1,
          processRunId: 10,
          severity: 'high',
          title: 'round 1 observation',
          filePath: 'a.ts',
          line: 3,
          repo: '/wt/web',
          runAt: R1,
        } as unknown as UatFinding,
      ],
      currentAttempt: null,
    });
    const tester = processes.find((p) => p.id === 'tester')!;
    expect(tester.evidence).toMatchObject({ kind: 'findings', rows: [] });
    expect(tester.status).not.toBe('fail');
    expect(tester.detail).toBeUndefined();
  });

  it('renders no Review findings for a fresh invocation', () => {
    const processes = reviewProcesses({
      ...base,
      cell: { stageKey: 'review', status: 'running', startedAt: '2026-09-18T13:00:00.000Z' } as StepperCell,
      gateRuns: [{ ...failedGate(1), stageKey: 'review' } as GateRun],
      processRuns: [{ ...testerRun(11, 1), processId: 'review', resultKind: 'blocking' } as ProcessRun],
      findings: [
        {
          id: 1,
          ticketId: 1,
          processRunId: 11,
          severity: 'critical',
          title: 'round 1 blocker',
          file: 'a.ts',
          line: 3,
          repo: '/wt/web',
          runAt: R1,
        } as unknown as Finding,
      ],
      currentAttempt: null,
    });
    const review = processes.find((p) => p.id === 'review')!;
    expect(review.evidence).toMatchObject({ kind: 'findings', rows: [], blocking: 0 });
    expect(review.aggregate).toBeUndefined();
    expect(review.detail).toBeUndefined();
  });

  it('renders the named attempt when the current invocation HAS recorded rows', () => {
    const processes = uatProcesses({
      ...base,
      gateRuns: [failedGate(1)],
      processRuns: [testerRun(10, 1)],
      currentAttempt: 'sr:1',
    });
    const gates = processes.find((p) => p.id === 'gates')!;
    expect(gates.evidence).toMatchObject({ failed: 1 });
    expect(gates.status).toBe('fail');
  });

  it('falls back to latest-by-runAt when no stage run is on record (currentAttempt undefined)', () => {
    const processes = uatProcesses({
      ...base,
      gateRuns: [failedGate(1)],
      processRuns: [testerRun(10, 1)],
    });
    const gates = processes.find((p) => p.id === 'gates')!;
    expect(gates.evidence).toMatchObject({ failed: 1 });
  });

  it('an explicit historical selection still wins over the current attempt', () => {
    const processes = uatProcesses({
      ...base,
      gateRuns: [failedGate(1)],
      processRuns: [testerRun(10, 1)],
      currentAttempt: null,
      selectedAttempt: 'sr:1',
    });
    const gates = processes.find((p) => p.id === 'gates')!;
    expect(gates.evidence).toMatchObject({ failed: 1 });
  });
});
```

Add whatever imports the new block needs to the top of `gates.test.ts` (`uatProcesses`, `reviewProcesses`, and the `GateRun` / `ProcessRun` / `Finding` / `UatFinding` / `StepperCell` types) if they are not already imported there.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/model/inside/gates.test.ts -t 'current attempt'`
Expected: FAIL — the first three cases report the round-1 rows (`failed: 1`, a populated findings list) because `currentAttempt` is not read yet.

- [ ] **Step 3: Write the implementation**

**3a.** Add the import at the top of `src/model/inside/gates.ts`, beside the existing `./rounds.js` import:

```ts
import type { CurrentAttempt } from './currentAttempt.js';
```

**3b.** Add the field to `QualityProcessesInput`, directly after the existing `selectedAttempt` field:

```ts
  /**
   * Which invocation the stage is on RIGHT NOW (`currentAttempt.ts`), resolved
   * host-side from `stage_runs`. This is what stops a re-entered stage
   * rendering its PREVIOUS round's rows as the live ledger: every evidence
   * table records that work finished, so the fix cycle's round 2 reduces to
   * round 1 until new rows land.
   *
   *  - absent/`undefined` — no stage run on record (pre-v25, or never ran):
   *    the latest-by-`runAt` reduction stands, byte-for-byte.
   *  - `null` — the current invocation has recorded nothing yet: the ledger is
   *    EMPTY, and the predecessor's rows are history reachable through the
   *    round switcher, never the live picture.
   *  - an `AttemptKey` — that stage run's rows ARE the live picture.
   *
   * `selectedAttempt` (the reader's explicit tab choice) always wins over this:
   * choosing a historical tab is a deliberate request for a settled attempt.
   */
  currentAttempt?: CurrentAttempt;
```

**3c.** Add the resolver, directly above `gatesProcess`:

```ts
/**
 * Which attempt's rows back this render, and whether there are any.
 *
 * ONE resolution, shared by the gates row and both AI rows: two answers to
 * "which attempt am I showing" is precisely how a batch of one attempt ends up
 * beside another's findings.
 */
interface EffectiveAttempt {
  /** The key to select rows by — `null` keeps the latest-by-`runAt` reduction. */
  key: AttemptKey | null;
  /** The current invocation has recorded nothing yet: select NOTHING. */
  empty: boolean;
  /** The reader explicitly asked for a past attempt (never the live picture). */
  historical: boolean;
}

function effectiveAttempt(input: QualityProcessesInput): EffectiveAttempt {
  const selected = input.selectedAttempt ?? null;
  if (selected !== null) return { key: selected, empty: false, historical: true };
  const current = input.currentAttempt;
  if (current === undefined) return { key: null, empty: false, historical: false };
  if (current === null) return { key: null, empty: true, historical: false };
  return { key: current, empty: false, historical: false };
}
```

**3d.** Change `gatesProcess`'s last parameter from `selectedAttempt: AttemptKey | null = null` to `eff: EffectiveAttempt = { key: null, empty: false, historical: false }`, and inside it replace the batch and AI-run reads:

```ts
  const batch = eff.empty
    ? []
    : batchForAttempt(runs, stageKey, eff.key).filter((r) => r.gateName !== CHANGES_GATE);
```

```ts
  const settled = isSettledSelection(runs, stageKey, eff.historical ? eff.key : null);
```

```ts
  const aiRun = eff.empty ? undefined : processRunForAttempt(processRuns, aiProcessId, eff.key);
```

Leave every other line of `gatesProcess` untouched: with `batch === []` and `running === true` it already renders `status: 'run'` and the detail `'running the first gate — each result lands here as it finishes'`, which is the correct picture of a fresh invocation.

**3e.** In `testerProcess`, replace the first two lines of the body:

```ts
  const eff = effectiveAttempt(input);
  const run = eff.empty ? undefined : processRunForAttempt(input.processRuns, 'tester', eff.key);
```

and change the absence branch's guard from `selectedAttempt !== null` to `eff.historical`:

```ts
        : eff.historical
        ? { detail: NO_RUN_FOR_ATTEMPT_DETAIL }
        : {}),
```

**3f.** In `reviewProcess`, replace the first three statements of the body:

```ts
  const eff = effectiveAttempt(input);
  const run = eff.empty ? undefined : processRunForAttempt(input.processRuns, 'review', eff.key);
  // A fresh invocation selects NOTHING. Otherwise: an explicit historical tab
  // reads that run's own attributed rows, and the live picture goes through
  // `scopeReviewFindings`, which owns the in-flight and pre-v27 rules (a clean
  // re-review writes no batch, so a `runAt` reduction never supersedes).
  const batch = eff.empty
    ? []
    : eff.historical
      ? run
        ? input.findings.filter((f) => f.processRunId === run.id)
        : []
      : scopeReviewFindings(input.findings, run);
```

and change its absence branch's guard the same way:

```ts
      : eff.historical
        ? { detail: NO_RUN_FOR_ATTEMPT_DETAIL }
        : {}),
```

**3g.** In `stageRecovery`, scope the rounds to nothing when the invocation is fresh — a completed round's Fix row must not read as this attempt's work in flight:

```ts
function stageRecovery(
  input: QualityProcessesInput,
  stageKey: 'uat' | 'review',
): ReturnType<typeof recoveryProcess> {
  const eff = effectiveAttempt(input);
  const selected = input.selectedAttempt ?? null;
  const latest = latestAttemptKey(input.gateRuns, stageKey);
  const isLatest = selected === null || selected === latest;
  return recoveryProcess(
    eff.empty ? [] : roundsForAttempt(input.rounds, stageKey, selected, latest),
    input.processRuns,
    input.now,
    input.configured,
    isLatest && displayStatus(input.cell) === 'passed',
  );
}
```

**3h.** In both `uatProcesses` and `reviewProcesses`, compute the resolution once and pass it to `gatesProcess` in place of the old `input.selectedAttempt ?? null` argument:

```ts
export function uatProcesses(input: QualityProcessesInput): InsideProcessView[] {
  const eff = effectiveAttempt(input);
  const processes = [
    gatesProcess(
      input.cell,
      input.gateRuns,
      'uat',
      input.now,
      input.resolvedGates ?? [],
      input.repoNameFor,
      input.processRuns,
      eff,
    ),
    servicesProcess(input.cell, input.services),
    testerProcess(input),
  ];
  return insertCausalFix(processes, stageRecovery(input, 'uat'));
}
```

and the identical shape in `reviewProcesses` with `'review'` and `reviewProcess(input)`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/model/inside/gates.test.ts`
Expected: PASS — the new block **and** every pre-existing test in the file (they pass no `currentAttempt`, so they take the `undefined` fall-back).

- [ ] **Step 5: Run the neighbouring model suites**

Run: `npx vitest run src/model/inside`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/model/inside/gates.ts src/model/inside/gates.test.ts
git commit -m "$(cat <<'EOF'
fix: stop the quality reducers rendering the previous round's evidence

A re-entered gate stage has recorded nothing yet, so the latest-by-runAt
reduction handed back round 1's failed gates, findings and observations and
the ledger rendered them as the live picture. The reducers now key to the
stage's current stage_runs invocation and render absence when it has
produced nothing.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: a tab for the attempt that has recorded nothing

**Files:**
- Modify: `src/model/inside/rounds.ts` (`ListGateAttemptsInput`, `attemptStatus`, `listGateAttempts`)
- Test: `src/model/inside/rounds.test.ts`

**Interfaces:**
- Consumes: `AttemptKey` (already in this module).
- Produces: `ListGateAttemptsInput` gains
  ```ts
  currentAttempt?: AttemptKey | null;
  ```
  When set to a key that no recorded group holds, a synthetic newest group is appended so the fresh attempt is a tab. `null`/absent changes nothing.

Without this, Task 2 leaves a fresh round 2 showing an empty uat ledger with **no** tabs (one recorded group → `listGateAttempts` returns `[]`), so round 1's evidence becomes unreachable. This task restores it.

- [ ] **Step 1: Write the failing test**

Append to `src/model/inside/rounds.test.ts` (reuse the file's existing `GateRun` fixture helper; the shape below is what to assert):

```ts
describe('listGateAttempts: the live attempt with no recorded rows', () => {
  it('adds a synthetic newest tab for a current attempt no group holds', () => {
    const attempts = listGateAttempts({
      gateRuns: [gateRun({ stageRunId: 1, runAt: '2026-09-18T10:00:00.000Z', exitCode: 1 })],
      processRuns: [],
      rounds: [],
      stageKey: 'uat',
      running: true,
      currentAttempt: 'sr:2',
    });
    expect(attempts).toHaveLength(2);
    expect(attempts[0]).toMatchObject({ key: 'sr:1', status: 'fail', latest: false });
    expect(attempts[1]).toMatchObject({ key: 'sr:2', label: 'live', status: 'run', latest: true });
    expect(attempts[1]!.time).toBeUndefined();
  });

  it('reads the live tab as pending when the stage is not running', () => {
    const attempts = listGateAttempts({
      gateRuns: [gateRun({ stageRunId: 1, runAt: '2026-09-18T10:00:00.000Z', exitCode: 1 })],
      processRuns: [],
      rounds: [],
      stageKey: 'uat',
      running: false,
      currentAttempt: 'sr:2',
    });
    expect(attempts[1]).toMatchObject({ key: 'sr:2', label: 'latest', status: 'pending', statusLabel: 'pending' });
  });

  it('adds nothing when the current attempt already has recorded rows', () => {
    const attempts = listGateAttempts({
      gateRuns: [
        gateRun({ stageRunId: 1, runAt: '2026-09-18T10:00:00.000Z', exitCode: 1 }),
        gateRun({ stageRunId: 2, runAt: '2026-09-18T12:00:00.000Z', exitCode: 0 }),
      ],
      processRuns: [],
      rounds: [],
      stageKey: 'uat',
      running: false,
      currentAttempt: 'sr:2',
    });
    expect(attempts.map((a) => a.key)).toEqual(['sr:1', 'sr:2']);
  });

  it('emits no tabs for a single recorded attempt when no current attempt is given', () => {
    const attempts = listGateAttempts({
      gateRuns: [gateRun({ stageRunId: 1, runAt: '2026-09-18T10:00:00.000Z', exitCode: 1 })],
      processRuns: [],
      rounds: [],
      stageKey: 'uat',
      running: false,
    });
    expect(attempts).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/model/inside/rounds.test.ts -t 'live attempt with no recorded rows'`
Expected: FAIL — the first two cases get `[]` (one group, so the `< 2` guard returns no tabs).

- [ ] **Step 3: Write the implementation**

**3a.** Add the field to `ListGateAttemptsInput`, after `running`:

```ts
  /**
   * The stage's CURRENT invocation (`currentAttempt.ts`), when the host knows
   * it. An invocation that has recorded no gate row yet holds no group here —
   * it is the fix cycle's fresh round, and without a synthetic tab for it the
   * switcher vanishes exactly when the reader most needs to reach the round
   * before it. `null`/absent adds nothing.
   */
  currentAttempt?: AttemptKey | null;
```

**3b.** Make `attemptStatus` answer for an empty group — only a synthetic one is ever empty:

```ts
function attemptStatus(runs: readonly GateRun[]): InsideStatus {
  // A synthetic live group: the invocation is open and has recorded nothing.
  // Absence, not a verdict — `listGateAttempts` overrides this with `run`
  // while the stage is actually running.
  if (runs.length === 0) return 'pending';
  const failed = runs.some((r) => !r.skipped && r.exitCode !== null && r.exitCode !== 0);
  if (failed) return 'fail';
  const answered = runs.some((r) => !r.skipped && r.exitCode !== null);
  return answered ? 'pass' : 'note';
}
```

**3c.** In `listGateAttempts`, insert the synthetic group between `groupAttempts` and the `< 2` guard:

```ts
export function listGateAttempts(input: ListGateAttemptsInput): GateAttemptView[] {
  const groups = groupAttempts(input.gateRuns, input.stageKey);
  // The current invocation may have recorded nothing yet (the fix cycle's
  // fresh round). It is still an attempt — and the NEWEST one — so it gets a
  // tab, or the switcher disappears the moment a round reopens and the
  // previous round's evidence becomes unreachable. Appended AFTER the sort:
  // `groupAttempts` returns oldest→newest, and an invocation with no rows has
  // no `runAt` to sort by.
  const current = input.currentAttempt ?? null;
  if (current !== null && !groups.some((g) => g.key === current)) {
    groups.push({ key: current, runs: [], order: '' });
  }
  if (groups.length < 2) return [];
  // …unchanged from here…
```

Everything below is already correct for the synthetic group: `isLatest` is true for it (it is last), the label resolves to `live`/`latest`, `attemptEarliestStart([])` returns `undefined` so no `time` is emitted, and `roundByKey` holds no entry for it.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/model/inside/rounds.test.ts`
Expected: PASS — the new block and every pre-existing test in the file.

- [ ] **Step 5: Commit**

```bash
git add src/model/inside/rounds.ts src/model/inside/rounds.test.ts
git commit -m "$(cat <<'EOF'
feat: give the round switcher a tab for the in-flight attempt

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: wire the dashboard state to `stage_runs`

**Files:**
- Modify: `src/ui/dashboard/state.ts`
- Test: `src/ui/dashboard/state.test.ts`

**Interfaces:**
- Consumes: `currentAttemptFor` / `CurrentAttempt` (Task 1); `QualityProcessesInput.currentAttempt` (Task 2); `ListGateAttemptsInput.currentAttempt` (Task 3); `listStageRuns(store, ticketId): StageRun[]` from `../../store/stageRuns.js`.
- Produces: no signature change to `buildDashboardState` — it reads the store itself, exactly as it already does for `listGateRuns` / `listProcessRuns`. Nothing in `panel.ts` changes.

- [ ] **Step 1: Write the failing test**

Append to `src/ui/dashboard/state.test.ts`. Reuse the file's existing store fixture (an in-memory `openStore(':memory:')` with a created ticket) — open it first and follow whatever helper it already uses to make a ticket; write only the round-2 arrangement yourself:

```ts
describe('inside: a re-entered gate stage shows the current invocation', () => {
  it('renders no gate rows and no observations for a uat round 2 that has recorded nothing', () => {
    // Arrange: round 1 ran and failed, the fix landed, uat was re-entered.
    const id = /* the fixture's ticket id */;
    const r1 = openStageRun(store, {
      ticketId: id,
      stageKey: 'uat',
      attempt: 1,
      runAt: '2026-09-18T10:00:00.000Z',
      startedAt: '2026-09-18T10:00:00.000Z',
    });
    recordGateRuns(store, {
      ticketId: id,
      stageKey: 'uat',
      runAt: '2026-09-18T10:00:00.000Z',
      stageRunId: r1,
      gates: [{ name: 'test (web)', exitCode: 1, startedAt: '2026-09-18T10:00:00.000Z', endedAt: '2026-09-18T10:00:30.000Z', repo: '/wt/web' }],
    });
    // The fix landed and `entryPatch` re-entered uat — later than r1's start.
    setStage(store, id, 'uat', { status: 'running', verdict: null, startedAt: '2026-09-18T13:00:00.000Z', endedAt: null });

    const state = buildDashboardState(store, id /* …the fixture's remaining args… */);
    const uat = state.insideViews.uat;
    const gates = uat.processes.find((p) => p.id === 'gates')!;

    expect(gates.evidence).toMatchObject({ kind: 'gates', rows: [], failed: 0 });
    expect(gates.status).toBe('run');
    // Round 1 stays reachable, as the tab before the live one.
    expect(uat.attempts?.map((a) => a.label)).toEqual(['attempt 1', 'live']);
  });

  it('renders the recorded batch once the current invocation records one', () => {
    const id = /* the fixture's ticket id */;
    const r1 = openStageRun(store, {
      ticketId: id, stageKey: 'uat', attempt: 1,
      runAt: '2026-09-18T10:00:00.000Z', startedAt: '2026-09-18T10:00:00.000Z',
    });
    recordGateRuns(store, {
      ticketId: id, stageKey: 'uat', runAt: '2026-09-18T10:00:00.000Z', stageRunId: r1,
      gates: [{ name: 'test (web)', exitCode: 1, startedAt: '2026-09-18T10:00:00.000Z', endedAt: '2026-09-18T10:00:30.000Z', repo: '/wt/web' }],
    });
    setStage(store, id, 'uat', { status: 'running', verdict: null, startedAt: '2026-09-18T13:00:00.000Z', endedAt: null });
    const r2 = openStageRun(store, {
      ticketId: id, stageKey: 'uat', attempt: 2,
      runAt: '2026-09-18T13:01:00.000Z', startedAt: '2026-09-18T13:01:00.000Z',
    });
    recordGateRuns(store, {
      ticketId: id, stageKey: 'uat', runAt: '2026-09-18T13:01:00.000Z', stageRunId: r2,
      gates: [{ name: 'test (web)', exitCode: 0, startedAt: '2026-09-18T13:01:00.000Z', endedAt: '2026-09-18T13:01:30.000Z', repo: '/wt/web' }],
    });

    const state = buildDashboardState(store, id /* …the fixture's remaining args… */);
    const gates = state.insideViews.uat.processes.find((p) => p.id === 'gates')!;
    expect(gates.evidence).toMatchObject({ passed: 1, failed: 0 });
  });

  it('leaves a ticket with no stage_runs rows exactly as it was', () => {
    const id = /* the fixture's ticket id */;
    recordGateRuns(store, {
      ticketId: id, stageKey: 'uat', runAt: '2026-09-18T10:00:00.000Z',
      gates: [{ name: 'test (web)', exitCode: 1, startedAt: '2026-09-18T10:00:00.000Z', endedAt: '2026-09-18T10:00:30.000Z', repo: '/wt/web' }],
    });
    setStage(store, id, 'uat', { status: 'failed', startedAt: '2026-09-18T10:00:00.000Z', endedAt: '2026-09-18T10:01:00.000Z' });

    const state = buildDashboardState(store, id /* …the fixture's remaining args… */);
    const gates = state.insideViews.uat.processes.find((p) => p.id === 'gates')!;
    expect(gates.evidence).toMatchObject({ failed: 1 });
  });
});
```

Replace each `/* the fixture's … */` with the file's own helper before running — do not invent a second fixture. Import `openStageRun` from `../../store/stageRuns.js`, and use whatever the file already imports to write gate rows (`recordGateRuns` / `commitGateOutcome` — follow the existing tests) and `setStage` from `../../store/stages.js`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/ui/dashboard/state.test.ts -t 're-entered gate stage'`
Expected: FAIL on the first case — `failed: 1` and `status: 'fail'`, because `state.ts` does not read `stage_runs` yet.

- [ ] **Step 3: Write the implementation**

**3a.** Add the imports at the top of `src/ui/dashboard/state.ts`:

```ts
import { listStageRuns } from '../../store/stageRuns.js';
import { currentAttemptFor } from '../../model/inside/currentAttempt.js';
```

**3b.** Beside the other single evidence reads (the `const gateRuns = listGateRuns(store, ticketId);` block), add one more:

```ts
  // ONE read of the invocation records, for the same reason as every other
  // evidence read here. `stage_runs` is the only table written at stage ENTRY,
  // so it is the only thing that can say a gate stage is on a NEW invocation
  // that has recorded nothing yet — the fix cycle's round 2, which every
  // finished-work table still answers with round 1's rows.
  const stageRuns = listStageRuns(store, ticketId);
```

**3c.** Below `cellOf`, add the per-stage resolution — once per stage, shared by the switcher and the reducer, so the tab and the ledger can never disagree about which attempt is showing:

```ts
  const currentAttemptOf = (key: GateStageKey) =>
    currentAttemptFor(stageRuns, key, cellOf(key).startedAt);
  const uatCurrent = currentAttemptOf('uat');
  const reviewCurrent = currentAttemptOf('review');
```

If `GateStageKey` does not accept `'uat' | 'review'` where used here, type the parameter as `'uat' | 'review'` directly rather than widening anything.

**3d.** Pass it to both `listGateAttempts` calls — `?? null` is correct here, since "no stage run on record" adds no synthetic tab:

```ts
  const uatAttempts = listGateAttempts({
    gateRuns,
    processRuns,
    rounds,
    stageKey: 'uat',
    running: displayStatus(cellOf('uat')) === 'running',
    currentAttempt: uatCurrent ?? null,
  });
```

and the same shape for `reviewAttempts` with `reviewCurrent`.

**3e.** Pass it to both reducers. Assign the variable directly — do NOT write `?? null`: `undefined` (no stage run on record) and `null` (a fresh invocation) mean different things, and collapsing them would empty a legacy ticket's ledger.

In the `uatProcesses({ … })` call, after `selectedAttempt: uatSwitch.selectedKey,`:

```ts
        currentAttempt: uatCurrent,
```

and in `reviewProcesses({ … })`, after `selectedAttempt: reviewSwitch.selectedKey,`:

```ts
        currentAttempt: reviewCurrent,
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/ui/dashboard/state.test.ts`
Expected: PASS — the new block and every pre-existing test in the file.

- [ ] **Step 5: Run the whole unit suite and typecheck**

Run: `npm run test:unit`
Run: `npm run typecheck`
Expected: both exit 0. If a pre-existing dashboard or webview test now fails, read its arrangement: a test that opens a `stage_runs` row and then re-enters the stage is asserting the OLD stale behaviour and its expectation is what changed; a test that opens no stage run must be unaffected, and if it is not, the `undefined` fall-back in `effectiveAttempt` is wrong — fix that, not the test.

- [ ] **Step 6: Commit**

```bash
git add src/ui/dashboard/state.ts src/ui/dashboard/state.test.ts
git commit -m "$(cat <<'EOF'
fix: scope the Inside ledger to the gate stage's current invocation

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: say so when a recorded result is about to be superseded

**Files:**
- Modify: `src/ui/dashboard/state.ts` (`stageView` call sites for `uat` and `review`)
- Test: `src/ui/dashboard/state.test.ts`

**Interfaces:**
- Consumes: `InsideStageView.attemptNote` (already declared, `model/inside/types.ts:822`, already rendered verbatim above the ledger by `ui/dashboard/webview.html:2559`). No new view field and no webview change.
- Produces: nothing new for later tasks.

Tasks 2–4 fix the stage the ticket is ON. This task fixes the one it is not: while round 2's uat runs, the `review` stage row still holds round 1's `failed` verdict and its blocking findings, and the ledger renders them with no indication that a fix has since landed and the stage will re-run. That reading is honest but misleading — the reported "shows stale AI findings and state (red)". A host-authored line states the fact instead of fabricating a status.

- [ ] **Step 1: Write the failing test**

Append to `src/ui/dashboard/state.test.ts`:

```ts
describe('inside: a gate result superseded by an in-flight recovery round', () => {
  it('notes that the review result predates the fix now in flight', () => {
    const id = /* the fixture's ticket id */;
    setStage(store, id, 'review', {
      status: 'failed',
      verdict: 'blocking findings',
      startedAt: '2026-09-18T10:00:00.000Z',
      endedAt: '2026-09-18T10:05:00.000Z',
    });
    openRecoveryRound(store, {
      ticketId: id,
      sourceStage: 'review',
      sourceProcessId: 'review',
      /* …the fixture's remaining required fields… */
      startedAt: '2026-09-18T10:06:00.000Z',
    });
    setStage(store, id, 'uat', { status: 'running', startedAt: '2026-09-18T13:00:00.000Z', endedAt: null });
    setTicketStageCurrent(store, id, 'uat');

    const state = buildDashboardState(store, id /* …the fixture's remaining args… */);
    expect(state.insideViews.review.attemptNote).toBe(
      'round 1 is fixing — this result predates that fix, and this stage re-runs',
    );
  });

  it('adds no note to the stage the ticket is currently on', () => {
    const id = /* the fixture's ticket id */;
    setStage(store, id, 'review', {
      status: 'failed', verdict: 'blocking findings',
      startedAt: '2026-09-18T10:00:00.000Z', endedAt: '2026-09-18T10:05:00.000Z',
    });
    openRecoveryRound(store, {
      ticketId: id, sourceStage: 'review', sourceProcessId: 'review',
      /* …the fixture's remaining required fields… */
      startedAt: '2026-09-18T10:06:00.000Z',
    });
    setTicketStageCurrent(store, id, 'review');

    const state = buildDashboardState(store, id /* …the fixture's remaining args… */);
    expect(state.insideViews.review.attemptNote).toBeUndefined();
  });

  it('adds no note when no recovery round is in flight', () => {
    const id = /* the fixture's ticket id */;
    setStage(store, id, 'review', {
      status: 'failed', verdict: 'blocking findings',
      startedAt: '2026-09-18T10:00:00.000Z', endedAt: '2026-09-18T10:05:00.000Z',
    });

    const state = buildDashboardState(store, id /* …the fixture's remaining args… */);
    expect(state.insideViews.review.attemptNote).toBeUndefined();
  });

  it('never replaces the historical-selection banner', () => {
    // A reader who has explicitly selected a past tab is already told so; that
    // note wins, because it describes what they did.
    // Arrange two recorded review attempts plus an in-flight round, then
    // select the older tab via `attemptSelection: { review: '<older key>' }`.
    const state = buildDashboardState(store, id /* … */, /* … */);
    expect(state.insideViews.review.attemptNote).toContain('not the current result');
  });
});
```

Replace each `/* … */` with the file's own fixture helpers and the real `openRecoveryRound` signature from `src/store/recoveryRounds.ts` before running.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/ui/dashboard/state.test.ts -t 'superseded by an in-flight recovery round'`
Expected: FAIL on the first case — `attemptNote` is `undefined`.

- [ ] **Step 3: Write the implementation**

**3a.** Below the existing `activeRound` / `fixFallback` derivation in `buildDashboardState`, add:

```ts
  /**
   * Host-authored banner for a gate stage whose recorded result is already
   * being superseded (UI-R31 — the webview renders this verbatim).
   *
   * While a recovery round works elsewhere, the OTHER gate stage still holds
   * its last verdict: red gates, blocking findings, and nothing on screen
   * saying a fix has since landed and the stage re-runs. Nothing here invents
   * a status — the result shown is the real last one — it states the fact that
   * makes it readable.
   *
   * Never for the stage the ticket is on (its own ledger is live), never for a
   * stage running right now, and never for a stage with no recorded end: there
   * is no superseded result to caption.
   */
  const supersededNote = (key: 'uat' | 'review'): string | undefined => {
    if (activeRound === undefined) return undefined;
    if (ticket.stageCurrent === key) return undefined;
    const cell = cellOf(key);
    if (displayStatus(cell) === 'running' || displayStatus(cell) === 'blocked') return undefined;
    const endedAt = cell.endedAt;
    if (endedAt === undefined) return undefined;
    // Only a result the round POSTDATES is superseded by it. A stage that ran
    // after the round opened (uat revalidating a review-origin round) is
    // reporting on the fixed tree already.
    if (activeRound.startedAt < endedAt) return undefined;
    return `round ${activeRound.round} is fixing — this result predates that fix, and this stage re-runs`;
  };
```

**3b.** At the `uat` and `review` `stageView(...)` call sites, replace the last argument (`uatSwitch.view` / `reviewSwitch.view`) with a merge that lets the explicit historical banner win:

```ts
      uatSwitch.view
        ? uatSwitch.view.attemptNote
          ? uatSwitch.view
          : { ...uatSwitch.view, ...noteOf(supersededNote('uat')) }
        : undefined,
```

and the same for `review`. Add the one-line helper beside `supersededNote`:

```ts
  /** An `attemptNote` patch, or nothing — never an explicit `undefined` key. */
  const noteOf = (note: string | undefined): { attemptNote?: string } =>
    note ? { attemptNote: note } : {};
```

**3c.** A gate stage with fewer than two attempts has no `roundSwitcher` at all, and the note must still show. Extend `stageView`'s `roundSwitcher` parameter to accept a note-only object by widening its type:

```ts
  roundSwitcher?:
    | { attempts: readonly GateAttemptView[]; selectedAttempt: AttemptKey; attemptNote?: string }
    | { attemptNote: string },
```

and at each call site, when `…Switch.view` is undefined, pass the note-only object instead:

```ts
      uatSwitch.view
        ? uatSwitch.view.attemptNote
          ? uatSwitch.view
          : { ...uatSwitch.view, ...noteOf(supersededNote('uat')) }
        : supersededNote('uat')
          ? { attemptNote: supersededNote('uat')! }
          : undefined,
```

`stageView`'s body already spreads `roundSwitcher` wholesale (`...(roundSwitcher ? roundSwitcher : {})`), so no further change is needed there. The webview's tab strip is guarded on `view.attempts` having 2+ entries (webview.html:2534), so a note-only object renders the banner and no tabs.

Because that expression now appears twice per stage, hoist it at each call site instead of calling `supersededNote` twice:

```ts
  const uatNote = supersededNote('uat');
  const reviewNote = supersededNote('review');
```

and use `uatNote` / `reviewNote` in the two branches.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/ui/dashboard/state.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the render and webview suites**

Run: `npx vitest run src/ui/dashboard src/ui/runtimeConformance.render.test.ts`
Expected: PASS. The banner is existing markup with new prose, so no UI rule's verification mode changes; if the conformance sweep flags the note, the fix is the copy (`docs/ui/STYLE-GUIDE.md` tone), never the sweep.

- [ ] **Step 6: Commit**

```bash
git add src/ui/dashboard/state.ts src/ui/dashboard/state.test.ts
git commit -m "$(cat <<'EOF'
feat: caption a gate result that an in-flight recovery round supersedes

Cites UI-R31: the banner is host-authored and rendered verbatim.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: an end-to-end round-2 regression test

**Files:**
- Create: `src/model/inside/roundTwo.e2e.test.ts`
- Test: itself

**Interfaces:**
- Consumes: everything above, through the real workflow entry points, so the regression is pinned to the behaviour a user sees rather than to any one reducer's arguments.
- Produces: nothing.

Model it on the existing `src/workflow/repro-round2.test.ts` (a real `openStore(':memory:')`, `createTicketFlow`, `openGateRun` + `commitGateOutcome` with a `recoveryTrigger`, `completeFixExecution`, `driveTicket`) and on `src/model/inside/recovery.e2e.test.ts` for the inside-side assertions. Read both before writing this file.

- [ ] **Step 1: Write the failing test**

Create `src/model/inside/roundTwo.e2e.test.ts` with one scenario, driven through the real workflow:

1. Create a ticket and drive it to `uat`.
2. Open a uat stage run, record a **failing** gate batch with a `recoveryTrigger` — the ticket moves to `fix` and a round 1 opens.
3. Assert (round 1, the case that already works): `buildDashboardState(...).insideViews.uat` shows the failed batch, `status: 'fail'`.
4. Complete the fix execution and drive the ticket — it transitions back to `uat` and `entryPatch` re-enters the stage row.
5. **Assert the regression**, before any new gate row exists:
   - `insideViews.uat.processes.find(p => p.id === 'gates')!.evidence` has `rows: []` and `failed: 0`;
   - that process's `status` is `'run'`, not `'fail'`;
   - `insideViews.uat.attempts` ends with a `latest: true` tab labelled `live`, and still holds the round-1 tab before it.
6. Open the round-2 stage run and record a **passing** batch; assert the ledger now reads `passed: n, failed: 0`.

Assert on the dashboard state, not on the reducers' arguments: the point of this file is that a change to any one seam cannot silently reintroduce the staleness.

- [ ] **Step 2: Run test to verify it fails — on a reverted tree**

To prove the test actually pins the bug, stash the fix and run it:

```bash
git stash push -u -m "round2-e2e-verify-$(date +%s)"
git stash list --format='%H %gs' | head -1
```

Then check out the four fix files from `HEAD~4` into the worktree, run the test, and restore. Simpler and safer: run the new test with Task 4's two `currentAttempt:` lines in `state.ts` commented out.
Expected: FAIL at step 5 with `failed: 1` — the stale reading.

Restore the lines (or `git stash apply <sha>` by the SHA captured above, then drop that entry by re-finding its `stash@{n}` by tag) before continuing. Never use bare `git stash pop` — the stash stack is shared across worktrees.

- [ ] **Step 3: Run test to verify it passes on the fixed tree**

Run: `npx vitest run src/model/inside/roundTwo.e2e.test.ts`
Expected: PASS.

- [ ] **Step 4: Full verification**

Run: `npm run typecheck`
Run: `npm run test:unit`
Run: `npm run test:e2e`
Expected: all exit 0. Paste the summary lines into the commit body if anything was adjusted to get there.

- [ ] **Step 5: Commit**

```bash
git add src/model/inside/roundTwo.e2e.test.ts
git commit -m "$(cat <<'EOF'
test: pin the round-2 Inside ledger against the previous round's evidence

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: record the invariant

**Files:**
- Modify: `docs/arch/stages-and-gates.md`

**Interfaces:**
- Consumes: nothing.
- Produces: nothing.

`CLAUDE.md` names the nine reference documents binding, and "append-only gate evidence written when it happens" lives in `docs/arch/stages-and-gates.md`. The rule this plan adds belongs beside it, or the next change to the inside reducers re-derives the staleness from first principles.

- [ ] **Step 1: Add the section**

Under the existing gate-evidence section of `docs/arch/stages-and-gates.md`, add:

```markdown
### Evidence is not the current state

Every evidence table — `gate_runs`, `process_runs`, `review_findings`,
`uat_findings` — records that work FINISHED. None of them can say a stage is on
a new invocation that has produced nothing yet, and reducing them to "the
newest row" answers a re-entered stage with its PREVIOUS round's rows. That is
what rendered a fixed round's red gates and blocking findings as round 2's live
ledger.

`stage_runs` (v25) is the one table written at stage ENTRY (`openStageRun`,
before the first gate starts), so it is the only thing that can state the
current invocation. Every surface that presents a gate stage's CURRENT state
resolves it through `model/inside/currentAttempt.ts`:

- **no `stage_runs` row for the stage** — pre-v25 or never ran: the
  latest-by-`runAt` reduction stands, byte-for-byte;
- **the stage row was re-entered after the newest run started** — the current
  invocation has opened nothing: the ledger is EMPTY, and the predecessor's
  rows are history reachable through the round switcher;
- **otherwise** — that stage run's rows are the live picture.

A reader's explicit round-switcher selection always wins over this: choosing a
past tab is a deliberate request for a settled attempt.
```

- [ ] **Step 2: Commit**

```bash
git add docs/arch/stages-and-gates.md
git commit -m "$(cat <<'EOF'
docs: record that evidence tables cannot state a stage's current invocation

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Self-Review

**1. Spec coverage.** The ticket asks for three things:

| Ticket requirement | Task |
|---|---|
| "this new round shows stale AI findings" — Tester observations / Review findings from the previous round | Task 2 (`testerProcess` / `reviewProcess` key to the current invocation), Task 4 (wiring) |
| "…and state (red)" — the previous round's failed gate batch and process status | Task 2 (`gatesProcess`), Task 4 |
| "depending where it was found in prev round" — both the uat (Tester) and review (Review) origins | Task 2 covers both reducers; Task 6 drives a uat-origin round end to end and Task 2's unit block covers the review origin |
| "It should show proper state of processes, findings asap" — no waiting for new rows to overwrite the stale reading | Tasks 2 + 4: the ledger goes empty the moment the stage is re-entered, before any new row lands |
| The previous round must stay reachable (not a regression introduced by the fix) | Task 3 (synthetic live tab) |
| Misleading red on the gate stage the ticket is NOT on | Task 5 (superseded banner) |
| Regression protection | Task 6; invariant recorded in Task 7 |

**2. Placeholder scan.** The only deliberate blanks are the `/* the fixture's … */` markers in Tasks 4 and 5, each with an explicit instruction to substitute the test file's own existing helper rather than invent a second fixture — `state.test.ts` is 1871 lines and already owns a store fixture whose exact shape must be read, not guessed. Every code step elsewhere carries the literal code.

**3. Type consistency.** `CurrentAttempt = AttemptKey | null | undefined` is declared once in Task 1 and used under that exact name in Tasks 2 and 4. `currentAttemptFor(stageRuns, stageKey, enteredAt)` keeps its three-argument shape at both call sites. `EffectiveAttempt { key, empty, historical }` is private to `gates.ts` and every field is read: `key` by `batchForAttempt` / `processRunForAttempt`, `empty` by all three reducers and `stageRecovery`, `historical` by `isSettledSelection` and the two absence-detail branches. `ListGateAttemptsInput.currentAttempt` is `AttemptKey | null` (two-valued — a synthetic tab is either added or not), deliberately narrower than `CurrentAttempt`, and Task 4 passes `?? null` at exactly those two call sites and **not** at the reducer call sites. `attemptNote` matches the field already on `InsideStageView`.
