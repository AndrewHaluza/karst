# Orchestration Flow Completion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the designed stage flow to completion — persist `session_id` for `--resume`, and add a `StageDriver` that auto-runs the deterministic gates (uat→review) after the explicit impl marker, stopping at fix/ship/done and interruptible with Stop.

**Architecture:** Follows the existing host-agnostic seam: all logic lands in `vscode`-free modules tested under vitest; `extension.ts` is the only place real `vscode` binds. The driver is a fold over `stage_current` that calls the existing stage runners (which already own `transition()`), never a second source of transition logic. Session-id capture rides the existing HTTP hook dispatch.

**Tech Stack:** TypeScript (ESM, `type:module`), better-sqlite3, vitest, Node `child_process`.

**Spec:** `docs/superpowers/specs/2026-07-14-orchestration-flow-completion-design.md`

## Global Constraints

- ESM: every relative import needs a `.js` suffix; `moduleResolution:Bundler`.
- `noUncheckedIndexedAccess` is on — array/index access needs a guard or `!`.
- Strict TDD: RED (write test, run, see it fail) → GREEN (minimal impl, run, pass) → commit. Conventional commits.
- Tests run under Node ABI: `npm test` auto-runs `pretest` (`rebuild:node`). Run single files with `npx vitest run <path>` only after a `rebuild:node` in this worktree.
- Single-writer discipline: all `stages` mutation via `setStage`; all `agent_state` via `setAgentState`; all `session_id` via the new `setSessionId`. `transition()` in `src/workflow/machine.ts` is the ONLY place a stage transition is authored — the driver calls runners, never `transition` directly.
- `vscode`-importing modules don't load under vitest — keep testable logic in `vscode`-free modules, keep the `extension.ts` binding a thin wrapper.
- Keep files focused (<400 lines typical).

---

## Phase 1 — Session persistence

### Task 1: `setSessionId` store writer

**Files:**
- Modify: `src/store/tickets.ts` (add export near `setAgentState`)
- Test: `src/store/tickets.test.ts`

**Interfaces:**
- Produces: `setSessionId(store: Store, ticketId: number, sessionId: string): void`

- [ ] **Step 1: Write the failing test**

Add to `src/store/tickets.test.ts`:

```ts
import { setSessionId } from './tickets.js';

describe('setSessionId', () => {
  it('persists session_id and leaves it readable via getTicket', () => {
    const store = openStore(':memory:');
    const t = createTicket(store, { key: 'K-1', title: 'demo' });
    setSessionId(store, t.id, 'sess-abc');
    expect(getTicket(store, t.id).sessionId).toBe('sess-abc');
    store.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/store/tickets.test.ts -t "persists session_id"`
Expected: FAIL — `setSessionId is not a function` (import error).

- [ ] **Step 3: Write minimal implementation**

Add to `src/store/tickets.ts`, directly below `setAgentState`:

```ts
/**
 * Set a ticket's `session_id` — the agent session to `--resume` (§5.3). Captured
 * from the SessionStart hook. Single-writer discipline: all session_id mutation
 * goes through here.
 */
export function setSessionId(store: Store, ticketId: number, sessionId: string): void {
  store.db
    .prepare('UPDATE tickets SET session_id = ? WHERE id = ?')
    .run(sessionId, ticketId);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/store/tickets.test.ts -t "persists session_id"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/store/tickets.ts src/store/tickets.test.ts
git commit -m "feat(store): setSessionId single-writer for --resume capture"
```

---

### Task 2: capture `session_id` on the SessionStart hook

**Files:**
- Modify: `src/hooks/dispatch.ts`
- Test: `src/hooks/dispatch.test.ts`

**Interfaces:**
- Consumes: `setSessionId` (Task 1), existing `ticketIdForWorktreePath`, `setAgentState`.

- [ ] **Step 1: Write the failing test**

Add to `src/hooks/dispatch.test.ts` (reuse its existing store + worktree seeding helpers; the pattern below assumes a `seedTicketWithWorktree(store, cwd)` returning the ticket id — mirror whatever the file already does to register a worktree path):

```ts
it('persists session_id on SessionStart and sets agent_state running', () => {
  const { store, ticketId, cwd } = seedTicketWithWorktree();
  dispatchHook(store, { hook_event_name: 'SessionStart', cwd, session_id: 'sess-xyz' });
  const t = getTicket(store, ticketId);
  expect(t.sessionId).toBe('sess-xyz');
  expect(t.agentState).toBe('running');
});

it('does not touch session_id on a Stop event', () => {
  const { store, ticketId, cwd } = seedTicketWithWorktree();
  dispatchHook(store, { hook_event_name: 'SessionStart', cwd, session_id: 'sess-1' });
  dispatchHook(store, { hook_event_name: 'Stop', cwd, session_id: 'sess-DIFFERENT' });
  expect(getTicket(store, ticketId).sessionId).toBe('sess-1');
});
```

If `dispatch.test.ts` has no worktree-seeding helper, seed inline: `createTicket` then insert a `worktrees` row whose `path === cwd` the same way `ticketIdForWorktreePath` looks it up (check `src/runtime/worktree.ts` for the exact table/column), so `ticketIdForWorktreePath(store, cwd)` resolves.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/hooks/dispatch.test.ts -t "persists session_id on SessionStart"`
Expected: FAIL — `t.sessionId` is `null`.

- [ ] **Step 3: Write minimal implementation**

In `src/hooks/dispatch.ts`, add the import and persist step. Change the import line:

```ts
import { setAgentState, setSessionId } from '../store/tickets.js';
```

In `dispatchHook`, insert the capture between the ticket lookup and the `nextAgentState` call:

```ts
  const ticketId = ticketIdForWorktreePath(store, payload.cwd);
  if (ticketId === null) return;

  // Persist the session on its first event so resume (§5.3) has a target. Only
  // SessionStart carries the authoritative id for a fresh session; later events
  // of the same session repeat it, so first-capture-wins is enough.
  if (payload.hook_event_name === 'SessionStart' && payload.session_id) {
    setSessionId(store, ticketId, payload.session_id);
  }

  const state = nextAgentState(payload);
  if (state === null) return;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/hooks/dispatch.test.ts`
Expected: PASS (both new tests + existing).

- [ ] **Step 5: Commit**

```bash
git add src/hooks/dispatch.ts src/hooks/dispatch.test.ts
git commit -m "feat(hooks): capture session_id on SessionStart for --resume"
```

---

## Phase 2 — Interactive resume

### Task 3: thread `--resume` through the interactive command

**Files:**
- Modify: `src/agent/adapter.ts` (add `resume?` to `InteractiveCommandOpts`)
- Modify: `src/agent/claude.ts` (`buildInteractiveCommand`)
- Test: `src/agent/claude.test.ts`

**Interfaces:**
- Produces: `InteractiveCommandOpts.resume?: string`; when set, `buildInteractiveCommand` emits `--resume <id>`.

- [ ] **Step 1: Write the failing test**

Add to `src/agent/claude.test.ts` (a `ClaudeAdapter` is already constructed there — reuse it):

```ts
it('threads --resume when a session id is given', () => {
  const cmd = new ClaudeAdapter().buildInteractiveCommand({ cwd: '/wt', resume: 'sess-9' });
  expect(cmd.args).toContain('--resume');
  expect(cmd.args[cmd.args.indexOf('--resume') + 1]).toBe('sess-9');
});

it('omits --resume when no session id is given', () => {
  const cmd = new ClaudeAdapter().buildInteractiveCommand({ cwd: '/wt' });
  expect(cmd.args).not.toContain('--resume');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/agent/claude.test.ts -t "threads --resume"`
Expected: FAIL — `--resume` not in args.

- [ ] **Step 3: Write minimal implementation**

In `src/agent/adapter.ts`, add to `InteractiveCommandOpts` (after `settingsPath`):

```ts
  resume?: string; // session_id to --resume an interrupted interactive session (§5.3)
```

In `src/agent/claude.ts` `buildInteractiveCommand`, add the flag right after the `settingsPath` block:

```ts
    if (opts.resume && opts.resume.length > 0) {
      // Continue a previously-captured session instead of a cold start (§5.3).
      args.push('--resume', opts.resume);
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/agent/claude.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/agent/adapter.ts src/agent/claude.ts src/agent/claude.test.ts
git commit -m "feat(agent): --resume support in buildInteractiveCommand"
```

---

### Task 4: `SessionManager.openSession` forwards `resume`

**Files:**
- Modify: `src/ui/session.ts`
- Test: `src/ui/session.test.ts`

**Interfaces:**
- Produces: `openSession(ticketId, worktreePath, label?, initialPrompt?, extraArgs?, model?, resume?)` — new trailing `resume?: string` param, forwarded to `buildInteractiveCommand`.

- [ ] **Step 1: Write the failing test**

Add to `src/ui/session.test.ts` (it already builds a `SessionManager` with a fake adapter + terminal host — reuse those; capture the opts the fake adapter's `buildInteractiveCommand` receives):

```ts
it('forwards resume to buildInteractiveCommand', () => {
  const seen: unknown[] = [];
  const adapter = fakeAdapter((opts) => seen.push(opts)); // fake records opts, returns {command,args:[],env:{}}
  const mgr = new SessionManager(adapter, fakeTerminalHost(), () => '/settings.json');
  mgr.openSession(1, '/wt', { key: 'K-1' }, 'seed', undefined, undefined, 'sess-7');
  expect((seen[0] as { resume?: string }).resume).toBe('sess-7');
});
```

Match the existing test file's fake helpers; if it constructs the fake adapter inline, extend that inline fake to record `buildInteractiveCommand` opts.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/ui/session.test.ts -t "forwards resume"`
Expected: FAIL — `resume` is `undefined` (param not accepted/forwarded).

- [ ] **Step 3: Write minimal implementation**

In `src/ui/session.ts` `openSession`, add the trailing param and forward it:

```ts
  openSession(
    ticketId: number,
    worktreePath: string,
    label?: { key?: string | null; title?: string | null },
    initialPrompt?: string,
    extraArgs?: string[],
    model?: string,
    resume?: string,
  ): void {
```

and in the `buildInteractiveCommand({ ... })` call add:

```ts
      ...(resume ? { resume } : {}),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/ui/session.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ui/session.ts src/ui/session.test.ts
git commit -m "feat(session): forward resume id to interactive launch"
```

---

### Task 5: resume-vs-fresh decision (pure) + wire into openSession handler

**Files:**
- Create: `src/agent/resumeDecision.ts`
- Test: `src/agent/resumeDecision.test.ts`
- Modify: `src/extension.ts` (openSession command handler, ~line 561–694)

**Interfaces:**
- Produces: `shouldResumeSession(t: { sessionId: string | null; stageCurrent: StageKey }): boolean`

- [ ] **Step 1: Write the failing test**

Create `src/agent/resumeDecision.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { shouldResumeSession } from './resumeDecision.js';

describe('shouldResumeSession', () => {
  it('resumes when an interactive stage has a captured session', () => {
    expect(shouldResumeSession({ sessionId: 'x', stageCurrent: 'impl' })).toBe(true);
    expect(shouldResumeSession({ sessionId: 'x', stageCurrent: 'fix' })).toBe(true);
  });
  it('does not resume without a session id', () => {
    expect(shouldResumeSession({ sessionId: null, stageCurrent: 'impl' })).toBe(false);
  });
  it('does not resume on non-interactive stages', () => {
    expect(shouldResumeSession({ sessionId: 'x', stageCurrent: 'uat' })).toBe(false);
    expect(shouldResumeSession({ sessionId: 'x', stageCurrent: 'scope' })).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/agent/resumeDecision.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

Create `src/agent/resumeDecision.ts`:

```ts
import type { StageKey } from '../model/types.js';

/**
 * Resume an existing agent session only when continuing interactive work (impl
 * or fix) AND a session was captured (§5.3). Otherwise a fresh, fully-seeded
 * session is correct (scope/uat/review/ship have no interactive continuation).
 */
export function shouldResumeSession(t: { sessionId: string | null; stageCurrent: StageKey }): boolean {
  return t.sessionId !== null && (t.stageCurrent === 'impl' || t.stageCurrent === 'fix');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/agent/resumeDecision.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire into the openSession handler**

In `src/extension.ts`, add the import near the other `agent/` imports:

```ts
import { shouldResumeSession } from './agent/resumeDecision.js';
```

In the `karst.openSession` handler, after `const initialPrompt = buildSessionSeed(...)` and before the `sessions.openSession(...)` call, compute the resume id and a lighter seed:

```ts
      // Resume the captured session when continuing interactive work, so the
      // agent keeps its context instead of re-deriving from a cold seed (§5.3).
      const resumeId = shouldResumeSession(t) ? (t.sessionId ?? undefined) : undefined;
      const seedPrompt = resumeId
        ? `Continue the in-progress work on ticket ${t.key ?? `#${ticketId}`}. Re-read live state if needed.`
        : initialPrompt;
```

Change the launch call to use `seedPrompt` and pass `resumeId` as the new trailing arg:

```ts
      sessions.openSession(
        ticketId,
        wt.path,
        { key: t.key, title: t.title },
        seedPrompt,
        extraArgs,
        model,
        resumeId,
      );
```

- [ ] **Step 6: Typecheck + commit**

Run: `npm run typecheck`
Expected: no errors.

```bash
git add src/agent/resumeDecision.ts src/agent/resumeDecision.test.ts src/extension.ts
git commit -m "feat(session): resume interactive session on impl/fix reopen"
```

---

## Phase 3 — StageDriver

### Task 6: `runStageDriver` pass-forward loop

**Files:**
- Create: `src/workflow/driver.ts`
- Test: `src/workflow/driver.test.ts`

**Interfaces:**
- Consumes: `getTicket` (`stageCurrent`), `transition` (only inside test fakes / real runners — NOT the driver).
- Produces:
  - `type DriverStatus = 'running' | 'stopped' | 'blocked'`
  - `interface StageOutcome { stage: StageKey; status: DriverStatus; reason?: string }`
  - `interface StageDriverDeps { store: Store; runUat: (ticketId: number, cwd: string) => Promise<StageKey>; runReview: (ticketId: number, cwd: string) => Promise<StageKey>; worktreeFor: (ticketId: number) => string | null; onProgress: (ticketId: number, stage: StageKey, status: DriverStatus) => void; shouldContinue: () => boolean }`
  - `runStageDriver(deps: StageDriverDeps, ticketId: number): Promise<StageOutcome>`

- [ ] **Step 1: Write the failing test**

Create `src/workflow/driver.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { openStore, type Store } from '../store/db.js';
import { createTicket } from '../store/tickets.js';
import { transition } from './machine.js';
import { runStageDriver, type StageDriverDeps } from './driver.js';

function seedAtUat(store: Store): number {
  const t = createTicket(store, { key: 'K-1', title: 'demo' });
  transition(store, t.id, 'scope', { kind: 'passed' }); // -> impl
  transition(store, t.id, 'impl', { kind: 'passed' });  // -> uat (marker)
  return t.id;
}

function baseDeps(store: Store, over: Partial<StageDriverDeps> = {}): StageDriverDeps {
  return {
    store,
    worktreeFor: () => '/wt',
    onProgress: () => {},
    shouldContinue: () => true,
    runUat: async (id) => transition(store, id, 'uat', { kind: 'passed' }),      // -> review
    runReview: async (id) => transition(store, id, 'review', { kind: 'passed' }), // -> ship
    ...over,
  };
}

describe('runStageDriver', () => {
  it('auto-chains uat->review then stops at ship for confirm', async () => {
    const store = openStore(':memory:');
    const id = seedAtUat(store);
    const out = await runStageDriver(baseDeps(store), id);
    expect(out).toEqual({ stage: 'ship', status: 'blocked', reason: 'ship-confirm' });
    store.close();
  });

  it('stops at fix when a gate fails', async () => {
    const store = openStore(':memory:');
    const id = seedAtUat(store);
    const deps = baseDeps(store, {
      runUat: async (i) => transition(store, i, 'uat', { kind: 'failed', reason: 'exit 1' }), // -> fix
    });
    const out = await runStageDriver(deps, id);
    expect(out).toEqual({ stage: 'fix', status: 'blocked', reason: 'gate-failed' });
    store.close();
  });

  it('halts at the boundary when shouldContinue is false', async () => {
    const store = openStore(':memory:');
    const id = seedAtUat(store);
    const out = await runStageDriver(baseDeps(store, { shouldContinue: () => false }), id);
    expect(out.status).toBe('stopped');
    expect(out.stage).toBe('uat');
    store.close();
  });

  it('throws when the worktree is missing', async () => {
    const store = openStore(':memory:');
    const id = seedAtUat(store);
    await expect(runStageDriver(baseDeps(store, { worktreeFor: () => null }), id)).rejects.toThrow(/worktree/);
    store.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/workflow/driver.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

Create `src/workflow/driver.ts`:

```ts
import type { Store } from '../store/db.js';
import type { StageKey } from '../model/types.js';
import { getTicket } from '../store/tickets.js';

/**
 * The stage driver (§11/§12): after the explicit impl/fix marker leaves a ticket
 * at a deterministic gate, walk it FORWARD by running each gate's runner and
 * re-reading `stage_current` — until a human boundary (fix/ship/done), a Stop, or
 * an error. It NEVER authors a transition itself; the runners own that. This is a
 * pure sequencer over the runner results.
 */

export type DriverStatus = 'running' | 'stopped' | 'blocked';

export interface StageOutcome {
  stage: StageKey;
  status: DriverStatus;
  reason?: string;
}

export interface StageDriverDeps {
  store: Store;
  runUat: (ticketId: number, cwd: string) => Promise<StageKey>;
  runReview: (ticketId: number, cwd: string) => Promise<StageKey>;
  worktreeFor: (ticketId: number) => string | null;
  onProgress: (ticketId: number, stage: StageKey, status: DriverStatus) => void;
  shouldContinue: () => boolean;
}

function finish(
  deps: StageDriverDeps,
  ticketId: number,
  stage: StageKey,
  status: DriverStatus,
  reason?: string,
): StageOutcome {
  deps.onProgress(ticketId, stage, status);
  return reason ? { stage, status, reason } : { stage, status };
}

export async function runStageDriver(deps: StageDriverDeps, ticketId: number): Promise<StageOutcome> {
  for (;;) {
    const stage = getTicket(deps.store, ticketId).stageCurrent;

    // Human boundaries — stop without running.
    if (stage === 'ship') return finish(deps, ticketId, stage, 'blocked', 'ship-confirm');
    if (stage === 'fix') return finish(deps, ticketId, stage, 'blocked', 'gate-failed');
    if (stage === 'impl') return finish(deps, ticketId, stage, 'blocked', 'awaiting-marker');
    if (stage === 'scope') return finish(deps, ticketId, stage, 'blocked', 'not-spun');
    if (stage === 'done') return finish(deps, ticketId, stage, 'stopped');

    // Stop requested — halt at this gate boundary before running it.
    if (!deps.shouldContinue()) return finish(deps, ticketId, stage, 'stopped');

    const cwd = deps.worktreeFor(ticketId);
    if (!cwd) throw new Error(`ticket ${ticketId} has no worktree for stage '${stage}'`);

    deps.onProgress(ticketId, stage, 'running');
    if (stage === 'uat') await deps.runUat(ticketId, cwd);
    else await deps.runReview(ticketId, cwd);
    // Loop: the runner already transitioned; re-read stage_current and continue.
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/workflow/driver.test.ts`
Expected: PASS (all 4).

- [ ] **Step 5: Commit**

```bash
git add src/workflow/driver.ts src/workflow/driver.test.ts
git commit -m "feat(workflow): StageDriver auto-runs uat->review, stops at boundaries"
```

---

## Phase 4 — Trigger wiring + Ship confirm

### Task 7: driver controller (re-entrancy + Stop flags, pure)

**Files:**
- Create: `src/workflow/driverController.ts`
- Test: `src/workflow/driverController.test.ts`

**Interfaces:**
- Produces:
  - `shouldStartDriver(stage: StageKey, hasLiveSession: boolean): boolean` — true only for `uat`/`review` with no live session.
  - `class DriverController` with: `isRunning(ticketId: number): boolean`, `begin(ticketId): boolean` (returns false if already running), `end(ticketId): void`, `requestStop(ticketId): void`, `shouldContinue(ticketId): boolean`.

- [ ] **Step 1: Write the failing test**

Create `src/workflow/driverController.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { shouldStartDriver, DriverController } from './driverController.js';

describe('shouldStartDriver', () => {
  it('starts on gate stages with no live session', () => {
    expect(shouldStartDriver('uat', false)).toBe(true);
    expect(shouldStartDriver('review', false)).toBe(true);
  });
  it('does not start with a live session or on non-gate stages', () => {
    expect(shouldStartDriver('uat', true)).toBe(false);
    expect(shouldStartDriver('impl', false)).toBe(false);
    expect(shouldStartDriver('ship', false)).toBe(false);
  });
});

describe('DriverController', () => {
  it('begin is single-flight per ticket', () => {
    const c = new DriverController();
    expect(c.begin(1)).toBe(true);
    expect(c.begin(1)).toBe(false); // already running
    c.end(1);
    expect(c.begin(1)).toBe(true);
  });
  it('requestStop makes shouldContinue false until the run ends', () => {
    const c = new DriverController();
    c.begin(1);
    expect(c.shouldContinue(1)).toBe(true);
    c.requestStop(1);
    expect(c.shouldContinue(1)).toBe(false);
    c.end(1);
    c.begin(1);
    expect(c.shouldContinue(1)).toBe(true); // stop flag cleared on new run
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/workflow/driverController.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

Create `src/workflow/driverController.ts`:

```ts
import type { StageKey } from '../model/types.js';

/** Deterministic gate stages the driver may auto-run. */
const AUTO_GATES: readonly StageKey[] = ['uat', 'review'] as const;

/**
 * Start the driver only for a deterministic gate stage with no live interactive
 * session (a live session means the human is mid-work; don't run gates under it).
 */
export function shouldStartDriver(stage: StageKey, hasLiveSession: boolean): boolean {
  return !hasLiveSession && AUTO_GATES.includes(stage);
}

/**
 * Per-ticket run bookkeeping for the host seam: single-flight guard (no two
 * drivers on one ticket) and a Stop flag the driver reads via `shouldContinue`.
 * Pure of vscode so it is unit-testable.
 */
export class DriverController {
  private readonly running = new Set<number>();
  private readonly stopping = new Set<number>();

  isRunning(ticketId: number): boolean {
    return this.running.has(ticketId);
  }

  /** Claim the ticket for a run; false if one is already in flight. */
  begin(ticketId: number): boolean {
    if (this.running.has(ticketId)) return false;
    this.running.add(ticketId);
    this.stopping.delete(ticketId); // fresh run clears any stale stop flag
    return true;
  }

  end(ticketId: number): void {
    this.running.delete(ticketId);
    this.stopping.delete(ticketId);
  }

  requestStop(ticketId: number): void {
    this.stopping.add(ticketId);
  }

  shouldContinue(ticketId: number): boolean {
    return !this.stopping.has(ticketId);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/workflow/driverController.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/workflow/driverController.ts src/workflow/driverController.test.ts
git commit -m "feat(workflow): driver controller — single-flight + Stop flag"
```

---

### Task 8: dashboard messages for Stop / Ship / Resume

**Files:**
- Modify: `src/ui/dashboard/messages.ts`
- Test: `src/ui/dashboard/messages.test.ts`

**Interfaces:**
- Produces: three new `WebviewMessage` variants + `DashboardActions` methods:
  - `{ type: 'stop-driver' }` → `stopDriver(): void`
  - `{ type: 'ship-ticket' }` → `shipTicket(): void`
  - `{ type: 'resume-ticket' }` → `resumeTicket(): void`

- [ ] **Step 1: Write the failing test**

Add to `src/ui/dashboard/messages.test.ts`:

```ts
it('parses the driver/ship/resume actions', () => {
  expect(parseWebviewMessage({ type: 'stop-driver' })).toEqual({ type: 'stop-driver' });
  expect(parseWebviewMessage({ type: 'ship-ticket' })).toEqual({ type: 'ship-ticket' });
  expect(parseWebviewMessage({ type: 'resume-ticket' })).toEqual({ type: 'resume-ticket' });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/ui/dashboard/messages.test.ts -t "driver/ship/resume"`
Expected: FAIL — returns `null` (unknown types).

- [ ] **Step 3: Write minimal implementation**

In `src/ui/dashboard/messages.ts`, add to the `WebviewMessage` union:

```ts
  | { type: 'stop-driver' }
  | { type: 'ship-ticket' }
  | { type: 'resume-ticket' }
```

Add to `DashboardActions`:

```ts
  stopDriver: () => void;
  shipTicket: () => void;
  resumeTicket: () => void;
```

In `parseWebviewMessage`, add cases alongside the other no-field actions (e.g. next to `spin-servers`):

```ts
    case 'stop-driver':
      return { type: 'stop-driver' };
    case 'ship-ticket':
      return { type: 'ship-ticket' };
    case 'resume-ticket':
      return { type: 'resume-ticket' };
```

If the file has a `routeAction` switch mapping messages → `DashboardActions`, add the three passthrough cases there too (`case 'stop-driver': actions.stopDriver(); return;` etc.).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/ui/dashboard/messages.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ui/dashboard/messages.ts src/ui/dashboard/messages.test.ts
git commit -m "feat(dashboard): stop-driver/ship-ticket/resume-ticket actions"
```

---

### Task 9: extension host wiring (trigger, Ship confirm, Stop)

**Files:**
- Modify: `src/extension.ts`

No unit test — this is the `vscode` binding seam (not loadable under vitest). It composes already-tested units: `runStageDriver`, `DriverController`, `shouldStartDriver`, `runUat`/`runReview`, `shipTicket`. Verify manually at the end.

- [ ] **Step 1: Imports + a module-level controller**

Add imports:

```ts
import { runStageDriver } from './workflow/driver.js';
import { DriverController, shouldStartDriver } from './workflow/driverController.js';
import { runUat } from './workflow/stages/uat.js';
import { runReview } from './workflow/stages/review.js';
import { shipTicket as runShipTicket } from './workflow/stages/ship.js';
```

Near the other module-level state (`let store`, `let endpoint`):

```ts
const driver = new DriverController();
```

- [ ] **Step 2: A helper that runs the driver for a ticket**

Add inside `activate` (so it closes over `localStore`, `agentAdapter`, `sessions`, the artifact dir, and `provider.refresh`). Place it near the other command handlers:

```ts
    const artifactDirFor = (ticketId: number): string =>
      join(context.globalStorageUri.fsPath, 'artifacts', String(ticketId));

    async function driveTicket(ticketId: number): Promise<void> {
      if (!driver.begin(ticketId)) return; // single-flight
      try {
        await runStageDriver(
          {
            store: localStore,
            worktreeFor: (id) => listWorktreesByTicket(localStore, id)[0]?.path ?? null,
            onProgress: (id) => provider.refresh(),
            shouldContinue: () => driver.shouldContinue(ticketId),
            runUat: (id, cwd) =>
              runUat(localStore, { ticketId: id, cwd, artifactDir: artifactDirFor(id) }).then(
                (o) => getTicket(localStore, id).stageCurrent,
              ),
            runReview: (id, cwd) =>
              runReview(localStore, { ticketId: id, cwd, artifactDir: artifactDirFor(id) }).then(
                () => getTicket(localStore, id).stageCurrent,
              ),
          },
          ticketId,
        );
      } catch (e) {
        logError('stage driver failed', e);
      } finally {
        driver.end(ticketId);
        provider.refresh();
      }
    }
```

- [ ] **Step 3: Trigger the driver from the hook notify callback**

At the `startHookEndpoint` wiring (~line 502), the notify callback currently refreshes views. Extend it so that after a hook mutation, an eligible ticket auto-advances:

```ts
    endpoint = await startHookEndpoint(localStore, 0, (ticketId) => {
      provider.refresh();
      // Auto-advance: the marker already transitioned the stage; a Stop/SessionEnd
      // that leaves the ticket at a gate with no live session kicks the driver.
      const t = getTicket(localStore, ticketId);
      const hasLiveSession = sessions.hasSession(ticketId);
      if (shouldStartDriver(t.stageCurrent, hasLiveSession)) void driveTicket(ticketId);
    });
```

If `SessionManager` has no `hasSession`, add a one-line method to `src/ui/session.ts`:

```ts
  hasSession(ticketId: number): boolean {
    return this.terminals.has(ticketId);
  }
```

(and a trivial test in `session.test.ts`: open a session, assert `hasSession(id)` is true; a different id is false.)

- [ ] **Step 4: Dashboard action handlers (Stop / Ship / Resume)**

Where the `DashboardActions` object is constructed for the dashboard manager, add the three methods:

```ts
      stopDriver: () => driver.requestStop(ticketId),
      shipTicket: () => {
        void runShipTicket(localStore, { ticketId }, undefined, agentAdapter)
          .then(() => provider.refresh())
          .catch((e) => logError('ship failed', e));
      },
      resumeTicket: () => void vscode.commands.executeCommand('karst.openSession', ticketId),
```

(Use the `ticketId` in scope for that dashboard instance. `runShipTicket`'s third arg is the `GhRunner` — pass `undefined` to use `defaultGhRunner`.)

- [ ] **Step 5: Boot — surface Resume, do not auto-fire**

No code needed beyond the existing `reconcileOnStart` + `provider.refresh()`: a ticket left at `uat`/`review` shows the **Resume** action (Task 8), which calls `resume-ticket` → `karst.openSession`, or the user re-triggers via a later hook. The driver only auto-fires on the live hook path (Step 3), matching the spec's "boot re-offers, doesn't auto-run."

- [ ] **Step 6: Typecheck + build + manual verify**

```bash
npm run typecheck
npm run build
```
Expected: both clean.

Manual smoke (in the Extension Dev Host / installed IDE):
1. Take a ticket to `impl`, run the impl marker → stage becomes `uat`.
2. End the session → hook fires → driver runs `npm test` in the worktree → on green, advances to `review`, runs lint+typecheck+test → on green, stops at `ship`.
3. Dashboard shows **Ship (open PRs)**; clicking it opens the PR(s) and advances to `done`.
4. Reopen a ticket at `impl` with a captured session → **Resume session** relaunches with `--resume` (not from scratch).

- [ ] **Step 7: Commit**

```bash
git add src/extension.ts src/ui/session.ts src/ui/session.test.ts
git commit -m "feat(extension): wire StageDriver — hook trigger, Ship confirm, Stop, resume"
```

---

## Self-Review Notes

- **Spec coverage:** session persistence (T1–2), interactive `--resume` (T3–5), StageDriver auto-run uat→review + boundaries + Stop (T6–7), trigger + Ship confirm + Stop + boot-resume (T8–9). Deferred items (auto-headless-fix, mid-run kill, review findings) intentionally absent.
- **Single-writer:** the driver never calls `transition`; it calls `runUat`/`runReview`, which do. Confirmed in T6/T9.
- **Type consistency:** `StageDriverDeps` fields in T6 match the T9 call site; `DriverController` method names (`begin`/`end`/`requestStop`/`shouldContinue`) match T7 tests and T9 usage; `resume?` param order in `openSession` (T4) matches the T5 call site.
- **Boundary reasons** (`ship-confirm`, `gate-failed`, `awaiting-marker`, `not-spun`) are surfaced via `onProgress`/outcome only — no consumer depends on the exact strings except the T6 tests.
