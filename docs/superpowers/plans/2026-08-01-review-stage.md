# Review Stage — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: use `superpowers:subagent-driven-development` (recommended) or
> `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.
>
> **Spec of record:** `docs/superpowers/specs/2026-08-01-review-stage-design.md`. Every "why" lives there;
> this file is the "what and in what order". Do not implement from the UAT spec's review paragraphs — they
> are scoping notes, not a design.

**Goal:** Make the review stage ask a real question about **the change** — one it can fail, park on, be
stopped during, and be configured for — instead of re-running UAT's suite and passing when it ran nothing.

**Architecture:** Review adopts the contract UAT already proved: a resolved gate *list* (declared from
`karst.yml`, else probed) over a dependency-aware multi-repository target plan, reduced by one pure
aggregator to `advanced | blocked | stopped`, with evidence committed in the same transaction as the outcome.
The gate-resolution machinery moves out of `workflow/uat/` into `workflow/gates/` so there is one
implementation. Review's default gate set drops `test` (UAT owns it) and gains `build`/`format`. Phase 2 adds
agent findings over the diff as append-only evidence; Phase 3 adds an optional human approval park.

**Tech Stack:** TypeScript (ESM, `moduleResolution: Bundler`), vitest, better-sqlite3 (extension host) /
`node:sqlite` (CLI), js-yaml.

---

## Global Constraints

Copied from `CLAUDE.md` and the spec. Every task's requirements implicitly include this section.

- **ESM:** every relative import needs a `.js` suffix, including from `.ts` files.
- **`noUncheckedIndexedAccess` is on:** array/index access needs `!` or a guard.
- **`vscode` is not a runtime dependency.** Nothing under `src/workflow/`, `src/store/`, `src/model/`,
  `src/manifest/`, `src/context/` may import it. Only `src/extension.ts` and its thin wrappers may.
- **`spawnSync` is banned on the gate path.** Guard test: `gates/run.test.ts` *"leaves the event loop free
  while the child runs"*.
- **All stage mutation goes through `setStage`** (`src/store/stages.ts`). Single-writer.
- **Store SQL uses positional `?` only** — no named parameters, no `.pluck()` (the CLI opens the same helpers
  with `node:sqlite`).
- **New schema column/table checklist:** `src/store/schema.sql` + a guarded `ALTER`/`CREATE` in
  `src/store/migrations.ts` + bump `SCHEMA_VERSION` (currently `19`) + update every `user_version` and
  table-count assertion in `src/store/db.test.ts`.
- **New `Manifest` field checklist:** `src/manifest/types.ts` + `validateManifest` (`src/manifest/schema.ts`)
  + **the `writeManifest` overlay (`src/manifest/write.ts`)** or Save silently drops it +
  `src/manifest/fixtures.ts`. Guard: `writeManifest.test.ts` *"round-trips every modeled section"*.
- **No agent self-reported verdicts.** `MARKER_STAGES` stays `['impl','fix']`; no CLI write verb is added in
  any task of this plan.
- **File size:** 200–400 lines typical, 800 max. `src/extension.ts` is ~3000 lines — move code out, never in.
- **TDD is mandatory:** write the failing test, run it, watch it fail, then implement.
- **Conventional commits:** `feat:`, `fix:`, `refactor:`, `test:`, `docs:`, `chore:`.
- **Commands:** `npm test`, `npx vitest run <path>`, `npm run typecheck`.

---

## Scope and phasing

| Phase | Ships | Independently valuable? |
|---|---|---|
| **0 — Stop lying** (Tasks 1–4) | Vacuous-green closures, the diff wired or the claim removed, git failure → park, transition CAS | Yes. Each is a `main` bug fix; each is revertable alone. |
| **1 — Contract parity** (Tasks 5–10) | `StageRunResult`, abort signal, `review:` manifest block, per-stage fix budget, independent-signal rule, blocked visible in the UI | Yes. Review becomes a first-class gate. |
| **2 — The new question** (Tasks 11–13) | Agent findings over the diff (v20), findings in the fix brief and in `karst context` | Yes, and opt-in (`findings.enabled: false` by default). |
| **3 — Human approval** (Tasks 14–15) | `review.approval: human`, `awaiting_kind` (v21), Approve / Request changes | **Blocked on product decision O1.** Do not start until O1 is answered. |

Phases are strictly ordered. Task 5 depends on Tasks 1–3 having landed; Task 11 depends on Phase 1.

---

## Phase 0 — Stop lying

### Task 1: `runReview` refuses to pass having run nothing

Closes G1, G2, G3(c). This is the smallest change that stops a vacuous ship, and it lands **before** the
refactor so it is revertable on its own.

**Files:**
- Modify: `src/workflow/stages/review.ts` (the `makeGateRunner` probe branch, and the verdict at `:144-148`)
- Modify: `src/workflow/gates/scripts.ts` (`readPackageScripts` is no longer used by review; leave it until
  Task 5 deletes the last caller)
- Test: `src/workflow/stages/review.test.ts`

**Interfaces:**
- Produces: `ReviewOutcome.verdict` is still `Exclude<Verdict, null>`; a run that asked nothing now throws a
  named error **temporarily** (Task 6 converts it to a `blocked` result). The throw is deliberate and
  short-lived: it is louder than a green, and Task 6 lands in the same release.

- [ ] **Step 1: Write the failing tests** in `review.test.ts`:
  - `it('refuses to pass when no target resolved')` — the existing
    `'runs no checks when no repo changed and no relation is affected'` test (`review.test.ts:199-217`) is
    **rewritten**, not deleted: it must now assert the run does not reach `ship`. Leave a comment recording
    that the old assertion pinned the bug.
  - `it('refuses to pass when every gate was skipped')` — runner returns three `exitCode: null` gates.
  - `it('fails, rather than skips, when package.json is malformed')` — `probeScripts` returns `malformed`.
- [ ] **Step 2: Run and watch fail.** `npx vitest run src/workflow/stages/review.test.ts`
- [ ] **Step 3: Implement.** Replace `readPackageScripts` with `probeScripts` inside `makeGateRunner`;
  surface `malformed` as an `exitCode: 1` gate row named `package.json` (mirror `uat.ts:262-275`); in
  `runReview`, before the verdict, throw `ReviewAskedNothingError` when `gates.filter(g => g.exitCode !== null)`
  is empty.
- [ ] **Step 4: Run tests, then `npm run typecheck`.**
- [ ] **Step 5: Commit** — `fix: review no longer passes a ticket it asked nothing about`

### Task 2: Wire `openDiff`, or stop claiming it happened

Closes G3. Two acceptable outcomes; **do not leave the third** (a UI that asserts an action nobody performed).

**Files:**
- Modify: `src/extension.ts` (pass an `openDiff` into the review runner via `driveTicket`'s deps)
- Modify: `src/workflow/driveTicket.ts:123-132` (thread it through)
- Modify: `src/model/inside/gates.ts:95-106` (the row is emitted only when the diff was actually opened)
- Test: `src/model/inside/gates.test.ts`, `src/workflow/driveTicket.test.ts`

**Interfaces:**
- Produces: `DriveTicketDeps.openDiff?: (ticketId: number, cwd: string) => void`. Absent ⇒ `reviewInside`
  emits **no diff row at all**.

- [ ] **Step 1: Failing test** — `gates.test.ts`: `it('emits no diff row when nothing opened it')`;
  `driveTicket.test.ts`: `it('passes the host openDiff to the review runner')`.
- [ ] **Step 2: Run and watch fail.**
- [ ] **Step 3: Implement.** Host implementation: reuse the ticket-stack diff panel already wired at
  `extension.ts:1200-1218` (`openTicketDiff` → `vscode.diff`) rather than authoring a second diff surface — one command, called once
  per affected target. Carry a `diffOpened: boolean` on `ReviewOutcome` and thread it into `reviewInside`
  through `StageInside` construction, so the row states what happened rather than what was intended.
- [ ] **Step 4: Run tests + typecheck.**
- [ ] **Step 5: Commit** — `fix: open the review diff for real, and stop claiming it when nothing did`

### Task 3: A git failure parks the ticket instead of throwing

Closes G4.

**Files:**
- Modify: `src/workflow/gates/targets.ts:17-41` — `hasReviewChanges` returns a discriminated result instead
  of throwing; `selectReviewTargets` propagates it
- Modify: `src/workflow/stages/uat.ts` (it calls the same selector through `planUatTargets`)
- Test: `src/workflow/gates/targets.test.ts`, `src/workflow/uat/targets.test.ts`

**Interfaces:**
- Produces: `type TargetSelection = { kind: 'targets'; targets: ReviewTarget[] } | { kind: 'unavailable'; blocker: BlockerKind; reason: string }`.
  `capability-missing` for a git failure — an agent cannot fix an unreachable remote.

- [ ] **Step 1: Failing test** — `it('reports a git failure as unavailable rather than throwing')`.
- [ ] **Step 2: Run and watch fail.**
- [ ] **Step 3: Implement.** Both callers must handle `unavailable`; UAT's path already has
  `finish({kind:'blocked'})` (`uat.ts:255-258`), review's arrives in Task 6 — until then review re-throws with
  the same message, so this task changes UAT's behaviour and review's error text only.
- [ ] **Step 4–5:** tests, typecheck, commit — `fix: a git probe failure parks the gate instead of escaping`

### Task 4: `transition` refuses a `from` that is not the ticket's current stage

Closes G17 (the UAT spec's P1) and G18's double-advance. Pre-existing `main` bug; independently revertable.

**Files:**
- Modify: `src/workflow/machine.ts:78-97` (inside the transaction, before any write)
- Test: `src/workflow/machine.test.ts`

- [ ] **Step 1: Failing tests** — `it('refuses to transition a stage that is not the ticket current stage')`
  and `it('refuses a second concurrent transition from the same stage')` (call `transition` twice; the second
  must throw and mutate nothing).
- [ ] **Step 2: Run and watch fail.**
- [ ] **Step 3: Implement.** In the transaction, after reading the ticket:
  `if (getTicket(...).stageCurrent !== from) throw new Error(\`stage '${from}' is not ticket ${ticketId}'s current stage (${stageCurrent})\`)`.
  Check `cli/stage.test.ts` and `lifecycle.integration.test.ts` for fixtures that transition out of order —
  fix the fixtures, not the guard.
- [ ] **Step 4–5:** full `npm test` (this touches every stage), typecheck, commit —
  `fix: a transition must start from the ticket current stage`

---

## Phase 1 — Contract parity with UAT

### Task 5: Move gate resolution out of `workflow/uat/` into `workflow/gates/`

Pure refactor. No behaviour change. UAT's tests must pass with import-path edits only.

**Files:**
- Create: `src/workflow/gates/resolve.ts` — `ResolvedGate`, `GateResolution`, `resolveGates(probe, declared, probeScripts)`
- Create: `src/workflow/gates/runList.ts` — `runGateList` (was `runUatGates`), `RunGatesOptions`
- Modify: `src/workflow/uat/gates.ts` — keeps only UAT's `PROBE_SCRIPTS` and `declaredGatesFor`, re-exporting
  from the new modules for one release
- Modify: `src/workflow/stages/uat.ts` imports
- Test: move `uat/gates.test.ts`'s resolution/run cases to `gates/resolve.test.ts` + `gates/runList.test.ts`

**Interfaces:**
- Produces: `resolveGates(probe: ScriptProbe, declared: GateDef[], probeList: readonly string[]): GateResolution`
  — the probe list is now a **parameter**, which is the whole point: UAT passes its list, review passes its own.

- [ ] **Steps 1–5:** tests move first and must stay green throughout; then delete the re-exports in a
  follow-up commit. Commit — `refactor: share gate resolution between uat and review`

### Task 6: `runReview` returns `StageRunResult` and can park

Closes G5, G7, G8, and completes Tasks 1 and 3.

**Files:**
- Create: `src/workflow/review/aggregate.ts` — `aggregateReview`, pure
- Rewrite: `src/workflow/stages/review.ts` as orchestration (target ≤ 200 lines), with a `commitOutcome`
  structurally identical to `uat.ts:151-205`
- Create: `src/workflow/review/targets.ts` — `planReviewTargets` (dedup by `repo`, union names; mirror of
  `uat/targets.ts:34-56`)
- Modify: `src/workflow/driveTicket.ts:123-132` — delete the `.then(() => ({kind:'advanced'}))` adapter
- Test: `src/workflow/review/aggregate.test.ts` (new, table-driven over R1–R9),
  `src/workflow/stages/review.test.ts` (rewritten around `StageRunResult`),
  `src/workflow/driveTicket.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export function aggregateReview(
    entries: readonly AggregateEntry[],      // reused from uat/aggregate.ts
    uatIdentities: readonly GateIdentity[],
    opts: { requireIndependentSignal: boolean },
  ): AggregateOutcome;

  export async function runReview(
    store: Store, opts: RunReviewOpts, deps?: ReviewDeps,
  ): Promise<StageRunResult>;

  export interface RunReviewOpts {
    ticketId: number; cwd: string; artifactDir: string;
    manifest?: Manifest; signal?: AbortSignal;      // G6
  }
  export interface ReviewDeps {
    planTargets?: typeof planReviewTargets; probe?: (cwd: string) => ScriptProbe;
    runGates?: typeof runGateList; git?: GitRunner; now?: () => string;
    openDiff?: OpenDiff;
  }
  ```
- `uatIdentities` come from the ticket's **latest recorded UAT batch** (`listGateRuns` filtered to
  `stage_key='uat'`, greatest `run_at`), not from a constant — UAT resolves its set at runtime.
  This needs `gate_runs` to carry the invocation identity; see Task 7.

- [ ] **Step 1: Failing tests.** `aggregate.test.ts` covers every row of the spec's R1–R9 table, including
  precedence (a malformed `package.json` **and** a failing lint reports the gate failure).
  `review.test.ts` covers: blocked-on-no-target, blocked-on-nothing-ran, stopped-mid-gate keeps partial rows
  and consumes no attempt, a verdict clears a previous block (`clearStageBlock`), evidence lands in the same
  transaction as the verdict, and a failing run is filed under the attempt that ran.
- [ ] **Step 2: Run and watch fail.**
- [ ] **Step 3: Implement.** Model `runReview` on `uat.ts` line for line: `finish(outcome, notes)` closure
  writing the artifact and delegating to `commitOutcome`; `parkGateStage(..., stageKey: 'review')` on blocked;
  the transaction+`recordGateRun`+`setStage` triple on stopped; `transition(..., premutate)` on a verdict.
  Delete `ReviewAskedNothingError` from Task 1.
- [ ] **Step 4:** `npm test`, `npm run typecheck`.
- [ ] **Step 5: Commit** — `feat: review parks, stops and states its verdict in one place`

### Task 7: Record each gate's invocation identity

Needed by R7 (independent-signal) and by `reviewInside` rendering recorded rows.

**Files:**
- Modify: `src/store/schema.sql` (`gate_runs` gains `command TEXT`, `args TEXT` — JSON array, and `repo TEXT`)
- Modify: `src/store/migrations.ts` (guarded ALTERs; `SCHEMA_VERSION` → 20)
- Modify: `src/store/gateRuns.ts` (`GateRunInput` gains the three fields, all nullable)
- Modify: `src/workflow/stages/uat.ts`, `src/workflow/stages/review.ts` (they already build `GateIdentity`)
- Test: `src/store/gateRuns.test.ts`, `src/store/db.test.ts`

**Interfaces:**
- Produces: `GateRun.command: string | null`, `.args: string[] | null`, `.repo: string | null`.
  **Nullable, never backfilled** — pre-v20 rows genuinely do not know what argv produced them, and inventing
  one would make R7 compare against a guess. `aggregateReview` treats a null-identity UAT row as *no
  identity*, i.e. it cannot satisfy the overlap test either way.

- [ ] **Steps 1–5:** TDD; run `npm test` (db.test.ts's version assertions are the noisy part). Commit —
  `feat: gate_runs records what each gate actually invoked`

### Task 8: The blocked state is visible

Closes G13. Shared with UAT — a parked UAT ticket is invisible on `main` today.

**Files:**
- Modify: `src/model/stepper.ts:14-39` — `StepperCell.blocked?: { kind: BlockerKind; reason: string; at: string }`,
  `StepperStageRow` gains the three nullable inputs
- Modify: `src/model/inside/gates.ts` — `reviewInside` renders **recorded rows** (like `uatInside:118-127`),
  not `REVIEW_GATES` positions, plus a `fail`-styled block row when `cell.blocked`
- Modify: `src/ui/dashboard/state.ts`, `src/ui/dashboard/webview.html` — a block banner with the reason and a
  **Resume** button
- Modify: `src/ui/dashboard/messages.ts` — `{ type: 'stage-resume', ticketId, stageKey }`, validated
- Modify: `src/extension.ts` — the handler calls `clearStageBlock` then `maybeDrive`
- Test: `stepper.test.ts`, `inside/gates.test.ts`, `dashboard/messages.test.ts`, `dashboard/state.test.ts`,
  `ui/dashboard/webview.test.ts`

**Interfaces:**
- `reviewInside` stops importing `REVIEW_GATES`. Consequence stated in the spec §9: historical rows named
  `test` still render, which position-matching against the new constant would have silently dropped.

- [ ] **Steps 1–5:** TDD each layer. `webview.html` is a mirrored surface — `webview.test.ts` pins mirrors
  against the TS modules, so update both. Commit — `feat: a parked gate says so, and can be resumed`

### Task 9: The `review:` manifest block

Closes G9, G10.

**Files:**
- Modify: `src/manifest/types.ts` — extract `GateDef` (the shared shape), add `ReviewConfig`,
  `Manifest.review?: ReviewConfig`
- Create: `src/manifest/validate/review.ts` — `validateReview`, mirroring `validate/uat.ts`'s strictness
- Modify: `src/manifest/validate/uat.ts` — share `validateGate` with a parameterised `where` prefix
- Modify: `src/manifest/schema.ts` (`review: validateReview(raw.review)`),
  `src/manifest/write.ts` (the overlay — **or Save drops it**), `src/manifest/fixtures.ts`
- Modify: `src/workflow/gates/scripts.ts` — `REVIEW_GATES` becomes `lint`/`typecheck`/`build`/`format`;
  add `REVIEW_PROBE_SCRIPTS`
- Modify: `src/workflow/review/gates.ts` (new) — `resolveReviewGates` over the shared `resolveGates`
- Modify: `karst.example.yml` — a documented `review:` block
- Test: `src/manifest/validate/review.test.ts`, `src/manifest/load.test.ts`,
  `src/manifest/writeManifest.test.ts`, `src/workflow/review/gates.test.ts`

**Interfaces:**
```ts
export interface ReviewConfig {
  maxFixAttempts: number;              // always set by validate (FIX_ATTEMPT_CAP)
  requireIndependentSignal: boolean;   // always set by validate (true)
  gates?: GateDef[];
  approval: 'auto' | 'human';          // always set by validate ('auto')
  findings: { enabled: boolean; agent?: string; blockingSeverity: Severity | 'none'; maxFindings: number };
  repositories: Record<string, { gates?: GateDef[] }>;
}
```
Per-repo `gates` **replace** the global list for that repository (never add) — the exact semantics of
`declaredGatesFor` (`uat/gates.ts:73-84`).

- [ ] **Step 1: Failing tests** — validation refusals name the field (`review.gates[0].kind must be one of…`),
  an unknown `review.repositories.<name>` is refused against `manifest.repositories`, defaults are applied,
  `writeManifest` round-trips the block, and the removal of `test` from `REVIEW_GATES` is asserted with a
  comment naming the duplication it closes.
- [ ] **Steps 2–5:** implement, test, typecheck, commit — `feat: karst.yml can configure the review gates`

### Task 10: Review's own fix budget and the independent-signal rule

Closes G11, G12.

**Files:**
- Modify: `src/workflow/driveTicket.ts:40` — `const cap = gate === 'uat' ? (manifest?.uat?.maxFixAttempts ?? FIX_ATTEMPT_CAP) : (manifest?.review?.maxFixAttempts ?? FIX_ATTEMPT_CAP)`
- Modify: `src/workflow/review/aggregate.ts` — R7 wired to `requireIndependentSignal`
- Modify: `src/workflow/uat/aggregate.ts` — its warning now compares against the **recorded** review batch
  rather than `REVIEW_GATES`, since Task 9 changed the constant
- Test: `driveTicket.test.ts`, `review/aggregate.test.ts`, `uat/aggregate.test.ts`

- [ ] **Steps 1–5:** TDD. Commit — `feat: review carries its own fix budget and must ask something uat does not`

---

## Phase 2 — Findings over the diff

### Task 11: `review_findings` (schema v21)

**Files:** `src/store/schema.sql`, `src/store/migrations.ts`, `src/store/reviewFindings.ts` (new),
`src/store/db.test.ts`, `src/store/reviewFindings.test.ts`

**Interfaces:** `recordFindings(store, batch)` (append-only, one transaction),
`listFindings(store, ticketId)`, `latestFindingBatch(store, ticketId)` — greatest `run_at`, **never** array
position (the `inside/gates.ts:19-30` rule).

- [ ] **Steps 1–5:** TDD; assert nothing UPDATEs the table and that a batch commits atomically. Commit —
  `feat: review findings are append-only evidence`

### Task 12: `parseFindings` — untrusted model output at the boundary

**Files:** `src/workflow/review/findings.ts` (new), `src/workflow/review/findings.test.ts`

**Interfaces:** `parseFindings(raw: string, ctx: { repo: string; worktreePath: string; max: number }): Finding[]`

Rules, each its own test:
- whole-document JSON **and** JSONL (the interesting line is never line 1) — same reader shape as
  `agent/cliFailure.ts` / `agent/tokenUsage.ts`
- unknown `severity` → the finding is **dropped**, never coerced
- `file` must be repo-relative, contain no `..`, and resolve inside `worktreePath`; otherwise the finding is
  kept with `file: null` rather than dropped (the text may still be useful)
- `title`/`detail` collapsed to one line and capped
- more than `max` findings → truncated, and the truncation is **logged**, never silent
- unparseable input → `[]`, never a synthetic finding

- [ ] **Steps 1–5:** TDD, including an injection fixture (`file: "../../../.ssh/id_rsa"`, a `$(rm -rf /)`
  title, a 5 MB detail). Commit — `feat: parse agent review findings at the boundary`

### Task 13: Run the findings lane, and tell the agent

**Files:** `src/agent/aiCallSites.ts` (add `'review-findings'` + its label), `src/workflow/stages/review.ts`
(the lane, guarded by `findings.enabled`), `src/workflow/review/aggregate.ts` (R6),
`src/agent/fixBrief.ts` (findings in the brief), `src/context/ticketContext.ts` (a read-only `stages` block
carrying the current stage, its verdict, its latest gate rows and its findings — closes G15),
`src/ui/wiring` tests

- [ ] **Step 1: Failing tests** — a missing agent core is `capability-missing` **blocked**, not a failure
  (spec §8.14); a gate failure short-circuits before any AI call is made; `blockingSeverity: none` never
  fails a ticket; the fix brief names the findings; `karst context` renders them.
- [ ] **Steps 2–5:** implement, test, typecheck. Commit — `feat: review asks an agent about the diff`

---

## Phase 3 — Human approval *(blocked on product decision O1)*

### Task 14: `awaiting` as a durable rest state (schema v22)

**Files:** `src/model/types.ts` (`StageRunResult` gains `{ kind: 'awaiting'; what: 'approval' }`),
`src/workflow/driver.ts` (a branch in the exhaustive switch — the `never` guard makes the omission a compile
error), `src/store/schema.sql` + `migrations.ts` (`stages.awaiting_kind`, `awaiting_since`),
`src/store/stageAwaiting.ts` (new, mirroring `stageBlocks.ts`), `src/workflow/driverController.ts`
(`ticketsToSweep` skips awaiting), `src/model/stepper.ts`, `src/model/inside/gates.ts`

- [ ] **Steps 1–5:** TDD. Commit — `feat: a stage can rest awaiting a human`

### Task 15: Approve / Request changes

**Files:** `src/store/reviewDecisions.ts` (new — records the decision plus every target's head SHA),
`src/workflow/review/approval.ts` (`approvalState(decisions, currentShas)` → live | stale | none),
`src/ui/dashboard/messages.ts` + `webview.html` (two buttons; **the confirmation lives in the host**),
`src/extension.ts` (handlers), `src/workflow/review/aggregate.ts` (R8)

- [ ] **Step 1: Failing tests** — an approval whose head SHA moved is **not live** (spec §8.6); Request
  changes stores its note as a `critical`, `source: 'human'` finding and transitions to `fix`; a crafted
  webview message can neither approve without the host confirmation nor pick a different ticket's id.
- [ ] **Steps 2–5:** implement, test, typecheck. Commit — `feat: review can wait for a human approval`

---

## Self-Review

Things a reviewer of *this plan* should check before execution starts:

1. **Task 1 throws on purpose, briefly.** If Phase 0 ships without Task 6, a ticket whose repo defines no
   review script hits an exception rather than a park. That is louder than today's silent green and is
   corrected in the same release — but if Phases 0 and 1 are split across releases, hoist Task 6 forward.
2. **Task 9 removes `test` from `REVIEW_GATES`.** Any repo whose only script is `test` gets a **blocked**
   review until it configures `review.gates`. Intended (spec §6.2). It must be in the release notes.
3. **Task 7 is the only schema step in Phase 1.** If the identity columns prove contentious, R7 can fall back
   to comparing gate *names* per repo — weaker, and the spec explains why (`uat/aggregate.ts:44-52`).
4. **Task 8 changes UAT's UI too.** That is deliberate: doubling the number of parkable stages doubles the
   cost of an invisible park.
5. **Three `SCHEMA_VERSION` bumps** across the plan (20, 21, 22). Each needs `db.test.ts`'s hardcoded
   `user_version` and table-count assertions updated, and the CLI's `assertMigrated` means extension and
   `dist/cli` ship together.
6. **No task adds a CLI write verb, widens `MARKER_STAGES`, or lets an agent author a verdict.** If a task
   seems to need one, it is the wrong task.

## Execution Handoff

- **Start at Task 1.** Phases are strictly ordered; tasks within a phase are ordered except Tasks 2 and 4,
  which are independent of everything else in Phase 0.
- **Do not start Phase 3** until open question **O1** (spec §10) has an answer from the product owner.
- Answer **O2** before Task 10 (it decides whether R7 defaults to a failure or a warning) and **O4** before
  Task 13 (it decides `blockingSeverity`'s default). Both have recommendations in the spec; if no answer
  arrives, implement the recommendation and note it in the commit body.
