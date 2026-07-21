# Implementation Record — Ship stage merge-conflict tracking

**Feature**: `869e7bwaf-ship-merge-conflicts`
**Date**: 2026-07-21
**Status**: COMPLETE — `npm test` 1430/1430 green (126 files), `npm run typecheck` clean

---

## Phase 1 — Non-blocking git runner

**Files**: `src/integrations/git.ts`, `src/integrations/git.test.ts`

- `defaultGitRunner` reimplemented on async `spawn` (was `spawnSync`), delegating to a new exported `runGit(args, cwd, timeoutMs?)`.
- `GIT_TIMEOUT_MS = 60_000`; a hung git is SIGKILLed and answered as `exitCode 1` + a timeout reason. Never throws, never rejects — the contract that every caller already relies on.
- `GitRunner` type unchanged, so **zero call sites changed**.
- Tests added: success, nonzero-without-throwing, **event loop stays free while git runs**, timeout, unspawnable `cwd`.

Why first: this feature puts a network `git fetch` on the ship path. Under `spawnSync` that froze the extension host — hook endpoint, every webview, every other session — for the round trip.

## Phase 2 — Detection

**Files**: `src/workflow/mergeCheck.ts` (new), `src/workflow/mergeCheck.test.ts` (new)

`checkMergeable(git, cwd, baseRef)` → `{ state, files, reason, headSha, baseSha }`.

- `git fetch origin <base>` → `rev-parse HEAD` → `rev-parse origin/<base>` → `git merge-tree --write-tree --name-only <base> <head>`.
- Exit 0 → `clean`; exit 1 → `conflicted` + parsed paths; anything else → `unknown` carrying git's own stderr.
- **Never throws.** Ship has no `failed` edge, so a throwing probe would park the ticket over an advisory check.
- Unparsable exit-1 output stays `conflicted` with `files: []` — a parsing surprise must not downgrade to clean.
- `baseRef` null → `unknown`, no git run at all (guessing `main` would produce a confident wrong answer).
- rev-parse exiting 0 with empty output → `unknown`, rather than interpolating `null` into the probe.

## Phase 3 — Persistence (schema v9)

**Files**: `src/store/schema.sql`, `src/store/migrations.ts`, `src/store/mergeChecks.ts` (new), `src/store/mergeChecks.test.ts` (new), `src/store/db.test.ts`

- `merge_checks(ticket_id, repo, state, files, reason, head_sha, base_sha, base_ref, checked_at)`, PK `(ticket_id, repo)`.
- **Upsert, not append-only** — the deliberate departure from `gate_runs`/`phase_marks`. Those record that an event happened; this records what is true now. A stale `clean` is not weaker evidence, it is a wrong answer stated confidently.
- `SCHEMA_VERSION` 8 → 9; guarded `CREATE TABLE IF NOT EXISTS`; **no backfill** (mergeability is a property of two refs that have both moved).
- `db.test.ts`: table count 10 → 11, every `user_version` assertion 8 → 9, new v8→v9 upgrade test.
- Read-side hardening: malformed `files` JSON → `[]`; unrecognised `state` → `unknown`, **never** `clean`.

## Phase 4 — Ship integration

**Files**: `src/workflow/stages/ship.ts`, `src/workflow/stages/ship.test.ts`

- `recordMergeChecks` runs after the PR loop (all branches pushed), before `transition`.
- Runs for **every** worktree, including one whose PR already existed and was skipped — that re-ship is exactly when a refreshed answer matters, since the base moves under a PR nobody touched.
- Outside the `try` that parks the ticket, and individually guarded: observability must not sink the operation it observes.
- **A conflict does not fail the stage.** Ship still transitions to `done`.

**Existing tests changed** (behaviour preserved, assertions re-expressed): five ship tests asserted exact git call lists and now filter through a `MUTATING` set (`status`/`add`/`commit`/`push`). Their intent — "does not re-push", "no duplicate work" — is unchanged and arguably stated more precisely; the read-only probe is simply not what they are about.

## Phase 5 — Read paths

**Files**: `src/model/mergeCheckView.ts` (new), `src/model/inside/index.ts`, `src/ui/dashboard/state.ts`, `src/context/ticketContext.ts`, plus tests in `src/model/inside/index.test.ts`, `src/context/ticketContext.test.ts`

- Shared presenter `summarizeMergeCheck` / `mergeOpStatus` so the panel and the CLI cannot drift into describing the same fact differently.
- Dashboard strip: one `merge` row per PR — `pass` / `fail` / **`note`** for unknown. A `fail` row inside a passed stage is correct: the ship succeeded, the merge is a separate fact.
- Ticket context: `· merge: …` suffixed on the existing PR line; inherited verbatim by the `karst context` CLI with no CLI change.
- **Absence renders as nothing**, never as clean. `mergeCheck` is spread in only when present, so a never-checked PR serializes to the exact JSON emitted before this existed.

---

## Deviations from PLAN.md

| Planned | Actual | Why |
|---|---|---|
| Write via `transition`'s `premutate` hook | Plain call after the PR loop | `premutate` fires once at transition time and cannot carry a per-worktree loop; merge state is not part of the verdict it must land atomically with |
| Check before the `if (prior) continue` skip | Separate loop after the PR loop | Same coverage (every worktree, skipped or not), and it keeps the PR flow readable |
| Staleness `(stale)` rendering (task 5.7) | **Not implemented** | Rendering it needs current SHAs, which only a git call could supply — and no read path may spawn a process. Refresh-on-every-ship + upsert already satisfies the requirement; the stored SHAs are persisted for a future consumer that has them |

## Verification

- [x] `npm test` — 1430 passed (1430), 126 files
- [x] `npm run typecheck` — clean
- [x] **Mutation check** — the tests were verified non-vacuous by breaking `checkMergeable`'s exit-1 branch (`=== 1` → `=== 999`), which failed 4 tests across `mergeCheck.test.ts` and `ship.test.ts` (`expected 'unknown' to be 'conflicted'`). Restored, suite green again.

### Acceptance criteria

| # | Criterion | Covered by |
|---|---|---|
| A1 | conflicted + file list | `mergeCheck.test.ts`, `ship.test.ts` "records the conflicting files" |
| A2 | clean reported clean | `mergeCheck.test.ts`, `ship.test.ts` "records a clean check" |
| A3 | failed check distinct, never clean | `mergeCheck.test.ts` ×5, `ship.test.ts` "records unknown, not clean" |
| A4 | updates rather than persisting stale | `mergeChecks.test.ts` "overwrites…", `ship.test.ts` "refreshes the check on a re-ship" |
| A5 | no breaking change | full suite green; `ticketContext.test.ts` "omits the merge suffix entirely"; `index.test.ts` "shows no merge row" |
| A6 | conflict does not fail ship | `ship.test.ts` "a conflict does not fail the ship" |
