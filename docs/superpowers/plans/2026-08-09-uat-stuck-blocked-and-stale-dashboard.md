# Plan — UAT gets stuck blocked, reads as running, and the dashboard goes stale

Five tasks. **Do them in order. Task 1 is investigation and produces no code.**
Tasks 2–5 are independent of each other and touch different files, so commit each
one separately.

## The three symptoms (from a real screenshot)

A ticket sat at UAT for 1h33m showing ALL of this at the same time:

- the stage strip showed `UAT` with a spinner and "1h 33m elapsed"
- the Gates row said "running the first gate — each result lands here as it finishes"
- a red banner below said **"UAT is blocked — none of this ticket's worktrees
  resolved to a manifest repository with changes:
  `/Users/nd/Work/projects/tatto-timer` — a repository karst cannot map to a
  manifest entry is not the same as nothing for UAT to check"**, with a `Resume`
  button
- clicking `Resume` re-ran the stage and produced the same block again, forever
- separately: after the agent marked implementation done (`karst stage impl
  pass`, which runs in a DIFFERENT PROCESS), the open dashboard did not move to
  UAT until the panel was closed and reopened

Three distinct bugs. Do not try to fix them with one change.

- **Bug 1 (Tasks 2+3):** UAT parks because the worktree's repository path does
  not match any manifest `repoPath`. The comparison is a raw string compare, and
  the message conflates "not in the manifest" with "in the manifest but
  unchanged" — two different situations that need two different outcomes.
- **Bug 2 (Task 4):** a blocked stage keeps its stored status of `running`, so
  every surface renders a spinner and a growing elapsed clock beside a banner
  saying it is blocked. The UI contradicts itself.
- **Bug 3 (Task 5):** the CLI writes the marker from another process; the
  extension host never learns the database changed, so an open panel is stale.

## Ground rules (read before writing any code)

1. **Never invent a fact.** Show only what karst recorded or resolved. No
   placeholder values, no `—`, no `0` standing in for "unknown".
2. **TDD.** Write the test. Run it. Watch it FAIL for the right reason. Then
   write the code. A test that passes before you write the fix is testing
   nothing — throw it away and write a real one.
3. Run `npm test` (never `npx vitest` — wrong native ABI, it will crash) and
   `npm run typecheck`.
4. A block is **not** a verdict. Never turn a block into `failed`. Never turn it
   into `passed` either, unless this plan explicitly tells you to for a specific
   case (Task 3 has exactly one such case, and it is not a block at all).
5. Do not reformat code you were not asked to change.

---

# TASK 1 — ALREADY ANSWERED. Read this, do not redo it.

Investigated 2026-08-09 against the user's real registry and manifest. The
answer changes the priority of the tasks below, so read it before starting.

**The paths match. Cause A is disproved for this ticket.**

- Manifest `/Users/nd/Work/projects/tatto-timer/.karst/karst.yml` declares one
  repository, `mobile-app`, with `repoPath: /Users/nd/Work/projects/tatto-timer`.
  (A second, legacy `karst.yml` at that repo's root uses the old `services:`
  schema and is NOT the file karst loaded.)
- Two tickets sit at `uat` in that project: id 162 `TEST-TASK` and id 163 `SDF`.
  Both `worktrees.repo` values are `/Users/nd/Work/projects/tatto-timer`.
- `od -c` of both sides: **byte-identical**, 44 chars, no trailing slash, no
  whitespace. `realpath` resolves to itself — no `/private` indirection.
- So `namesByPath.get(worktree.repo)` DOES find `['mobile-app']`. The mapping
  works.

**The real cause is B: the change set is empty.** In both worktrees,
`git status --porcelain` prints nothing and `git diff --quiet origin/main...HEAD`
exits 0. `hasReviewChanges` therefore correctly reports `changed: false`, the
`affected` set stays empty, `selectReviewTargets` returns zero targets, and the
stage parks with a message written for the unmapped case — which is factually
wrong here, because the mapping succeeded. These are scratch tickets that never
produced a diff.

**Bug 2 is confirmed straight from the database, not just the screenshot:** both
`stages` rows read `status = 'running'` WITH `blocked_kind = 'nothing-to-run'`
and `attempt = 0`. That is exactly the contradiction Task 4 fixes.

## What this means for the tasks below

- **Task 3 is the fix for the user's ticket.** Do it first. A repository that
  mapped fine and has no diff must not park forever behind a Resume button that
  cannot change the outcome; it is "nothing to check", and the stage should pass
  with a note. Note the investigating agent's own conclusion that the current
  behaviour is "correct" is WRONG on this point: reproducing an identical
  unclearable block on every Resume is the defect being reported.
- **Task 2 is still worth doing, but it is now defensive**, not the fix. It is
  not speculative work: the raw string compare is a real latent failure for any
  user whose manifest path is relative or symlinked. Do it, do not skip it, but
  do not expect it to change this ticket's behaviour.
- **One loose end, if you want certainty:** the report read the Cursor copy of
  the registry (`~/Library/Application Support/Cursor/User/globalStorage/
  karst.karst/karst.db`), chosen because it had recent WAL activity and held
  both blocked tickets. A separate VS Code copy exists and was not queried. If
  the screenshot came from the VS Code window instead, its ticket could still be
  a genuine path mismatch. Only worth chasing if the user says the screenshot
  was VS Code, not Cursor.

---

# TASK 1 (ORIGINAL BRIEF — kept for the record, already executed)

You must find out WHY `/Users/nd/Work/projects/tatto-timer` did not match a
manifest entry. Do not skip this. Tasks 2 and 3 fix two different causes and you
need to know which one is real here.

Read `src/workflow/gates/targets.ts`, function `selectReviewTargets` (line ~132).
It builds:

```ts
  const namesByPath = new Map<string, string[]>();
  for (const [name, repository] of Object.entries(manifest.repositories)) {
    ...
    namesByPath.set(repository.repoPath, names);
  }
  ...
    const names = namesByPath.get(worktree.repo) ?? [];
```

That is a **raw string** lookup: `manifest.repositories[*].repoPath` on one side,
the `worktrees` row's `repo` column on the other.

Answer these four questions and write the answers into your final report:

1. What exactly is in `manifest.repositories` for this user's project — the
   `repoPath` string for each entry, verbatim? (Read their `karst.yml`. Ask the
   user for it if you cannot find it. **Do not guess.**)
2. What exactly is in the `worktrees` table's `repo` column for this ticket?
3. Do the two strings differ, and how? Candidates, in order of likelihood:
   - one is absolute and the other relative (`./tatto-timer`)
   - a trailing slash on one side
   - a symlink: on macOS `/Users/...` may resolve through `/private/...` or a
     symlinked workspace root, so two strings can name the same directory
   - a case difference (macOS filesystems are usually case-insensitive)
   - the repository is genuinely not in the manifest at all
4. If the strings are IDENTICAL, then the mapping worked and the drop happened
   for the other reason: `hasReviewChanges` said the repo has no changes. Say so
   explicitly — that sends you to Task 3 rather than Task 2.

Report your finding before continuing. If (4) is the answer, still do Task 2
(it is correct regardless), but Task 3 is the one that fixes the user's ticket.

---

# TASK 2 — compare repository paths canonically, not as raw strings

## Why

Two strings that name the same directory must map to the same repository. Today
they do not, and the failure is silent: the worktree is simply dropped from the
target list, and the stage parks claiming the repository "cannot be mapped".

## There is already a helper — use it, do not write a second one

`src/runtime/pathScope.ts` exports:

```ts
export function canonicalPath(p: string): string
```

It resolves symlinks via `realpathSync` and tolerates a path that does not exist
yet (it canonicalizes the deepest existing ancestor and re-joins the rest).
`runtime/worktreeServers.ts` already depends on this exact behaviour to avoid
killing the wrong process. **Do not use `path.resolve`, do not lowercase
anything, do not strip trailing slashes by hand.**

## Step 2.1 — the test (write this FIRST)

File: `src/workflow/gates/targets.test.ts`.

Add a test named `'maps a worktree to its manifest entry through a symlinked or
non-normalised path'`. Build a manifest whose `repoPath` differs from the
worktree row's `repo` only in normalisation (a trailing slash is the easiest
case to write and needs no filesystem). Call `selectReviewTargets` with a fake
`GitRunner` that reports changes, and assert the returned targets include that
repository with its manifest `names`.

Use the shared builders in `src/manifest/fixtures.ts` for the manifest — do not
hand-roll a manifest object.

Run it. It must FAIL, showing an empty target list.

## Step 2.2 — the fix

In `src/workflow/gates/targets.ts`, `selectReviewTargets`:

- import `canonicalPath` from `../../runtime/pathScope.js`
- key `namesByPath` by `canonicalPath(repository.repoPath)`
- look up with `canonicalPath(worktree.repo)`
- the second lookup, in the `targets:` return block at the bottom of the same
  function, must use the canonical key too — there are TWO lookups, and fixing
  only one produces a target list that disagrees with the changed-set

**Do NOT change what is stored.** `worktrees.repo` and `manifest.repoPath` keep
their original strings; only the comparison is canonical. The `GateTarget.repo`
you return must remain the original worktree string, because other code (and the
user's own eyes) expect the path they configured.

Check `dedupeTargetsByRepoPath` in the same file: it also keys a Map by
`target.repo`. Make it key by `canonicalPath(target.repo)` for the same reason —
two spellings of one directory must dedupe to one target, or the gates run twice
in the same folder. Keep the FIRST target's original `repo`/`path` strings in
the merged entry.

## Step 2.3 — check the other callers

Run `grep -rn "repoPath" src/ | grep -v "\.test\."`. For each place that
compares a `repoPath` against a worktree path with `===`, `startsWith`, or a Map
key, note it in your report. **Do not fix them in this commit.** One commit, one
change.

## Done when

- the new test passes and failed before
- `npm test` green, `npm run typecheck` clean
- commit: `fix(gates): match worktrees to manifest repositories by canonical path`

---

# TASK 3 — "mapped but unchanged" is not a block, and must not say it is

## Why

`noTargetsReason` (`src/workflow/gates/targets.ts` line ~78) produces ONE
sentence for TWO different situations:

```
none of this ticket's worktrees resolved to a manifest repository with changes:
<paths> — a repository karst cannot map to a manifest entry is not the same as
nothing for UAT to check
```

The sentence itself admits the two cases are different and then merges them. The
two situations are:

- **(A) unmapped** — the worktree's path is in no manifest entry. karst could not
  ask the question. This IS a block, and `Resume` is useless because retrying
  changes nothing: the user must fix `karst.yml` or re-scope the ticket.
- **(B) mapped, but no changes** — every repository resolved fine and none of
  them has a diff from its base. karst asked and the answer is "there is nothing
  to check". **This is not a block.** A stage with nothing to check has
  delivered everything it had.

Today both park the ticket forever with a Resume button that re-produces the same
park. That is the "always stuck on UAT" symptom.

## Step 3.1 — the reducer must report which case it is (test first)

In `src/workflow/gates/targets.ts`, extend the selection result so the caller can
tell the cases apart. Change the `targets` variant to carry the diagnosis:

```ts
export type TargetSelection =
  | { kind: 'targets'; targets: ReviewTarget[]; unmapped: readonly string[] }
  | { kind: 'unavailable'; blocker: BlockerKind; reason: string };
```

`unmapped` is the list of worktree `repo` strings that matched no manifest entry
(computed in `selectReviewTargets`, where the map lookup already happens — it is
the `names.length === 0` case). An empty array means every worktree mapped.

Mirror the same field on `UatTargetSelection` in `src/workflow/uat/targets.ts`
and pass it through `planUatTargets` (which currently rebuilds the object — add
`unmapped: selection.unmapped`). Same for the review planner
(`src/workflow/review/targets.ts`) if it rebuilds it too — read it and check.

Tests first, in `src/workflow/gates/targets.test.ts`:

1. `'names the worktrees that matched no manifest entry'` — one mapped repo with
   changes, one worktree pointing somewhere absent from the manifest. Expect
   `unmapped` to contain exactly the absent path.
2. `'reports no unmapped worktrees when every repository resolved'` — expect
   `unmapped` to be empty even when the target list is empty because nothing
   changed.

## Step 3.2 — split the two outcomes at the stage (test first)

File: `src/workflow/stages/uat.ts`, around line 285:

```ts
  if (targets.length === 0) {
    const reason = noTargetsReason(worktrees, 'UAT');
    return finish({ kind: 'blocked', blocker: 'nothing-to-run', reason }, [reason]);
  }
```

Replace with a two-way split:

- **if `planned.unmapped.length > 0`** → keep the block. Use a reason that names
  ONLY the unmapped paths and says what the user must do, e.g.
  `` `these worktrees match no repository in karst.yml: ${planned.unmapped.join(', ')} — add them to `repositories:` or re-scope the ticket` ``.
  Blocker kind stays `nothing-to-run`.
- **if `planned.unmapped.length === 0`** → this is case (B). The stage PASSES
  with a note. Use whatever the stage's existing pass path is (`finish` with the
  passing verdict — read the surrounding function and copy the shape of the
  normal success return; **do not hand-write a `transition` call**). The recorded
  note must say plainly: `no repository has changes from its base, so UAT had
  nothing to check`.

Do the identical split in `src/workflow/stages/review.ts` (line ~261). The two
stages must not disagree about what "nothing to check" means.

Tests, in `src/workflow/stages/uat.test.ts` and `review.test.ts`:

1. `'blocks and names the unmapped worktrees when a repository is missing from the manifest'`
2. `'passes with a note when every repository mapped and none has changes'` —
   assert the ticket ADVANCED (its stage moved on) and that no block was written.
3. `'still blocks when git could not be asked'` — the pre-existing
   `unavailable` path must be unchanged. This test guards you against
   over-applying the new pass.

**Danger:** case (B) is a PASS, so it moves the ticket forward. Be certain your
test 3 above still blocks, and be certain you did not make a git failure look
like "nothing to check". A failed probe is `kind: 'unavailable'` and it comes
back BEFORE this code — if you find yourself touching that branch, stop and
re-read.

## Step 3.3 — the banner must not offer a dead button

File: `src/ui/dashboard/webview.html`, function `renderBlocked` (line ~2032).

There is already a precedent immediately above the code you will change:
`awaiting-merge` renders a title and reason and NO Resume button, because
`stageResume.ts` refuses to clear that kind and a button that always no-ops is a
lie.

The unmapped case is the same shape of problem for a different reason: retrying
cannot succeed until the user edits `karst.yml`. But **the host decides this, not
the webview** — the webview may not pattern-match on a reason string.

So: in `src/model/stepper.ts`, where `blockedDetail` builds the cell's `blocked`
object (line ~75), add one boolean the host computes:

```ts
      /** Whether re-running the stage could plausibly clear this block. */
      resumable: boolean;
```

Set it `false` for `awaiting-merge` (which is already special-cased in the
webview — now the flag carries that, and you should switch the webview's
existing `awaiting-merge` branch to read the flag rather than the kind) and
`false` for the new unmapped block. Everything else is `true`.

To know which block is the unmapped one you need it to be distinguishable
without reading prose. Add a new `BlockerKind` member — `'unmapped-repository'`
— in `src/model/types.ts`, use it in Task 3.2's block, and map it to
`resumable: false`. Search for every exhaustive `switch` over `BlockerKind`
(`grep -rn "BlockerKind" src/`) and add the new case to each; the compiler will
find them if any switch is exhaustive, so **run `npm run typecheck` early and
often here**.

In the webview, render a non-resumable block with the title and reason and no
button, exactly like the `awaiting-merge` branch does today.

Copy for the new block's title: `UAT cannot run here` (and `Review cannot run
here`) — worded host-side, not in the webview. Look at how the existing title is
built (`STAGE_TITLE[cell.stageKey] + ' is blocked'`) and follow the same pattern.

Test in `src/ui/dashboard/webview.test.ts`: a state whose current stage carries a
non-resumable block renders the reason and contains no `data-act="stage-resume"`.

## Done when

- all new tests pass and failed first
- `npm test` green, `npm run typecheck` clean
- commit: `fix(gates): tell an unmapped repository apart from nothing to check`

---

# TASK 4 — a blocked stage must never render as running

## Why

`parkGateStage` (`src/store/stageBlocks.ts`) writes the block columns and
**deliberately does not touch the stage's status**, which is still `running` from
when the stage started. `StageStatus` has no `blocked` member
(`'pending' | 'running' | 'passed' | 'failed' | 'skipped'`), so every surface
that reads status keeps painting a spinner and an elapsed clock next to a banner
that says the stage is blocked. That is what produced "1h 33m elapsed" on a
stage that had not been doing anything for 1h 33m.

**Do not add a `blocked` member to `StageStatus`, and do not change what
`parkGateStage` stores.** The stored status is the record of what the runner was
doing; this is a presentation problem. Fixing it in the store would need a
migration and would break the "no attempt consumed, no verdict written" property
that park deliberately has.

## Step 4.1 — the derived rule (test first)

File: `src/model/stepper.ts`. The cell already carries both `status` and
`blocked`. Add ONE exported helper next to them:

```ts
/**
 * How a cell READS. A stage with a block is not running: park writes the block
 * and leaves the status the runner set, so a parked stage keeps saying
 * `running` — a spinner and a growing clock beside a banner saying it is
 * blocked. The stored status stays the record of what the runner was doing;
 * this is what every surface renders.
 */
export function displayStatus(cell: StepperCell): StageStatus | 'blocked'
```

Rule, and nothing more: if `cell.blocked` exists and `cell.status === 'running'`
→ `'blocked'`; otherwise `cell.status` unchanged. A `passed` stage with an
`awaiting-merge` block keeps reading `passed` — that is ship waiting to land, and
it is genuinely passed.

Tests in `src/model/stepper.test.ts`:

1. running + block → `'blocked'`
2. running, no block → `'running'`
3. passed + `awaiting-merge` block → `'passed'`
4. pending + block → `'pending'`

## Step 4.2 — use it on every surface

Find every consumer with `grep -rn "\.status" src/model/inside src/ui/dashboard
src/model/stagePalette.ts | grep -v "\.test\."` and route the ones that render a
STAGE cell through `displayStatus`. The known ones:

- `src/model/inside/index.ts`, `stageProcessStatus(cell)` — map `'blocked'` to
  the existing `'wait'` member of `InsideStatus`. There is already a `wait`
  status with amber styling; use it, do not add a new one.
- the stage strip's cell rendering (find it — search `stagePalette` consumers)
- the Inside header's elapsed clock: a blocked stage must stop counting. Find
  where the header's `clock` string is built in `src/ui/dashboard/state.ts` and
  make the elapsed span end at `blocked.at` instead of `now` when the cell reads
  blocked. **The block carries its own timestamp — use it. Do not fabricate an
  end time.**
- the gates process row (`src/model/inside/gates.ts`): I recently made an
  empty-batch running stage read `run` with the detail "running the first gate —
  each result lands here as it finishes". That copy is a LIE on a blocked stage
  and it is exactly what the screenshot shows. Gate it on the same rule: if the
  cell is blocked, the row is not running.

Add a render test in `src/ui/dashboard/webview.test.ts`:
`'never renders a spinner on a stage that is blocked'` — build a state whose
`uat` cell is `running` with a block, and assert the Inside header/gates row do
not carry the `run` class and the gates detail does not contain "running the
first gate".

## Done when

- `npm test` green, `npm run typecheck` clean
- commit: `fix(dashboard): stop a blocked stage from reading as running`

---

# TASK 5 — the dashboard must notice writes made by another process

## Why

`karst stage impl pass` runs in the **agent's own `node` process**
(`src/cli/stage.ts`), not in the extension host. It commits to the same SQLite
file. The extension host holds its own connection and has no idea anything
changed, so an open dashboard keeps rendering the last snapshot it built. Closing
and reopening the panel rebuilds it, which is why that "works".

## The mechanism — use this one, do not invent another

SQLite exposes `PRAGMA data_version`. Its value changes when **another
connection** commits to the database. It does NOT change for writes made on your
own connection. That is exactly the signal needed: it detects the CLI, and it
does not fire on the host's own writes (which already push state).

It is a single integer read with no table scan, so polling it every couple of
seconds costs effectively nothing.

## Step 5.1 — a tiny watcher module (test first)

New file: `src/store/externalChanges.ts`. No `vscode` import — this must be
testable under vitest like everything else.

```ts
/**
 * Watch for commits made by OTHER connections to the same database file.
 *
 * `PRAGMA data_version` changes when a different connection commits, and never
 * for a write on this one — so this fires for the `karst` CLI (a separate
 * `node` process the agent invokes) and stays silent for the extension host's
 * own writes, which already push their own state.
 */
export function watchExternalChanges(
  store: Store,
  onChange: () => void,
  opts: { intervalMs?: number; setInterval?: ..., clearInterval?: ... } = {},
): { dispose(): void }
```

- read the pragma with `store.db.prepare('PRAGMA data_version').get()`; it comes
  back as a row object — read the single column off it, do not assume a scalar
- remember the last value; call `onChange()` only when it differs
- default interval 2000 ms
- inject the timer functions so a test can drive it without real time
- **wrap the read in try/catch and swallow** — a locked database must never take
  down the host. On a throw, keep the last value and try again next tick.
- `dispose()` clears the timer and is idempotent

Tests in `src/store/externalChanges.test.ts` (use an in-memory store the way the
other store tests do — `openStore(':memory:')`):

1. `'fires when another connection commits'` — simulate by stubbing the pragma
   read to return a changed value; assert `onChange` ran exactly once.
2. `'stays silent when nothing changed'` — same value twice, `onChange` never
   called.
3. `'never throws out of the poll'` — make the read throw; assert no rejection
   and that a later successful poll still fires.
4. `'stops after dispose'`.

## Step 5.2 — wire it in the host

File: `src/extension.ts`, in `activate`, next to the other long-lived
subscriptions. On change, do exactly what the driver's own progress callback does
today (find it — it is the `onProgress` at line ~2020):

```ts
          provider.refresh();
          dashboard.pushState(id);
```

but for every ticket with an open panel. `DashboardManager` knows which those
are — add a small method to it (`openTicketIds(): number[]`, reading its
`panels` map) rather than exporting the map.

Push the watcher's disposable onto `context.subscriptions` so it dies with the
extension.

**Do not** trigger the stage driver from this callback. This is an observer: it
refreshes what is displayed and nothing else. Starting a run from a change
notification could start the same run in two windows at once — the DB is shared
by every window (see CLAUDE.md, "Projects scope the board across IDE windows").

## Step 5.3 — sanity check by hand

There is no automated test for the `extension.ts` wiring (it imports `vscode`).
State in your report that you verified it by reading the code, and list the
exact lines you added.

## Done when

- the four watcher tests pass and failed first
- `npm test` green, `npm run typecheck` clean
- commit: `feat(dashboard): refresh when another process writes to the registry`

---

# TASK 6 — the Implementation session ends nowhere and every row reads pending

## Why

Open a ticket whose impl stage is DONE and expand the session. The timeline shows
one row, `started`, and nothing after it. Every row's glyph is the hollow
"nothing happened" dot, so a finished session reads as pending.

Two separate causes, both in `timelineEvents` (`src/model/inside/agent.ts`,
line ~154):

- **No terminal row exists.** The function emits exactly three kinds of event:
  the run start, provider switch/resume segments, and reported phase marks.
  There is no row for the run ENDING — even though the end is recorded:
  `completeImplementationRun` (`src/store/implementationRuns.ts:277`) stamps
  `implementation_runs.ended_at` AND finishes the process run as `passed`. The
  reducer already reads `run.endedAt` (it uses it for the start row's duration)
  and then never states it.
- **Every row is `status: 'note'`.** That is correct for a phase mark and for a
  switch — a report is not a verdict, and a switch is not progress — but it
  means a completed session has no row that reads as completed anywhere in its
  body.

**Why only `started` and nothing else:** the other rows come from `phase_marks`,
which the agent writes by calling `karst phase <name>`. If the agent never called
it, there are no phases, and that silence is truthful — do NOT invent phase rows.
The missing row is the ENDING, which karst recorded itself.

## Step 6.1 — the terminal row (test first)

In `timelineEvents`, after the phase-mark loop and before the sort, add a final
event when `run.endedAt` is set:

```ts
  if (run.endedAt) {
    events.push({
      at: run.endedAt,
      row: {
        status: 'pass',
        label: 'done',
        detail: `implementation marked done · ${formatTime(run.endedAt)}`,
        role: 'phase',
      },
    });
  }
```

Rules you must not break:

- **Only when `run.endedAt` is set.** A running session has no end and must not
  be given one. No fallback to `now`, no fallback to the stage's `endedAt`.
- `status: 'pass'` is correct here and ONLY here: the impl marker is an explicit
  recorded act (`markImplementDone`), not an inference. Do not change the
  switch rows or the phase rows to `pass` — they remain notes.
- The sort already runs after this push; do not hand-place the row at the end.

Tests in `src/model/inside/agent.test.ts`:

1. `'closes the timeline with the recorded implementation marker'` — a run with
   `endedAt` set produces a final row labelled `done` with `status: 'pass'`.
2. `'leaves a running session open-ended'` — `endedAt: null` produces no such
   row. This is the test that stops you inventing an end.
3. `'keeps a phase mark a note, never a verdict'` — a run with both an end and
   phase marks: assert the phase rows are still `note`.

## Step 6.2 — check the process row's own status before changing anything

`sessionStatus(cell)` (same file, line ~266) already maps the impl STAGE cell to
the row's status: `passed → pass`, whose label is `Completed`. So a session on a
passed impl stage should ALREADY read Completed on the row itself.

**Verify this before touching it.** Build a fixture with a passed impl cell and
assert `implementationSessionProcess(...).status === 'pass'`. If it does, the
"shows as pending" report was about the hollow glyphs on the timeline ROWS
inside the body, which Step 6.1 fixes — and you must not change `sessionStatus`.
If it does NOT, report what the cell actually contained; do not patch the symptom
until you can say why the cell disagreed with the strip.

## Done when

- the three new tests pass and failed first
- `npm test` green, `npm run typecheck` clean
- commit: `feat(dashboard): close the implementation timeline with its recorded marker`

---

# Final report

1. **Task 1's answer** — the two path strings, verbatim, and which cause was
   real. This is the most valuable thing in your report; do not summarise it
   away.
2. What you changed, file by file, per commit.
3. The exact `npm test` summary line and `npm run typecheck` result.
4. Anything you could not do from a recorded fact, and which fact was missing.
5. The list from Task 2.3 (other raw `repoPath` comparisons you found and left
   alone).

If you get stuck, say exactly where and what you tried. Do not skip a step
silently, and never delete a test to make the suite green.
