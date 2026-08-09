# Execution Plan: Fix four defects in the UAT/blocked-stage/timeline changes

## Goal

Four defects introduced by commits `02351f9`, `267d181`, `bc5d8fd`, `9f92a1b` are corrected:

1. A ticket with **zero registered worktrees** parks at UAT/review instead of passing vacuously.
2. An `unmapped-repository` block offers a **Resume** button (it is clearable by a human edit + retry).
3. An **interrupted** implementation run no longer renders a green "done · implementation marked done" row.
4. The external-change watcher refreshes the sidebar **once per tick**, and does so even when no dashboard panel is open.

## Current State

Facts established by inspection at HEAD (`9f92a1b`):

- `src/workflow/stages/uat.ts:181` and `src/workflow/stages/review.ts:146` read `const worktrees = opts.manifest ? listWorktreesByTicket(store, opts.ticketId) : []`. With no manifest the planner is bypassed and one synthetic target (`opts.cwd`) is produced, so `targets.length === 0` is reachable **only** when a manifest is present.
- Commit `9f92a1b` deleted `noTargetsReason` from `src/workflow/gates/targets.ts`. That function had a first branch for `worktrees.length === 0` returning "no worktree is registered for this ticket…". No replacement exists, so zero worktrees now yields `unmapped: []`, `targets: []` → **passes** with the note "no repository has changes from its base". This violates the "asked nothing is never green" invariant in `CLAUDE.md`.
- `src/model/stepper.ts:97-98` sets `resumable: row.blockedKind !== 'awaiting-merge' && row.blockedKind !== 'unmapped-repository'`. `awaiting-merge` self-clears via `settleShipGate`; `unmapped-repository` has **no** sweep, and the block's own reason instructs the user to edit `karst.yml` — after which retry is the correct and only action. `src/workflow/stageResume.ts:42` already permits resuming everything except `awaiting-merge`, so the host is already willing.
- `src/ui/dashboard/webview.html` `renderBlocked` branches on `blocked.resumable === false` and picks the title `'Waiting to merge'` for `awaiting-merge`, else `'<STAGE> cannot run here'`.
- `src/model/inside/agent.ts:229` gates the terminal timeline row on `if (run.endedAt)`. `ImplementationRunStatus = 'running' | 'passed' | 'interrupted'` (`src/store/implementationRuns.ts:28`). `interruptImplementationRun` (`implementationRuns.ts:311-321`) stamps `ended_at` and sets `status = 'interrupted'`, so an interrupted run currently renders `status: 'pass'`, label `done`, detail "implementation marked done".
- `src/extension.ts:2351-2357` calls `provider.refresh()` **inside** the `for (const ticketId of dashboard.openTicketIds())` loop, so it fires N times per tick and zero times when no panel is open.
- Test fixtures: `src/workflow/stages/uat.test.ts` and `src/workflow/stages/review.test.ts` `beforeEach` create a ticket with **no** worktree rows. Tests that exercise the empty-target path therefore have zero worktrees today.
- `src/model/inside/agent.test.ts` `run()` helper defaults `status: 'running'`; `tl(segments, over)` spreads `over` onto that run.

Suite at HEAD: 306 files / 5133 tests pass; `npm run typecheck` clean.

## Target State

- `runUat`/`runReview` with a manifest and **zero** worktrees → `{ kind: 'blocked', blocker: 'nothing-to-run', reason: 'no worktree is registered for this ticket, so there is no repository to run UAT against' }` (respectively `…to run review against`). Ticket stays at its stage; attempt not consumed.
- `runUat`/`runReview` with worktrees, some unmapped → unchanged (`unmapped-repository` block).
- `runUat`/`runReview` with worktrees, all mapped, none changed → unchanged (passes with a note).
- `StepperCell.blocked.resumable` is `false` **only** for `awaiting-merge`.
- `renderBlocked` shows the no-button banner titled `Waiting to merge` for the non-resumable case; an `unmapped-repository` block renders the ordinary blocked banner with a Resume button.
- The implementation timeline's terminal `done` row appears only when `run.status === 'passed'` **and** `run.endedAt` is set.
- The watcher's callback calls `provider.refresh()` exactly once per external change, before the per-panel loop, regardless of how many panels are open.

## Scope

### In Scope
- `src/workflow/stages/uat.ts`, `src/workflow/stages/review.ts` and their tests.
- `src/model/stepper.ts` and `src/ui/dashboard/webview.html` `renderBlocked`, plus `src/ui/dashboard/webview.test.ts`.
- `src/model/inside/agent.ts` `timelineEvents`, plus `src/model/inside/agent.test.ts`.
- `src/extension.ts` watcher callback.

### Out of Scope
- Re-introducing `noTargetsReason` as a shared helper. The two stages word their own reason inline, as they already do for `unmapped-repository`.
- Any change to `src/workflow/gates/targets.ts`, `selectReviewTargets`, `unmapped` collection, or the `TargetSelection` type.
- Any change to `src/workflow/stageResume.ts`.
- Any change to `displayStatus`, the rail, the clock, or `src/store/externalChanges.ts`.
- Adding a sweep that auto-clears `unmapped-repository`.
- Adding a `nothing-to-run` variant, new `BlockerKind`, or schema column.

## Key Decisions

1. **The zero-worktree guard lives in each stage runner, not in the planner.** `selectReviewTargets` returns `unmapped: []` for zero worktrees, which is factually correct — zero worktrees produce zero unmapped repositories. The distinction "nothing was asked" belongs to the stage, which is also where the existing `unmapped` branch lives. Placing it in the planner would require a third `TargetSelection` variant, which is out of scope.
2. **The guard is placed inside the `targets.length === 0` branch, ahead of the `unmapped` check.** Zero worktrees implies zero unmapped, so the two branches cannot both fire; ordering it first makes the precedence explicit rather than incidental.
3. **The reason string is restored verbatim from the deleted `noTargetsReason`** so that a user who saw the old message sees the same one.
4. **The blocker for zero worktrees is `nothing-to-run`, not a new kind.** It is resumable: registering a worktree (re-scoping) makes a retry succeed, and `nothing-to-run` is already the resumable "karst could not ask" kind.
5. **`unmapped-repository` becomes resumable.** The `resumable` expression reduces to the single `awaiting-merge` comparison, which is what `stageResume.ts:42` already enforces host-side; the two now agree.
6. **`renderBlocked`'s non-resumable title becomes the constant `'Waiting to merge'`.** With `awaiting-merge` the only non-resumable kind, the `'<STAGE> cannot run here'` arm is unreachable and is removed rather than left as dead code.
7. **The terminal timeline row is gated on `run.status === 'passed'`.** An interrupted run's `ended_at` records *when it stopped*, not that a marker was placed; rendering "implementation marked done" for it invents a fact. No row is emitted for an interrupted run — no substitute row is invented either, because the reducers already state absence by omission.
8. **`provider.refresh()` is hoisted out of the loop and called unconditionally.** The sidebar is a window-level surface whose contents depend on registry state, not on which panels happen to be open.

---

## Execution Order

### Task 1: Park UAT and review when the ticket has no registered worktree

#### Objective

Restore the pre-`9f92a1b` behavior for a ticket that has a manifest but zero rows in `worktrees`: the stage parks with `nothing-to-run` instead of passing vacuously.

#### Files

- `src/workflow/stages/uat.ts` — add the zero-worktree branch inside the empty-targets block.
- `src/workflow/stages/review.ts` — same, with review's wording.
- `src/workflow/stages/uat.test.ts` — add one regression test; repair two existing tests that rely on zero worktrees.
- `src/workflow/stages/review.test.ts` — same.

#### Implementation

1. In `src/workflow/stages/uat.ts`, inside `if (targets.length === 0) { … }`, insert this branch as the **first** statement of the block, before the existing `if (planned.unmapped.length > 0)` check:

   ```ts
   // Zero worktrees is not "nothing changed": nothing was ASKED. The ticket
   // has no repository to run UAT against at all, and passing here would walk
   // a stage that ran nothing straight to review — the vacuous green the
   // "asked nothing is never green" invariant exists to prevent. Resumable:
   // registering a worktree (re-scoping) makes a retry succeed.
   if (worktrees.length === 0) {
     const reason =
       'no worktree is registered for this ticket, so there is no repository to run UAT against';
     return finish({ kind: 'blocked', blocker: 'nothing-to-run', reason }, [reason]);
   }
   ```

2. In `src/workflow/stages/review.ts`, insert the identical branch as the first statement of its `if (targets.length === 0) { … }` block, with `UAT` replaced by `review` in both the comment and the reason string:

   ```ts
   if (worktrees.length === 0) {
     const reason =
       'no worktree is registered for this ticket, so there is no repository to run review against';
     return finish({ kind: 'blocked', blocker: 'nothing-to-run', reason }, [reason]);
   }
   ```

3. In `src/workflow/stages/uat.test.ts`, repair the two tests that reach the empty-target path with zero worktrees. Both must now insert a worktree row so they continue to exercise the branch they were written for:

   - In `it('keeps an unavailable selection and a genuine empty target list apart', …)`, immediately after `transition(store, id2, 'impl', { kind: 'passed' });` add:

     ```ts
     store.db
       .prepare(
         "INSERT INTO worktrees (ticket_id, repo, path, branch, base_ref, deps_mode) VALUES (?, '/web', '/wt/web', 'b', 'develop', 'inherited')",
       )
       .run(id2);
     ```

   - In `it('passes with a note when every repository mapped and none has changes', …)`, add the same insert (with `.run(id)`) as the first statement of the test body.

4. In `src/workflow/stages/uat.test.ts`, add this new test immediately **after** `it('passes with a note when every repository mapped and none has changes', …)`:

   ```ts
   // Zero worktrees is a third case, and it is neither of the two above: the
   // question was never asked of any repository, so it can only park.
   it('parks when the ticket has no registered worktree at all', async () => {
     const res = await runUat(
       store,
       { ticketId: id, cwd: '/wt/web', artifactDir, manifest: manifest({}) },
       deps({ planTargets: async () => ({ kind: 'targets', targets: [], unmapped: [] }) }),
     );
     expect(res).toMatchObject({ kind: 'blocked', blocker: 'nothing-to-run' });
     expect(res).toMatchObject({
       reason: 'no worktree is registered for this ticket, so there is no repository to run UAT against',
     });
     expect(getTicket(store, id).stageCurrent).toBe('uat');
     expect(uatStage(store, id).attempt).toBe(0);
     expect(stageBlock(store, id, 'uat')?.kind).toBe('nothing-to-run');
   });
   ```

5. In `src/workflow/stages/review.test.ts`, apply the mirrored repairs:

   - In `it('keeps an unavailable selection and a genuine empty target list apart', …)`, immediately after `walkToReview(store, id2);` add the worktree insert with `.run(id2)`.
   - In `it('passes with a note when every repository mapped and none has changes', …)`, add the worktree insert with `.run(id)` as the first statement.

6. In `src/workflow/stages/review.test.ts`, add the mirrored new test immediately after `it('passes with a note when every repository mapped and none has changes', …)`:

   ```ts
   it('parks when the ticket has no registered worktree at all', async () => {
     const res = await runReview(
       store,
       { ticketId: id, cwd: '/wt/web', artifactDir, manifest: manifest({}) },
       deps({ planTargets: async () => ({ kind: 'targets', targets: [], unmapped: [] }) }),
     );
     expect(res).toMatchObject({ kind: 'blocked', blocker: 'nothing-to-run' });
     expect(res).toMatchObject({
       reason:
         'no worktree is registered for this ticket, so there is no repository to run review against',
     });
     expect(getTicket(store, id).stageCurrent).toBe('review');
     expect(reviewStage(store, id).attempt).toBe(0);
     expect(stageBlock(store, id, 'review')?.kind).toBe('nothing-to-run');
   });
   ```

#### Constraints

- Do not modify `src/workflow/gates/targets.ts`, `src/workflow/uat/targets.ts`, or `src/workflow/review/targets.ts`.
- Do not re-create a shared `noTargetsReason` helper.
- Do not change the `unmapped-repository` branch or the pass-with-a-note branch.
- Do not change the no-manifest path (`opts.manifest` falsy), which synthesizes one target from `opts.cwd`.
- Use `finish(...)` exactly as the sibling branches do — do not call `parkGateStage` directly.
- Do not alter the `beforeEach` blocks of either test file.

#### Edge Cases

- **No manifest, zero worktrees:** `targets` is `[{ repo: opts.cwd, … }]`, length 1, so the new branch is unreachable. Behavior unchanged. Covered by the existing `it('all gates green -> advances to review …')` test, which passes no manifest.
- **Worktrees present, all unmapped:** `worktrees.length > 0`, so the new branch does not fire; the `unmapped-repository` branch does. Covered by the existing `it('blocks and names the unmapped worktrees …')` test.
- **Worktrees present, all mapped, none changed:** neither new nor unmapped branch fires; passes with a note. Covered by the repaired test.
- **`planned.kind === 'unavailable'`:** returns earlier, above the `targets.length === 0` block. Untouched.

#### Verification

```bash
npx vitest run src/workflow/stages/uat.test.ts src/workflow/stages/review.test.ts
npm run typecheck
```

Expected:
- Both test files pass with no failures.
- The two new tests (`parks when the ticket has no registered worktree at all`) appear in the passing output for each file.
- `tsc --noEmit` exits 0 with no output.

> Note: `npx vitest run` on a single file is valid here because neither file loads `better-sqlite3` through a path that needs the Node ABI rebuild — they use `openStore(':memory:')`, which the suite's existing `pretest` has already prepared. If the run fails with `NODE_MODULE_VERSION`, run `npm test` instead and read the results for these two files.

#### Completion Criteria

- [ ] `uat.ts` and `review.ts` each contain the zero-worktree branch as the first statement of their `targets.length === 0` block.
- [ ] The reason strings match the two specified strings exactly, character for character.
- [ ] Two tests were repaired in each test file with the worktree insert.
- [ ] One new test was added to each test file and passes.
- [ ] Both listed commands succeed.

---

### Task 2: Make an `unmapped-repository` block resumable and offer its Resume button

#### Objective

A block the user can clear by editing `karst.yml` must expose the control that retries the stage. Only `awaiting-merge` stays non-resumable.

#### Files

- `src/model/stepper.ts` — narrow the `resumable` expression and correct its comment.
- `src/model/types.ts` — correct the `unmapped-repository` comment's closing clause.
- `src/ui/dashboard/webview.html` — `renderBlocked`: fix the comment and reduce the non-resumable title to a constant.
- `src/ui/dashboard/webview.test.ts` — repoint the existing non-resumable test at `awaiting-merge`; add a test proving `unmapped-repository` renders Resume.
- `src/model/stepper.test.ts` — add a test pinning which kinds are resumable.

#### Implementation

1. In `src/model/stepper.ts`, in the `blockedDetail` function, replace the `resumable` assignment and the comment above it with:

   ```ts
   // `awaiting-merge` is the one block a retry cannot clear: ship's work is
   // done and a PR must LAND, which karst never does itself — the merge sweep
   // clears it, so a Resume button would always no-op. Every other
   // BlockerKind, `unmapped-repository` included, is cleared by a retry once
   // the cause is addressed (there editing karst.yml or re-scoping), so the
   // dashboard must offer the control. Matches `workflow/stageResume.ts`,
   // which refuses exactly `awaiting-merge` and nothing else.
   resumable: row.blockedKind !== 'awaiting-merge',
   ```

2. In `src/model/stepper.ts`, in the `StepperCell.blocked.resumable` doc comment (the interface at the top of the file), replace the sentence naming both kinds with:

   ```ts
   /**
    * Whether re-running the stage could plausibly clear this block. `false`
    * only for `awaiting-merge`, where a PR must land and the merge sweep —
    * never a retry — clears it; a Resume button there would always no-op, so
    * the dashboard renders none.
    */
   ```

3. In `src/model/types.ts`, in the `unmapped-repository` member's comment, replace the final clause ``so the dashboard offers no Resume for it (`resumable: false`, stepper.ts).`` with:

   ```
   // so a retry only helps AFTER the user fixes karst.yml — which is exactly
   // what the Resume button is for, so the block stays resumable.
   ```

   Leave the rest of that comment and the union member itself unchanged.

4. In `src/ui/dashboard/webview.html`, in `renderBlocked`, replace the comment block plus the `if (blocked.resumable === false) { … }` body with:

   ```js
   // `awaiting-merge` is the only block a retry cannot clear, and it is not a
   // fault at all: ship's own work is done and the PRs are open, so this reads
   // as a normal wait for one of them to land. The flag is the host's verdict
   // (`blockedDetail`, model/stepper.ts), never a reason-string match here.
   if (blocked.resumable === false) {
     box.innerHTML = `<div class="ftitle">Waiting to merge</div>`
       + `<div class="freason">${esc(blocked.reason)}</div>`;
     return;
   }
   ```

   The `const title = blocked.kind === 'awaiting-merge' ? … : …` expression is deleted; the `'<STAGE> cannot run here'` string disappears from the file.

5. In `src/ui/dashboard/webview.test.ts`, rewrite the test named `renders a non-resumable block as a banner with no Resume button` so it parks **ship** with `awaiting-merge` instead of `uat` with `unmapped-repository`. Replace its body with:

   ```ts
   // `awaiting-merge` is the one block a retry cannot clear — the merge sweep
   // clears it when the PR lands — so the banner shows the wait and no dead
   // button. The resumability verdict is the host's `resumable` flag on the
   // cell's `blocked`, never a reason-string match.
   const store = openStore(':memory:');
   const t = createTicket(store, { key: 'AWM-1', title: 'awaiting merge at ship' });
   setStage(store, t.id, 'ship', { status: 'passed', startedAt: '2026-08-09T10:00:00.000Z' });
   parkGateStage(store, {
     ticketId: t.id,
     stageKey: 'ship',
     kind: 'awaiting-merge',
     reason: 'PR #412 is open and unmerged',
     runAt: '2026-08-09T10:33:42.000Z',
     gates: [],
   });
   store.db.prepare("UPDATE tickets SET stage_current = 'ship' WHERE id = ?").run(t.id);
   const state = buildDashboardState(store, t.id);
   store.close();

   const h = bootPreviewHarness();
   h.receive({ type: 'state', state });
   const banner = h.htmlOf('blocked');
   expect(banner).toContain('Waiting to merge');
   expect(banner).toContain('PR #412 is open and unmerged');
   expect(banner).not.toContain('data-act="stage-resume"');
   ```

6. In `src/ui/dashboard/webview.test.ts`, add a new test immediately after it:

   ```ts
   it('offers Resume on an unmapped-repository block', () => {
     // The block's own reason tells the user to edit karst.yml; once they
     // have, a retry is the only way forward and nothing sweeps this block
     // clear on its own. Withholding the button would strand the ticket.
     const store = openStore(':memory:');
     const t = createTicket(store, { key: 'UNM-1', title: 'unmapped at uat' });
     setStage(store, t.id, 'uat', { status: 'running', startedAt: '2026-08-09T10:00:00.000Z' });
     parkGateStage(store, {
       ticketId: t.id,
       stageKey: 'uat',
       kind: 'unmapped-repository',
       reason: 'these worktrees match no repository in karst.yml: /unmapped',
       runAt: '2026-08-09T10:33:42.000Z',
       gates: [],
     });
     store.db.prepare("UPDATE tickets SET stage_current = 'uat' WHERE id = ?").run(t.id);
     const state = buildDashboardState(store, t.id);
     store.close();

     const h = bootPreviewHarness();
     h.receive({ type: 'state', state });
     const banner = h.htmlOf('blocked');
     expect(banner).toContain('these worktrees match no repository in karst.yml: /unmapped');
     expect(banner).toContain('data-act="stage-resume"');
     expect(banner).toContain('data-stagekey="uat"');
   });
   ```

7. In `src/model/stepper.test.ts`, add a test inside the existing `describe` that covers `blockedDetail`'s output (the one whose test at line ~85 asserts `blockedKind: 'nothing-to-run'` maps to a cell). Add:

   ```ts
   it('marks only awaiting-merge non-resumable', () => {
     // A retry clears every other kind once its cause is addressed; only a
     // landing clears awaiting-merge, and karst never lands a PR itself.
     const cellFor = (kind: BlockerKind) =>
       buildStepper([
         {
           stageKey: 'uat',
           status: 'running',
           blockedKind: kind,
           blockedReason: 'r',
           blockedAt: '2026-07-16T10:00:00.000Z',
         } as StepperStageRow,
       ]).find((c) => c.stageKey === 'uat')!;
     expect(cellFor('unmapped-repository').blocked!.resumable).toBe(true);
     expect(cellFor('nothing-to-run').blocked!.resumable).toBe(true);
     expect(cellFor('awaiting-merge').blocked!.resumable).toBe(false);
   });
   ```

   If `BlockerKind` or `StepperStageRow` is not already imported in that file, add the type-only imports from `./types.js` and `./stepper.js` respectively, matching the file's existing import style. If `buildStepper`'s row shape requires additional non-optional fields, supply them by copying the shape used by the neighbouring test at line ~85 rather than inventing values.

#### Constraints

- Do not change `src/workflow/stageResume.ts`.
- Do not remove `unmapped-repository` from `BlockerKind`, and do not change where it is produced (`uat.ts`/`review.ts`).
- Do not change the resumable banner's markup, the `data-stagekey` attribute, or the Resume button's `title`.
- Do not touch `src/model/nowLine.ts` or `src/model/ticketGlyph.ts`; `awaiting-merge` handling there is unaffected.
- Keep `resumable` a required field on `StepperCell.blocked` — do not make it optional.

#### Edge Cases

- **A `ship` cell with `awaiting-merge` and `status: 'passed'`:** `displayStatus` returns `'passed'` (a block on a non-running stage does not read as blocked), and `renderBlocked` still fires because it keys on `cell.blocked`, not on `displayStatus`. Behavior unchanged by this task.
- **A block on a stage that is not the ticket's current stage:** `renderBlocked` reads `state.currentStage` only, so nothing renders. Unchanged.
- **A cell with no block:** `blocked` is `undefined`, the banner is hidden. Unchanged.
- **An older snapshot without `resumable`:** `blocked.resumable === false` is false for `undefined`, so such a block renders the resumable banner. This is the intended fallback and requires no code.

#### Verification

```bash
npx vitest run src/model/stepper.test.ts src/ui/dashboard/webview.test.ts
npm run typecheck
grep -c "cannot run here" src/ui/dashboard/webview.html
```

Expected:
- Both test files pass.
- The new tests `offers Resume on an unmapped-repository block` and `marks only awaiting-merge non-resumable` appear as passing.
- `tsc --noEmit` exits 0.
- `grep -c` prints `0`.

#### Completion Criteria

- [ ] `stepper.ts` `resumable` is `row.blockedKind !== 'awaiting-merge'` and nothing else.
- [ ] `webview.html` contains no `cannot run here` string.
- [ ] The repointed non-resumable webview test uses `ship` + `awaiting-merge` and passes.
- [ ] The two new tests pass.
- [ ] All three listed commands produce the expected results.

---

### Task 3: Emit the terminal timeline row only for a passed implementation run

#### Objective

Stop rendering a green "done · implementation marked done" row for an implementation run that was interrupted rather than marked.

#### Files

- `src/model/inside/agent.ts` — narrow the terminal-row condition in `timelineEvents`.
- `src/model/inside/agent.test.ts` — fix the existing terminal-row tests (their fixture run is `status: 'running'`), add an interrupted regression test.

#### Implementation

1. In `src/model/inside/agent.ts`, in `timelineEvents`, replace the terminal-row comment and condition with:

   ```ts
   // The terminal row exists ONLY when the marker was actually placed:
   // `completeImplementationRun` stamps `ended_at` AND sets the run `passed`,
   // so `pass` is the recorded verdict — never an inference. An INTERRUPTED
   // run also carries an `ended_at` (`interruptImplementationRun`), and that
   // timestamp records when it stopped, not that anyone marked it done —
   // keying on `endedAt` alone rendered a green "marked done" for a session
   // nobody marked. A running session has no end and is not given one; an
   // interrupted one gets no row at all, because the timeline states absence
   // by omission rather than by inventing a substitute.
   if (run.endedAt && run.status === 'passed') {
   ```

   The body of the `if` is unchanged.

2. In `src/model/inside/agent.test.ts`, update the two tests added by `02351f9` that pass `{ endedAt: runAt('13:00') }` to `tl(...)`. Both must additionally set the run status, since the `run()` helper defaults to `'running'`:

   - `it('closes the timeline with the recorded implementation marker', …)` → change `tl([segment({ id: 1 })], { endedAt: runAt('13:00') })` to `tl([segment({ id: 1 })], { endedAt: runAt('13:00'), status: 'passed' })`.
   - `it('keeps a phase mark a note, never a verdict', …)` → make the same change to its `tl(...)` call.

3. In `src/model/inside/agent.test.ts`, add this test immediately after `it('leaves a running session open-ended', …)`:

   ```ts
   it('gives an interrupted session no done row', () => {
     // `interruptImplementationRun` stamps `ended_at` too, but that records
     // when the session stopped — nobody marked implementation done, so the
     // timeline must not say anyone did.
     const process = implementationSessionProcess(
       cell('impl', 'running'),
       tl([segment({ id: 1 })], { endedAt: runAt('13:00'), status: 'interrupted' }),
       [],
       undefined,
       undefined,
       NOW,
     );
     const timeline = rows(process);
     expect(timeline.map((r) => r.label)).toEqual(['started']);
     expect(timeline.some((r) => r.label === 'done')).toBe(false);
   });
   ```

#### Constraints

- Do not change the `started` row, which legitimately uses `run.endedAt ?? now` to bound its duration — that is an elapsed span, not a claim about a marker.
- Do not add a replacement row (e.g. an "interrupted" row) for the interrupted case.
- Do not change `implementationSessionProcess`'s signature or the process-level `status`/`statusLabel`, which come from the stage cell.
- Do not change `src/store/implementationRuns.ts`.

#### Edge Cases

- **`status: 'passed'` with `endedAt: null`:** impossible via `completeImplementationRun` (it writes both in one transaction), but if encountered the `&&` short-circuits and no row is emitted. Correct — there is no timestamp to state.
- **`status: 'running'` with `endedAt` set:** no row. Correct — the run has not concluded.
- **`status: 'interrupted'`:** no row. Asserted by the new test.
- **A phase mark present on an interrupted run:** the mark rows are emitted as before (they are recorded facts); only the terminal row is withheld. The existing mark loop is untouched.

#### Verification

```bash
npx vitest run src/model/inside/agent.test.ts
npm run typecheck
```

Expected:
- The file passes, including `gives an interrupted session no done row`.
- The two repaired tests still pass.
- `tsc --noEmit` exits 0.

#### Completion Criteria

- [ ] The condition in `timelineEvents` reads `if (run.endedAt && run.status === 'passed') {`.
- [ ] Both pre-existing terminal-row tests now pass `status: 'passed'` in their `tl(...)` override.
- [ ] The new interrupted test exists and passes.
- [ ] Both listed commands succeed.

---

### Task 4: Refresh the sidebar once per external change, panels or not

#### Objective

`provider.refresh()` fires exactly once per detected external write and fires even when no dashboard panel is open.

#### Files

- `src/extension.ts` — the `watchExternalChanges` callback.

#### Implementation

1. In `src/extension.ts`, replace the callback body passed to `watchExternalChanges` so `provider.refresh()` precedes the loop:

   ```ts
   watchExternalChanges(localStore, () => {
     // Window-level first, and unconditionally: the sidebar reflects registry
     // state whether or not any dashboard happens to be open, and refreshing
     // it once per open panel was N calls for one change.
     provider.refresh();
     for (const ticketId of dashboard.openTicketIds()) {
       dashboard.pushState(ticketId);
     }
   }),
   ```

2. Leave the surrounding comment block above `context.subscriptions.push(` unchanged.

#### Constraints

- Do not change `src/store/externalChanges.ts`, its polling interval, or its disposal.
- Do not add a driver call, a stage transition, or any write inside the callback — the watcher is observer-only, and a change notification that started work would race two windows against each other.
- Do not change `DashboardManager.openTicketIds()`.
- Do not add error handling around `provider.refresh()`; it is the same call the rest of `activate` makes unguarded.

#### Edge Cases

- **No panels open:** the loop body never runs; `provider.refresh()` still fires. This is the behavior being added.
- **Several panels open:** `provider.refresh()` fires once, `pushState` once per panel. Unchanged per-panel behavior.
- **A panel disposed between ticks:** `openTicketIds()` is read fresh each tick from `this.panels`, so a disposed panel is absent. Unchanged.

#### Verification

```bash
npm run typecheck
npm run build
grep -n -A6 "watchExternalChanges(localStore" src/extension.ts
```

Expected:
- `tsc --noEmit` exits 0.
- The build completes without error.
- The grep output shows `provider.refresh();` on the line **before** the `for (const ticketId` line, and no `provider.refresh()` inside the loop body.

> `src/extension.ts` imports `vscode` and therefore does not load under vitest — there is no unit test for this file, and none is to be added. Verification is the typecheck, the build, and the grep.

#### Completion Criteria

- [ ] `provider.refresh()` appears exactly once in the callback, before the loop.
- [ ] The loop body contains only `dashboard.pushState(ticketId);`.
- [ ] All three listed commands produce the expected results.

---

## Final Verification

1. Run the full suite and typecheck from the worktree root.
2. Confirm the total test count is **5133 + 5 = 5138** (Task 1 adds 2, Task 2 adds 2, Task 3 adds 1; repaired tests are modified in place, not added).
3. Confirm no test file count change: still 306 files.
4. Confirm the build produces `dist/` without error.

Commands:

```bash
npm test
npm run typecheck
npm run build
```

Expected:
- `Test Files  306 passed (306)`
- `Tests  5138 passed (5138)`
- `tsc --noEmit` exits 0 with no output.
- `npm run build` exits 0.

If the test total differs from 5138, do not adjust tests to reach the number — report the discrepancy with the failing or unexpectedly-added test names as a blocker.

Manual verification is not required for this change: every behavior altered is covered by the tests specified above, and the one file without unit coverage (`src/extension.ts`) is verified by inspection in Task 4.

Commit the work as four commits, one per task, in task order, with these messages:

```
fix(gates): park a ticket with no registered worktree instead of passing it
fix(dashboard): offer Resume on a block a retry can clear
fix(dashboard): withhold the done row from an interrupted implementation run
fix(dashboard): refresh the sidebar once per external registry change
```

## Executor Rules

1. Execute tasks strictly in numerical order.
2. Complete the current task and its verification before starting the next task.
3. Implement the solution described in the plan exactly.
4. Do not redesign architecture or substitute a different approach.
5. Do not add features, cleanup, abstractions, or refactors not explicitly required by the plan.
6. Do not omit planned behavior because another implementation appears simpler.
7. Do not reinterpret product requirements.
8. Do not make optional improvements.
9. Follow existing project conventions where the plan explicitly relies on them.
10. Run the verification specified for every task.
11. Mark a task complete only when its completion criteria are satisfied.
12. If implementation reveals information that does not affect the prescribed solution, continue execution.
13. Stop rather than improvise when the plan cannot be executed as written.

The executor may stop only for a concrete blocker such as:

- a referenced file, API, dependency, or subsystem does not exist;
- repository state materially contradicts facts the plan depends on;
- a required credential or external resource is unavailable;
- the prescribed implementation is technically impossible;
- executing the plan would require making an architectural or product decision not covered by the plan;
- two instructions in the plan directly contradict each other;
- verification proves that an assumption fundamental to the planned implementation is false.

When stopping, the executor must report:

- the task number;
- the exact blocker;
- the evidence establishing the blocker;
- which plan assumption is invalid;
- the minimum planning decision required to continue.

The executor must **not** propose or implement an alternative unless explicitly asked to re-plan.
