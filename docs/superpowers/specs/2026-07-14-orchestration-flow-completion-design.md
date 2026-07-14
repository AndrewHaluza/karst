# Orchestration Flow Completion — Driver Loop + Session Resume

**Date:** 2026-07-14
**Status:** Design (awaiting review)
**Refs:** architecture §5.3 (session continuity), §5.4 (no-inference), §11 (stage machine), §12 (token economy), §13 (crash recovery).

## 1. Problem

The stage machine's per-stage runners exist and are tested (`runUat`, `runReview`, `shipTicket`, `runFix`, `markImplementDone`), and boot-time stage-state recovery works (`deriveStageCurrent` / `reconcileOnStart` / Resync). But two designed subsystems were never wired, so a ticket strands mid-flow:

1. **No driver loop.** Nothing invokes `runUat` / `runReview` / `shipTicket`. A ticket that reaches `uat` (or `review`, `ship`) has no trigger to run the gate — it sits there. Only `scope→impl` (spin) and `impl→uat` (the marker CLI just added) advance.
2. **Session resume unbuilt.** `tickets.session_id` exists and `runFix` consumes it, but nobody persists it: the hook dispatch receives `session_id` on every event and drops it, `runHeadless` parses it but never writes it, and `buildInteractiveCommand` never threads `--resume`. So `openSession` always starts from scratch, and `runFix` would throw "no captured session_id."

This is a completion of the §11/§13 design, not a new model. §5.4 already fixes the interactive boundary as an **explicit marker** (not Stop-hook inference).

## 2. Goals

1. After the explicit impl/fix **marker**, karst **auto-runs the deterministic gates** (`uat → review`), advancing on exit-code verdicts.
2. The loop is **visible and interruptible**: the dashboard shows live stage + status; the user can **Stop** (halts at the next gate boundary) and **Resume**.
3. **Stop before ship**: the loop pauses at `ship`; PRs open only on an explicit **Ship** confirm (outward, hard to undo).
4. **Session continuity**: persist `session_id`; reopening an in-progress ticket **resumes** the agent session (`--resume`) instead of re-seeding from scratch.
5. **Interruptions are a non-event** (§13): on reopen, reconcile restores the stage and re-offers **Resume** (idempotent re-run) rather than silently re-firing.
6. **Consistency**: one orchestrator drives every stage through a single code path, host-agnostic (injected interfaces), TDD.

## 3. Non-goals (YAGNI)

- Agent-produced **review findings** — review stays a purely deterministic gate (lint+typecheck+test) for now; the findings layer is a later enhancement (§11 note).
- Multi-repo **merge ordering** (§17.2, deferred).
- Second agent / Codex.
- `fetch` and `done` ticketing-API stages (out of current scope).
- Server re-adoption beyond the existing cold-restart.
- A global auto-advance on/off setting — auto-advance is the default behavior; interruptibility (Stop) is the control surface, so a separate toggle is unnecessary.
- **Auto-headless-fix** — the driver does NOT auto-run `runFix`. On a gate failure the ticket routes to `fix`, which is a **human boundary** (Resume session, fix interactively, re-fire the marker). Unattended agent fixing is a later enhancement; `runFix` and the `session_id` resume plumbing still land (used by the interactive resume), so the seam stays.
- **Mid-run kill** — gate runners keep `spawnSync`; **Stop** acts at the gate boundary (a running gate finishes, then the loop halts). Killing an in-flight `npm test` is a later enhancement (async-spawn refactor).

## 4. Architecture

Everything below the UI stays host-agnostic and unit-tested; `vscode` is bound only in `extension.ts`.

### 4.1 `StageDriver` — the loop (new, `src/workflow/driver.ts`)

A host-agnostic orchestrator that walks a ticket forward through the **deterministic** stages until it reaches a human boundary, a failure that needs the agent, or a cancel.

```ts
export interface StageDriverDeps {
  store: Store;
  runUat: (ticketId: number, cwd: string) => Promise<StageKey>;      // wraps runUat
  runReview: (ticketId: number, cwd: string) => Promise<StageKey>;   // wraps runReview
  worktreeFor: (ticketId: number) => string | null;
  onProgress: (ticketId: number, stage: StageKey, status: 'running' | 'stopped' | 'blocked') => void;
  shouldContinue: () => boolean; // cancellation check between gates (Stop)
}

export async function runStageDriver(deps: StageDriverDeps, ticketId: number): Promise<StageOutcome>;
```

**Per-stage action** (the driver reads `stage_current`, acts, then re-reads and loops):

| current | driver action | continues? |
|---|---|---|
| `impl` | none — waits for the marker (interactive boundary) | no (returns `blocked`) |
| `uat` | `runUat` → transition (pass→review / fail→fix) | yes on pass; stops on fail (→`fix`) |
| `review` | `runReview` → transition (pass→ship / fail→fix) | yes on pass; stops on fail (→`fix`) |
| `fix` | **stop** — human boundary (Resume session interactively) | no |
| `ship` | **stop** — return `blocked:ship-confirm` (never auto-opens PRs) | no |
| `done` | terminal | no |

The runners already call `transition()` and fold their artifact write into the transaction (unchanged). The driver only sequences the deterministic **pass-forward** gates (`uat`→`review`), checks `shouldContinue()` between them, and stops at boundaries. It is a fold over `stage_current`, never a second source of transition logic (single-writer discipline preserved).

**Boundaries that stop the loop:** `fix` (a gate failed — fix interactively), `ship` (confirm), `done`, a cancel, or any runner error.

### 4.2 Trigger — what starts the driver

The marker CLI writes the DB from the **agent's** process (plain `node`), which cannot call back into the extension. The extension observes and drives:

- **Live path:** the agent's `Stop`/`SessionEnd` hook already POSTs to the HTTP hook endpoint. After that hook lands, the extension checks the ticket: if `stage_current` is a deterministic gate (`uat`/`review`/`fix`) with no live session → start `runStageDriver`. This is **not** inferring a transition from `Stop` (§5.4): the marker already performed the transition; `Stop` is only the "now run the pending gate" nudge.
- **Boot path:** after `reconcileOnStart`, any ticket sitting at a gate stage surfaces a **Resume** affordance; it does **not** auto-fire on boot (avoids surprise re-runs of a possibly-failing gate after a crash). One click resumes.

Both funnel into the same `runStageDriver(ticketId)` entry.

### 4.3 Session resume (`src/store/tickets.ts`, `src/hooks/dispatch.ts`, `src/agent/*`)

1. **Persist `session_id`.** Add single-writer `setSessionId(store, ticketId, sessionId)`. Extend `dispatchHook`: on `SessionStart` (payload carries `session_id` + `cwd`), resolve the ticket and persist it. First-write-wins per session; keep it idempotent.
2. **Interactive `--resume`.** `buildInteractiveCommand` gains an optional `resume?: string`; when set, prepend `--resume <id>`. `openSession` decides: ticket has a `session_id` **and** stage is `impl`/`fix` → resume (seed a short "continue" nudge, not the full re-derived prompt); otherwise fresh seed as today.
3. **`runFix` plumbing stays ready.** `runFix` already `--resume`s `ticket.sessionId`; once persistence lands it is functional, but the driver does not call it in this slice (auto-headless-fix deferred, §3). Fixing happens via the interactive Resume path.

### 4.4 Stop (boundary-level)

`Stop` halts the loop at the **gate boundary**: `shouldContinue()` is checked before each gate, so a running gate finishes (verdict recorded as normal) and the driver then stops rather than proceeding to the next. Gate runners keep `spawnSync` — no mid-run kill (deferred, §3). This keeps the tested runner internals untouched; only the driver's between-gate check is new.

### 4.5 Dashboard UX (`src/ui/dashboard/*`)

The ticket dashboard renders one **primary action** derived from `(stage_current, status, agent_state, session_id)`:

| State | Primary action |
|---|---|
| `impl`, idle, has `session_id` | **Resume session** (`--resume`) |
| `impl`, no `session_id` | **Open session** (fresh) |
| gate running | **Running…** + **Stop** (halts at gate boundary) |
| gate stopped/interrupted | **Resume** (idempotent re-run) |
| `fix` (a gate failed) | **Resume session** (fix interactively, re-fire marker) |
| `ship` | **Ship (open PRs)** confirm |
| `agent_state=waiting` (needs-you) | **Answer** (focus terminal, §5.6 — exists) |
| `done` | — |

A live status line shows the current gate + last verdict; artifacts (uat/review logs) link from the stage row.

## 5. Data flow (happy path)

```
impl session → agent runs `karst stage impl pass` (marker) → transition impl→uat
agent session ends → Stop hook → extension: stage_current=uat, no live session → runStageDriver
  runUat (spawnSync npm test) → exit 0 → transition uat→review → continue
  runReview (lint+tc+test) → all 0 → transition review→ship → BOUNDARY: stop, show "Ship"
user clicks Ship → shipTicket (open PRs, write prs rows) → transition ship→done
```

Failure branch: any gate exits nonzero → transition →`fix` → driver stops. Dashboard shows **Resume session** (`--resume` the captured session); the human fixes interactively and re-fires the marker path, which re-enters the gate. (Auto-headless-fix is deferred, §3.)

## 6. Error handling

- Runner throws (spawn failure, missing worktree) → driver stops, marks status `blocked`, surfaces the error on the dashboard; never leaves a half-transition (runners are already atomic).
- Idempotency (§5.3): every gate re-run is safe; `shipTicket` already skips repos with an open PR row.
- Unknown ticket / no worktree → loud, no silent no-op.
- Hook with `session_id` for an unknown worktree → ignored (as today).

## 7. Testing (TDD)

- `StageDriver`: table-driven over start-stage → expected stop boundary, with fake runners; pass-chain (uat→review→ship-stop), fail-branch stops at `fix`, Stop between gates halts, `ship` never auto-runs.
- `setSessionId` + `dispatchHook` SessionStart persists `session_id`; other events still touch only `agent_state`.
- `buildInteractiveCommand` threads `--resume` when given; omits otherwise.
- `openSession` resume-vs-fresh decision (unit, via the existing host fakes).
- Integration: seed a ticket at `uat`, run the driver against a fake worktree, assert it stops at `ship` with PRs unopened.

## 8. Build phases (for the plan)

1. **Session persistence** — `setSessionId`, `dispatchHook` SessionStart capture. (Unblocks resume; smallest, independent.)
2. **Interactive resume** — `buildInteractiveCommand` `--resume`, `openSession` resume decision + dashboard Resume/Open action.
3. **StageDriver** — the pass-forward loop + boundaries + boundary-level Stop, fully unit-tested with fakes.
4. **Trigger wiring + Ship confirm** — Stop-hook nudge + boot Resume affordance → `runStageDriver`; dashboard Stop + Ship-confirm controls.

Phases 1–3 are host-agnostic and testable under vitest; phase 4 is the thin `extension.ts` seam.

Deferred (seams stay): auto-headless-fix (`runFix` in the driver), mid-run kill (async-spawn runners), agent review-findings.
