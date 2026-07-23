# Session-action clarity — honest verb + context subtitle

**Date:** 2026-07-23
**Status:** Approved, ready for planning
**Branch:** `karst/869e7czwb-fix-tiket-start-continue-after-drafting-or-leaving`

## Problem

The prior fix (`8b0d72f`) added a continue-or-start entry point, but the UI
still reads **"Start session"** on tickets that have real progress. Two distinct
root causes:

1. **Capture bug (not a label problem).** `sessionId` is set only on the
   `SessionStart` hook, keyed by `ticketIdForWorktreePath(store, cwd)`, which
   matches `WHERE path = ?` against the **raw** stored worktree path
   (`join(repoPath,'.karst/worktrees',slug)`, `worktree.ts:120`). Git and Claude
   report the **realpath-resolved** `cwd`, which is why `worktreeRegisteredAt`
   right above it calls `canonicalPath` before comparing (`worktree.ts:87`). Any
   repoPath with a symlink component (macOS `/tmp`, `/var`→`/private/var`,
   symlinked home) → hook `cwd` ≠ stored `path` → lookup returns `null` →
   `setSessionId` never runs → the button reads "Start" forever, even mid-impl.
   No label design can fix this.

2. **Verb vocabulary too small.** `sessionAction` emits only `{continue, start}`,
   and "Continue" appears only at `impl`/`fix`. Every other returning-user state
   (draft, mid-scope, parked at a gate, done) collapses to **"Start"**, which
   reads like "wipe and restart" on a ticket full of work. The sidebar row
   already shows `stageChip` + `activityLabel` + `blocker`, so the button verb is
   the only dishonest signal.

## Goals

- Fix `sessionId` capture so "Continue"/"Resume" can actually appear.
- Replace the binary verb with an **honest verb set** derived from real ticket
  state, each carrying a short **context subtitle** stating what the click does.
- Surface the verb + subtitle on **all three surfaces**: sidebar row, sidebar
  expanded body, and the dashboard **Now** line (as a real button with a
  subtitle beneath it — explicitly requested).

## Non-goals (YAGNI)

- No stepper / `stageChip` / lifecycle-chip redesign (rejected Approach C).
- No change to `openSession`'s actual `--resume` vs. fresh-seed decision — the
  verb is a *preview* of what `shouldResumeSession` already resolves at launch.
- No second action on the dashboard **failed-gate** Now line — it keeps only
  "Open log" (the stage owns its action, per `8b0d72f`); the sidebar still shows
  the session verb. Decision: keep the split.

## Design

### 1. Fix the capture bug first

Make the worktree→ticket match symlink-invariant. In
`ticketIdForWorktreePath` (`runtime/worktree.ts`), compare
`canonicalPath(cwd)` against `canonicalPath(path)` rather than a raw string
equality — reusing the `canonicalPath` helper already in the file. (Exact SQL
approach — canonicalize on read vs. also storing a canonical column — is a
planning-time choice; canonicalize-on-read is the minimal, migration-free
option and is preferred unless planning finds a reason otherwise.)

This is a prerequisite: without it the widened verb set can never reach the
`Continue`/`Resume` branches for symlinked repos.

### 2. Widen the model — one pure function, richer inputs

`sessionAction(t)` today takes `{sessionId, stageCurrent}` → `{kind, label}`.
Widen its input to what the callers already hold and add a `detail`:

```ts
export type SessionActionKind = 'start' | 'continue' | 'resume' | 'open' | 'reopen';

export interface SessionAction {
  kind: SessionActionKind;
  label: string;   // the verb: "Start" | "Continue" | "Resume" | "Open" | "Reopen"
  detail: string;  // short subtitle: what the click does, viewer-clock-free
}

export function sessionAction(t: {
  sessionId: string | null;
  stageCurrent: StageKey | string | null;
  agentState: AgentState | null;
  hasWorktree: boolean;
  stageStatus: StageStatus | null; // status of the current stage cell
}): SessionAction
```

Derivation (first match wins):

| ticket state | kind / label | detail (subtitle) |
|---|---|---|
| agent live (`agentState === 'running'`) | `open` / **Open** | "session is live · jump to terminal" |
| impl/fix + `sessionId` present | `continue` / **Continue** | "resume impl" |
| impl/fix, no `sessionId` | `start` / **Start** | "re-seed from context" |
| parked at a gate (uat/review, not failed) | `resume` / **Resume** | "picks up at {stage}" |
| done | `reopen` / **Reopen** | "shipped · follow-up session" |
| draft / no worktree / scope-pending | `start` / **Start** | "fresh · scopes {N} repo" |

Notes:
- `continue` detection stays `shouldResumeSession` verbatim so the label can
  never drift from `openSession`'s real `--resume` decision.
- `detail` is **viewer-clock-free** (no "2h ago" baked in). Relative time is a
  viewer concern: the sidebar already ships `lastActiveAt` (raw ISO) and formats
  it client-side; the webview may append that to the subtitle. Keeping the model
  clock-free preserves pure unit tests.
- `kind` also drives a visual weight/color so `Continue`/`Resume`/`Open` read
  differently from `Start` (returning-work vs. fresh).
- Pure, unit-tested, shipped inside state — the webviews are standalone HTML and
  cannot import TS (same constraint as `nowLine` copy).

### 3. Render on all three surfaces

- **Sidebar row** (`ui/sidebar/items.ts` → `webview.html`): verb in the button
  `title`; `detail` (+ appended relative `lastActiveAt`) in the expanded body
  line. Pre-upgrade snapshots with no `sessionAction` fall back to "Start".
- **Dashboard Now** (`model/nowLine.ts` → `ui/dashboard/webview.html`): the
  `session` `NowAction` carries `label` **and `detail`**; the webview renders a
  real button with the subtitle beneath it. Attached only to states where
  launching is the user's move — never over a stage that owns its action
  (failed-gate log, ship confirm/retry, fix manual resume). Both `session` and
  `resume` continue to route to `resume-ticket`; the host resolves the actual
  launch mode.

## Affected files

- `src/runtime/worktree.ts` — canonicalize the hook path match (bug fix).
- `src/agent/sessionAction.ts` — widen inputs, `kind` set, add `detail`.
- `src/agent/resumeDecision.ts` — unchanged (still the `continue` predicate).
- `src/model/nowLine.ts` — `session` action carries `detail`.
- `src/ui/sidebar/items.ts` — pass the richer inputs; expose `detail`.
- `src/ui/sidebar/webview.html` — render verb + subtitle.
- `src/ui/dashboard/state.ts` — pass richer inputs to `sessionAction`.
- `src/ui/dashboard/webview.html` — render the Now button + subtitle.
- Tests alongside each (`*.test.ts`), TDD RED→GREEN.

## Testing

- **Unit:** `sessionAction` truth table (every row above, incl. both impl no-id
  vs. with-id branches); `canonicalPath`-based match resolves a symlinked
  worktree path; `nowLine` carries `detail` and still yields to stage-owned
  actions.
- **Webview HTML guards:** sidebar and dashboard render `row.sessionAction`
  label + `detail`, with the "Start" fallback for stale snapshots.
- **Regression:** the `8b0d72f` invariant — failed gate / ship keep their own
  action, session button never overrides them.

## Rollout / back-compat

- `detail` is additive on `SessionAction`; a pre-upgrade webview snapshot lacking
  it degrades to verb-only (already handled by the "Start" fallback pattern).
- No schema change, no migration.
