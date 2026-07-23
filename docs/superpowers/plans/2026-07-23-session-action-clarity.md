# Session-Action Clarity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the ticket session button read an honest verb (Start/Continue/Open/Resume/Reopen) with a context subtitle on the sidebar and dashboard, and fix the `sessionId` capture bug that keeps it stuck on "Start".

**Architecture:** One pure function (`sessionAction`) derives `{kind, label, detail}` from ticket state already held by both callers (no new queries). The webviews render the verb + subtitle. A separate, prerequisite fix canonicalizes the worktree→ticket path match so `SessionStart` actually captures `sessionId` under symlinked repo paths.

**Tech Stack:** TypeScript (ESM, `.js` import suffixes), vitest, better-sqlite3 (`openStore(':memory:')`), standalone webview HTML (cannot import TS — copy ships in state).

## Global Constraints

- ESM: every relative import ends in `.js`. `moduleResolution: Bundler`.
- `noUncheckedIndexedAccess` on: array access needs `!` or a guard.
- Immutable: return new objects, never mutate inputs.
- Webview HTML is standalone — it MUST NOT import TS; all copy is computed host-side and shipped in state (same rule as `nowLine`).
- Pure model functions are unit-tested; `detail` is viewer-clock-free (no "2h ago" baked in — relative time is appended client-side from `lastActiveAt`).
- Conventional commits, one per task. Strict TDD RED→GREEN.
- Preserve the `8b0d72f` invariant: the session button NEVER overrides a stage that owns its own action (failed-gate log, ship confirm/retry, fix manual resume).

---

### Task 1: Fix the `sessionId` capture bug (symlink-invariant worktree match)

`ticketIdForWorktreePath` matches `WHERE path = ?` against the raw stored path, but the hook's `cwd` is realpath-resolved — so a symlinked repoPath drops every `SessionStart` and `sessionId` never lands. Canonicalize both sides on read (migration-free), reusing the file's existing `canonicalPath`.

**Files:**
- Modify: `src/runtime/worktree.ts:242-247` (`ticketIdForWorktreePath`)
- Test: `src/runtime/worktree.test.ts` (add case; create file if absent)

**Interfaces:**
- Consumes: `canonicalPath(p: string): string` (already exported, `worktree.ts:57`).
- Produces: `ticketIdForWorktreePath(store: Store, path: string): number | null` — unchanged signature, now symlink-invariant.

- [x] **Step 1: Write the failing test**

Add to `src/runtime/worktree.test.ts` (match the existing import style in that file; if the file does not exist, create it with the imports shown):

```ts
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, symlinkSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../store/db.js';
import { ticketIdForWorktreePath } from './worktree.js';

describe('ticketIdForWorktreePath (symlink-invariant)', () => {
  it('resolves a realpath cwd against a raw stored worktree path', () => {
    const store = openStore(':memory:');
    // A ticket + a real worktree dir reached through a symlinked parent.
    store.db.prepare(
      `INSERT INTO tickets (id, key, title, source, stage_current)
       VALUES (1, 'K-1', 't', 'manual', 'impl')`,
    ).run();
    const realBase = realpathSync(mkdtempSync(join(tmpdir(), 'karst-wt-')));
    const link = join(realBase, 'link');
    const target = join(realBase, 'target');
    mkdirSync(target);
    symlinkSync(target, link);
    const storedPath = join(link, 'wt'); // raw, symlinked — how createWorktree stores it
    mkdirSync(storedPath);
    store.db.prepare(
      `INSERT INTO worktrees (ticket_id, repo, path, branch, base_ref, deps_mode)
       VALUES (1, ?, ?, 'karst/k-1', 'main', 'inherited')`,
    ).run(realBase, storedPath);

    // The hook reports the realpath-resolved cwd (git/Claude behavior).
    const hookCwd = realpathSync(storedPath);
    expect(ticketIdForWorktreePath(store, hookCwd)).toBe(1);
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/runtime/worktree.test.ts -t "symlink-invariant"`
Expected: FAIL — returns `null` (raw string `path = ?` doesn't match the realpath cwd).

- [x] **Step 3: Write minimal implementation**

Replace the body of `ticketIdForWorktreePath` in `src/runtime/worktree.ts`:

```ts
export function ticketIdForWorktreePath(store: Store, path: string): number | null {
  // The hook's `cwd` is realpath-resolved (git/Claude report the real path), but
  // the stored `path` is a raw `join()` — a symlinked repoPath would never match a
  // raw `WHERE path = ?`. Compare canonically on both sides (the worktrees table
  // is tiny, so a scan is fine) — the same reason `worktreeRegisteredAt` above
  // canonicalizes before comparing git's output.
  const want = canonicalPath(path);
  const rows = store.db
    .prepare('SELECT ticket_id, path FROM worktrees')
    .all() as { ticket_id: number; path: string }[];
  for (const r of rows) {
    if (canonicalPath(r.path) === want) return r.ticket_id;
  }
  return null;
}
```

- [x] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/runtime/worktree.test.ts`
Expected: PASS.

- [x] **Step 5: Typecheck + commit**

```bash
npm run typecheck
git add src/runtime/worktree.ts src/runtime/worktree.test.ts
git commit -m "fix(hooks): symlink-invariant worktree->ticket match so SessionStart captures sessionId"
```

---

### Task 2: Widen `sessionAction` to an honest verb set + `detail` subtitle

Replace the binary `{continue, start}` with `start|continue|open|resume|reopen`, each carrying a viewer-clock-free `detail`. Inputs are all already held by both callers (`Ticket` / `TicketWithStages`): `sessionId`, `stageCurrent`, `agentState`, `selectedRepos`.

**Files:**
- Modify: `src/agent/sessionAction.ts` (whole file)
- Modify: `src/agent/sessionAction.test.ts` (rewrite for the new shape)
- Unchanged: `src/agent/resumeDecision.ts` (still the `continue` predicate)

**Interfaces:**
- Consumes: `shouldResumeSession({ sessionId, stageCurrent })` (`resumeDecision.ts`), `AgentState` / `StageKey` (`model/types.js`).
- Produces:
  ```ts
  type SessionActionKind = 'start' | 'continue' | 'open' | 'resume' | 'reopen';
  interface SessionAction { kind: SessionActionKind; label: string; detail: string; }
  function sessionAction(t: {
    sessionId: string | null;
    stageCurrent: StageKey | string | null;
    agentState?: AgentState | string | null;
    selectedRepos?: readonly string[];
  }): SessionAction;
  ```

- [x] **Step 1: Write the failing tests**

Replace `src/agent/sessionAction.test.ts` with:

```ts
import { describe, it, expect } from 'vitest';
import { sessionAction } from './sessionAction.js';

describe('sessionAction', () => {
  it('OPEN when the agent is live, regardless of stage', () => {
    expect(sessionAction({ sessionId: 'a', stageCurrent: 'impl', agentState: 'running' }))
      .toEqual({ kind: 'open', label: 'Open', detail: 'session is live · jump to terminal' });
  });

  it('CONTINUE an interrupted impl/fix with a captured id', () => {
    expect(sessionAction({ sessionId: 'a', stageCurrent: 'impl', agentState: 'idle' }))
      .toEqual({ kind: 'continue', label: 'Continue', detail: 'resume impl' });
    expect(sessionAction({ sessionId: 'a', stageCurrent: 'fix', agentState: 'idle' }))
      .toEqual({ kind: 'continue', label: 'Continue', detail: 'resume fix' });
  });

  it('START (re-seed) at impl/fix when no id was captured', () => {
    expect(sessionAction({ sessionId: null, stageCurrent: 'impl' }))
      .toEqual({ kind: 'start', label: 'Start', detail: 're-seed from context' });
  });

  it('RESUME when parked at a gate/ship stage', () => {
    expect(sessionAction({ sessionId: 'a', stageCurrent: 'uat' }))
      .toEqual({ kind: 'resume', label: 'Resume', detail: 'picks up at uat' });
    expect(sessionAction({ sessionId: null, stageCurrent: 'review' }))
      .toEqual({ kind: 'resume', label: 'Resume', detail: 'picks up at review' });
    expect(sessionAction({ sessionId: null, stageCurrent: 'ship' }).kind).toBe('resume');
  });

  it('REOPEN when done', () => {
    expect(sessionAction({ sessionId: 'a', stageCurrent: 'done' }))
      .toEqual({ kind: 'reopen', label: 'Reopen', detail: 'shipped · follow-up session' });
  });

  it('START (fresh) for a draft — null/scope — naming the repo count', () => {
    expect(sessionAction({ sessionId: null, stageCurrent: null, selectedRepos: ['a', 'b'] }))
      .toEqual({ kind: 'start', label: 'Start', detail: 'fresh · scopes 2 repos' });
    expect(sessionAction({ sessionId: null, stageCurrent: 'scope', selectedRepos: ['a'] }))
      .toEqual({ kind: 'start', label: 'Start', detail: 'fresh · scopes 1 repo' });
    expect(sessionAction({ sessionId: null, stageCurrent: null }))
      .toEqual({ kind: 'start', label: 'Start', detail: 'fresh session' });
  });
});
```

- [x] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/agent/sessionAction.test.ts`
Expected: FAIL — current `sessionAction` returns no `detail` and has no `open`/`resume`/`reopen`.

- [x] **Step 3: Write the implementation**

Replace `src/agent/sessionAction.ts` with:

```ts
import type { StageKey, AgentState } from '../model/types.js';
import { shouldResumeSession } from './resumeDecision.js';

/**
 * What the returning-user session entry point (sidebar button, dashboard Now
 * line) will DO when clicked, and the verb it reads. The set is honest about
 * which of several returning states the ticket is in — "Start" no longer
 * collapses a ticket full of work into a verb that reads like "wipe and restart".
 *
 * `continue` — resume the exact captured interactive session (§5.3).
 * `open`     — a session is already live; jump to its terminal.
 * `resume`   — parked at a gate/ship; open a fresh session that picks up there.
 * `reopen`   — shipped; open a follow-up session.
 * `start`    — no resumable work: a never-run draft, or an interactive stage
 *              with no captured id (re-seed from context).
 */
export type SessionActionKind = 'start' | 'continue' | 'open' | 'resume' | 'reopen';

export interface SessionAction {
  kind: SessionActionKind;
  /** The button verb — "Start" | "Continue" | "Open" | "Resume" | "Reopen". */
  label: string;
  /** Short subtitle: what the click does. Viewer-clock-free (no "2h ago"). */
  detail: string;
}

function act(kind: SessionActionKind, label: string, detail: string): SessionAction {
  return { kind, label, detail };
}

/**
 * Decide the entry-point verb + subtitle for a ticket. The `continue` branch is
 * `shouldResumeSession` verbatim so the label's promise can never drift from
 * `openSession`'s actual `--resume` decision — the verb is a preview of it.
 */
export function sessionAction(t: {
  sessionId: string | null;
  stageCurrent: StageKey | string | null;
  agentState?: AgentState | string | null;
  selectedRepos?: readonly string[];
}): SessionAction {
  const stage = t.stageCurrent;

  // A live agent: the move is to jump to the running terminal, not re-launch.
  if (t.agentState === 'running') {
    return act('open', 'Open', 'session is live · jump to terminal');
  }

  // Interactive stages: resume the exact session, or re-seed if none was captured.
  if (stage === 'impl' || stage === 'fix') {
    return shouldResumeSession({ sessionId: t.sessionId, stageCurrent: stage })
      ? act('continue', 'Continue', `resume ${stage}`)
      : act('start', 'Start', 're-seed from context');
  }

  // Parked at a gate or ship: a fresh session picks up where the ticket sits.
  if (stage === 'uat' || stage === 'review' || stage === 'ship') {
    return act('resume', 'Resume', `picks up at ${stage}`);
  }

  if (stage === 'done') {
    return act('reopen', 'Reopen', 'shipped · follow-up session');
  }

  // Draft (null) or scope: a fresh, self-scoping start. Name the repo count when
  // known so "Start" states what it will do.
  const n = t.selectedRepos?.length ?? 0;
  return act('start', 'Start', n > 0 ? `fresh · scopes ${n} repo${n === 1 ? '' : 's'}` : 'fresh session');
}
```

- [x] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/agent/sessionAction.test.ts`
Expected: PASS.

- [x] **Step 5: Typecheck + commit**

```bash
npm run typecheck
git add src/agent/sessionAction.ts src/agent/sessionAction.test.ts
git commit -m "feat(session): honest verb set (open/resume/reopen) + context subtitle"
```

---

### Task 3: Carry `detail` through the dashboard Now line

`buildNowLine` already attaches the `session` action at the null-cell, scope-pending, and impl states. Add `detail` to the `session` `NowAction` so the dashboard can render a subtitle. Attachment points and the stage-owns-its-action invariant are unchanged.

**Files:**
- Modify: `src/model/nowLine.ts` (the `NowAction` union + the `session` const)
- Modify: `src/model/nowLine.test.ts` (assertions now include `detail`)

**Interfaces:**
- Consumes: `SessionAction` (now `{ kind, label, detail }`) from Task 2.
- Produces: `NowAction` with `{ kind: 'session'; label: string; detail: string }`.

- [x] **Step 1: Update the failing tests**

In `src/model/nowLine.test.ts`, the three `sessionAction` inputs must now be full `SessionAction`s, and the expected `session` actions carry `detail`. Replace the two `.toEqual({...action:{kind:'session'...}})` blocks and the scope/ship cases so they read:

```ts
  it('offers a discoverable Start button on a never-started ticket', () => {
    const sa = { kind: 'start', label: 'Start', detail: 'fresh session' } as const;
    expect(buildNowLine(null, { sessionAction: sa })).toEqual({
      text: 'Now: not started. Launch a session to begin.',
      action: { kind: 'session', label: 'Start session', detail: 'fresh session' },
    });
    expect(
      buildNowLine(cell({ stageKey: 'scope', status: 'pending' }), { sessionAction: sa }).action,
    ).toEqual({ kind: 'session', label: 'Start session', detail: 'fresh session' });
  });

  it('offers a Continue button while impl is in progress', () => {
    const sa = { kind: 'continue', label: 'Continue', detail: 'resume impl' } as const;
    expect(buildNowLine(cell({ stageKey: 'impl' }), { sessionAction: sa })).toEqual({
      text: 'Now: implementing — the agent is working in its terminal.',
      action: { kind: 'session', label: 'Continue session', detail: 'resume impl' },
    });
  });

  it('never lets the session button override a stage that owns its action', () => {
    const sa = { kind: 'start', label: 'Start', detail: 'fresh session' } as const;
    expect(
      buildNowLine(cell({ stageKey: 'ship', status: 'pending' }), { sessionAction: sa }).action,
    ).toEqual({ kind: 'ship', label: 'Confirm ship' });
  });
```

- [x] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/model/nowLine.test.ts`
Expected: FAIL — the `session` action has no `detail` yet.

- [x] **Step 3: Write the implementation**

In `src/model/nowLine.ts`, extend the `session` member of the `NowAction` union:

```ts
export type NowAction =
  | { kind: 'open-log'; label: string; path: string }
  | { kind: 'ship'; label: string }
  | { kind: 'resume'; label: string }
  | { kind: 'session'; label: string; detail: string };
```

And update the `session` const inside `buildNowLine` to carry `detail`:

```ts
  const session: NowAction | undefined = ctx.sessionAction
    ? { kind: 'session', label: `${ctx.sessionAction.label} session`, detail: ctx.sessionAction.detail }
    : undefined;
```

- [x] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/model/nowLine.test.ts`
Expected: PASS.

- [x] **Step 5: Typecheck + commit**

```bash
npm run typecheck
git add src/model/nowLine.ts src/model/nowLine.test.ts
git commit -m "feat(nowline): session action carries a context subtitle"
```

---

### Task 4: Render verb + subtitle in the sidebar

`items.ts` already ships `row.sessionAction` (now `{kind,label,detail}` — no code change there). Render the subtitle in the expanded body and add a guard.

**Files:**
- Modify: `src/ui/sidebar/webview.html` (session button title + a subtitle line)
- Modify: `src/ui/sidebar/webview.test.ts` (guard the subtitle)
- Modify: `src/ui/sidebar/items.test.ts` (assert the new `detail` in `sessionAction`)

**Interfaces:**
- Consumes: `row.sessionAction = { kind, label, detail }`; existing `relTime(iso)` and `row.lastActiveAt`.

- [x] **Step 1: Update the failing item test**

In `src/ui/sidebar/items.test.ts`, replace the `sessionAction reads Continue…` assertion so it expects the new shape:

```ts
  it('sessionAction reads Continue for a captured interactive session, Start otherwise', () => {
    expect(
      buildTicketNodes([ticket({ sessionId: 'sid', stageCurrent: 'impl' })])[0]!.sessionAction,
    ).toEqual({ kind: 'continue', label: 'Continue', detail: 'resume impl' });
    expect(
      buildTicketNodes([ticket({ sessionId: null, stageCurrent: 'scope' })])[0]!.sessionAction,
    ).toEqual({ kind: 'start', label: 'Start', detail: 'fresh session' });
  });
```

(Note: the `ticket()` builder in this test seeds no `selectedRepos`, so a scope draft reads `'fresh session'`. If the builder does set `selectedRepos`, use the matching `fresh · scopes N repo` string.)

- [x] **Step 2: Add the failing webview guard**

In `src/ui/sidebar/webview.test.ts`, add:

```ts
  it('renders the session subtitle from row.sessionAction.detail', () => {
    expect(HTML).toContain('row.sessionAction.detail');
  });
```

- [x] **Step 3: Run tests to verify they fail**

Run: `npx vitest run src/ui/sidebar/items.test.ts src/ui/sidebar/webview.test.ts`
Expected: FAIL — items detail mismatch, and the HTML has no `row.sessionAction.detail`.

- [x] **Step 4: Render the subtitle in `webview.html`**

In `src/ui/sidebar/webview.html`, `activityLine(row)` currently returns the agent-state line. Append the session `detail` (a fresh info line — what the button will do) after it. Replace `activityLine`:

```js
  // The activity line: runtime state of the ticket's session, plus when it last
  // moved. New info vs the collapsed row (which only states the stage). The
  // second half is the session button's subtitle — what clicking it will do
  // (host-computed in row.sessionAction.detail) — with the viewer-clock relative
  // time appended here, never baked into the host copy.
  function activityLine(row) {
    const label = row.activityLabel || 'No active session';
    const rel = relTime(row.lastActiveAt);
    const head = rel ? `${esc(label)} · ${esc(rel)}` : esc(label);
    const detail = row.sessionAction && row.sessionAction.detail;
    return detail ? `${head}<br><span class="sess-sub">${esc(detail)}</span>` : head;
  }
```

- [x] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/ui/sidebar/items.test.ts src/ui/sidebar/webview.test.ts`
Expected: PASS.

- [x] **Step 6: Typecheck + commit**

```bash
npm run typecheck
git add src/ui/sidebar/webview.html src/ui/sidebar/webview.test.ts src/ui/sidebar/items.test.ts
git commit -m "feat(sidebar): show the session action's context subtitle"
```

---

### Task 5: Render the button + subtitle in the dashboard Now line

`state.ts` already passes `sessionAction(ticket)` — no host change. Render the `detail` beneath the Now button.

**Files:**
- Modify: `src/ui/dashboard/webview.html` (`renderNow`)
- Modify: `src/ui/dashboard/webview.test.ts` (guard the subtitle render)

**Interfaces:**
- Consumes: `now.action = { kind: 'session', label, detail }` from Task 3.

- [x] **Step 1: Add the failing webview guard**

In `src/ui/dashboard/webview.test.ts`, add (match the file's existing `HTML` fixture pattern):

```ts
  it('renders the Now session subtitle from action.detail', () => {
    expect(HTML).toContain('a.detail');
  });
```

- [x] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/ui/dashboard/webview.test.ts`
Expected: FAIL — `renderNow` never reads `a.detail`.

- [x] **Step 3: Render the subtitle in `renderNow`**

In `src/ui/dashboard/webview.html`, replace the final `el('now').innerHTML = …` assignment in `renderNow` so a `session` action renders its subtitle beneath the button:

```js
    const sub = a && a.kind === 'session' && a.detail
      ? `<div class="now-sub">${esc(a.detail)}</div>`
      : '';
    el('now').innerHTML = badge + `<span class="ntext">${esc(line.text)}</span>`
      + (type ? `<button data-act="${type}"${attrs}>${esc(a.label)}</button>` : '')
      + sub;
```

- [x] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/ui/dashboard/webview.test.ts`
Expected: PASS.

- [x] **Step 5: Full suite + typecheck + commit**

```bash
npm run typecheck
npm test
git add src/ui/dashboard/webview.html src/ui/dashboard/webview.test.ts
git commit -m "feat(dashboard): render the Now session button's context subtitle"
```

---

## Self-Review

**Spec coverage:**
- Capture bug fix → Task 1. ✅
- Widen model + `detail` → Task 2. ✅
- `nowLine` carries `detail` → Task 3. ✅
- Sidebar render → Task 4. ✅
- Dashboard button-with-subtitle → Task 5. ✅
- Keep the failed-gate split (no session button over a stage that owns its action) → preserved by Task 3 (attachment points unchanged); asserted by the `nowLine.test.ts` "never overrides" case. ✅
- No schema change / additive `detail` back-compat → Tasks touch no migrations; sidebar/dashboard already fall back to "Start" for pre-upgrade snapshots. ✅

**Deviation from spec (intentional, narrower):** the spec's `sessionAction` input listed `hasWorktree` + `stageStatus`. The plan drops both — the verb is fully determined by `sessionId`, `stageCurrent`, `agentState`, and `selectedRepos`, all already held by both callers, avoiding a per-row worktree query. Draft-vs-reseed is distinguished by `stageCurrent` (scope/null vs impl/fix), not worktree presence.

**Placeholder scan:** none — every code step shows full content.

**Type consistency:** `SessionAction { kind, label, detail }` defined in Task 2 is consumed identically in Tasks 3–5; `NowAction` `session` member gains `detail` in Task 3 and is read as `a.detail` in Task 5; `sessionAction` signature accepts the superset both callers already pass (no call-site plumbing changes in `items.ts`/`state.ts`).
