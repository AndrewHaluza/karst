# Fix Notes Delivery Polls and Dedupe Repeating Debug Lines Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate unneeded polling of archived and done tickets during bulletin delivery sweeps, and dedupe repetitive debug lines from message delivery deferrals, artifacts watch ENOENT errors, and dashboard 1-second live ticks.

**Architecture:** Filter `unreadNotesByTicket` in SQL (`archived_at IS NULL AND stage_current <> 'done'`) to prevent useless candidate reads; dedupe `deferred` and `rate-limited` delivery logs per `(ticket, kind, unread)` tuple in `messageDeliveryOps`; track failed prefix watches per-entry in `artifacts/watcher.ts` to log ENOENT once and announce `watching <dir>` upon arming; dedupe 1s dashboard `push live` logs in `liveTick.ts`/`panel.ts` based on section set, reason changes, or a 1-minute heartbeat.

**Tech Stack:** TypeScript (ESM, `.js` import suffixes), Vitest, SQLite (`better-sqlite3`).

**Spec:** Ticket FIX-NOTES-DELIVERY-POLLS context brief (D218); Design constraints `@arch:DBG-01`, `@arch:DBG-02`, `@arch:DBG-03`, `@arch:CLI-12`, commits `c5bf556aba`, `0506866fe7`.

## Global Constraints

- Never raise log levels or delete decision branch debug lines (`@arch:DBG-03`). Dedupe keeps the first occurrence.
- Host-agnostic modules (`bulletinNotes`, `messageDeliveryOps`, `watcher`, `liveTick`) receive `debug` via injected callbacks, never importing the global logger (`@arch:DBG-01`).
- Artifact watcher's 10-second reconcile retry must continue retrying missing prefix directories silently so newly created directories are watched as soon as they appear. ENOENT stays non-fatal.
- Do not delete `worktrees` rows of archived tickets in the database (other subsystems read them; out of scope).
- Dashboard live tick cadence must remain unchanged at `LIVE_TICK_MS = 1000`.

---

### Task 1: Filter Archived and Done Tickets in `unreadNotesByTicket`

**Files:**
- Modify: `src/store/bulletinNotes.ts:572-578`
- Test: `src/store/bulletinNotes.test.ts`

**Interfaces:**
- Consumes: `Store`, `tickets` table (`archived_at`, `stage_current`), `worktrees` table.
- Produces: `unreadNotesByTicket(store: Store, projectId: number): TicketNoteUnread[]` (signature unchanged, but queries only active, non-done tickets).

- [ ] **Step 1: Write the failing test**

In `src/store/bulletinNotes.test.ts`, add a test to the `describe('unreadNotesByTicket (push relevance + session-start cutoff)', ...)` block asserting that archived tickets and done tickets with worktrees and unread notes are omitted:

```ts
  it('omits tickets that are archived or in done stage even when they have worktrees', () => {
    const poster = other();
    const note = postAgentNote(store, { projectId, fromTicketId: poster, title: 'agent note', body: 'b' });
    setCreated(note.id, AFTER);

    // Verify reader normally receives the note
    expect(row(reader)?.unread).toBe(1);

    // When ticket is archived, it must not be included
    store.db.prepare("UPDATE tickets SET archived_at = datetime('now') WHERE id = ?").run(reader);
    expect(row(reader)).toBeUndefined();

    // When unarchived, it is included again
    store.db.prepare('UPDATE tickets SET archived_at = NULL WHERE id = ?').run(reader);
    expect(row(reader)?.unread).toBe(1);

    // When stage_current is 'done', it must not be included
    store.db.prepare("UPDATE tickets SET stage_current = 'done' WHERE id = ?").run(reader);
    expect(row(reader)).toBeUndefined();
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:unit -- src/store/bulletinNotes.test.ts`
Expected: FAIL because archived and done tickets are currently included by `SELECT DISTINCT t.id AS id FROM tickets t JOIN worktrees w ON w.ticket_id = t.id WHERE t.project_id = ? ORDER BY t.id`.

- [ ] **Step 3: Write minimal implementation**

In `src/store/bulletinNotes.ts`, update `unreadNotesByTicket`:

```ts
export function unreadNotesByTicket(store: Store, projectId: number): TicketNoteUnread[] {
  const tickets = store.db
    .prepare(
      `SELECT DISTINCT t.id AS id FROM tickets t JOIN worktrees w ON w.ticket_id = t.id
        WHERE t.project_id = ? AND t.archived_at IS NULL AND t.stage_current <> 'done' ORDER BY t.id`,
    )
    .all(projectId) as Array<{ id: number }>;
  const out: TicketNoteUnread[] = [];
  for (const { id } of tickets) {
    const scope = ticketNoteScope(store, id);
    const candidates = readCandidates(store, id, projectId, sessionStartCutoff(store, id)).filter(
      ({ note }) => note.repos.some((repo) => scope.repos.includes(repo)),
    );
    const notes = pushableNotes(candidates, scope);
    if (notes.length > 0) {
      out.push({ toTicketId: id, unread: notes.length, maxId: Math.max(...notes.map((n) => n.id)) });
    }
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:unit -- src/store/bulletinNotes.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/store/bulletinNotes.ts src/store/bulletinNotes.test.ts
git commit -m "fix: exclude archived and done tickets from unreadNotesByTicket"
```

---

### Task 2: Dedupe Repeating `deferred` and `rate-limited` Logs in `messageDeliveryOps`

**Files:**
- Modify: `src/extension/ops/messageDeliveryOps.ts:156-234`
- Test: `src/extension/ops/messageDeliveryOps.test.ts`

**Interfaces:**
- Consumes: `MailboxKind = 'mail' | 'notes'`, `PointerRow = { toTicketId: number; unread: number; maxId: number }`.
- Produces: `makeMessageDeliverySweep(deps: MessageDeliveryDeps): MessageDeliverySweep` (internal dedupe state for `deferred` and `rate-limited`).

- [ ] **Step 1: Write the failing tests**

In `src/extension/ops/messageDeliveryOps.test.ts`, add the following tests inside `describe('message delivery sweep — pointers', ...)`:

```ts
  it('dedupes repeated deferred delivery logs for unchanged (ticket, kind, unread) tuple', () => {
    const d = deps({ delivery: { deliver: vi.fn(() => 'deferred' as const) } });
    const sweep = makeMessageDeliverySweep(d);
    send(parentId);
    sweep.sweep();
    const deferredLines = () => (d.debug as ReturnType<typeof vi.fn>).mock.calls
      .map((c) => c[0] as string)
      .filter((m) => m.includes('deferred (1 unread)'));

    expect(deferredLines()).toHaveLength(1);

    // Second sweep with identical unread count does not log again
    sweep.sweep();
    expect(deferredLines()).toHaveLength(1);

    // When unread count changes, it logs again
    send(parentId);
    sweep.sweep();
    const deferredLines2 = (d.debug as ReturnType<typeof vi.fn>).mock.calls
      .map((c) => c[0] as string)
      .filter((m) => m.includes('deferred (2 unread)'));
    expect(deferredLines2).toHaveLength(1);
  });

  it('dedupes repeated rate-limited delivery logs for unchanged unread count', () => {
    const d = deps();
    const sweep = makeMessageDeliverySweep(d);
    send(parentId);
    sweep.sweep(); // delivered, lastPointerAt set

    // New message arrives before POINTER_INTERVAL_MS passes
    send(parentId);
    clock += 100;
    sweep.sweep();
    const rateLimitedLines = () => (d.debug as ReturnType<typeof vi.fn>).mock.calls
      .map((c) => c[0] as string)
      .filter((m) => m.includes('rate-limited — coalescing'));

    expect(rateLimitedLines()).toHaveLength(1);

    // Another sweep while still rate-limited with same count does not log again
    clock += 100;
    sweep.sweep();
    expect(rateLimitedLines()).toHaveLength(1);

    // When count increases while still rate-limited, it logs again
    send(parentId);
    clock += 100;
    sweep.sweep();
    expect(rateLimitedLines()).toHaveLength(2);
  });

  it('prune forgets deferred and rate-limited dedupe entries when ticket is no longer present', () => {
    let deliverOutcome: 'deferred' | 'delivered' = 'deferred';
    const d = deps({ delivery: { deliver: vi.fn(() => deliverOutcome) } });
    const sweep = makeMessageDeliverySweep(d);
    const msgId = send(parentId);
    sweep.sweep(); // logs deferred (1 unread)

    // Mark message read so parentId is no longer in unreadByRecipient
    markRead(store, parentId, [msgId]);
    sweep.sweep(); // prune drops parentId from lastDeferred

    // New message arrives; deferred should log again
    send(parentId);
    sweep.sweep();
    const deferredLines = (d.debug as ReturnType<typeof vi.fn>).mock.calls
      .map((c) => c[0] as string)
      .filter((m) => m.includes('deferred (1 unread)'));
    expect(deferredLines).toHaveLength(2);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:unit -- src/extension/ops/messageDeliveryOps.test.ts`
Expected: FAIL because consecutive sweeps currently log `deferred` on every tick.

- [ ] **Step 3: Write minimal implementation**

In `src/extension/ops/messageDeliveryOps.ts`:
1. Add `lastDeferred` and `lastRateLimited` state maps to `makeMessageDeliverySweep`:
```ts
  const lastDeferred: Record<MailboxKind, Map<number, number>> = {
    mail: new Map(),
    notes: new Map(),
  };
  const lastRateLimited: Record<MailboxKind, Map<number, number>> = {
    mail: new Map(),
    notes: new Map(),
  };
```

2. Update `prune` to clear these entries:
```ts
  function prune(kind: MailboxKind, present: ReadonlySet<number>): void {
    for (const id of [...watermark[kind].keys()]) if (!present.has(id)) watermark[kind].delete(id);
    for (const id of [...lastPointerAt[kind].keys()]) if (!present.has(id)) lastPointerAt[kind].delete(id);
    for (const id of [...lastDeferred[kind].keys()]) if (!present.has(id)) lastDeferred[kind].delete(id);
    for (const id of [...lastRateLimited[kind].keys()]) if (!present.has(id)) lastRateLimited[kind].delete(id);
  }
```

3. Update `deliverRows` to dedupe `rate-limited` and `deferred`, and clear dedupe entries on delivery:
```ts
  function deliverRows(kind: MailboxKind, rows: readonly PointerRow[], out: number[]): void {
    const tag = kind === 'notes' ? 'notes ' : '';
    for (const r of rows) {
      if (disposed) return;
      const seen = watermark[kind].get(r.toTicketId);
      if (seen !== undefined && r.maxId <= seen) continue;
      // The turn-end reply may have pushed THIS batch already (the arm does not
      // set a watermark, because a hook that never arrives must still fall back
      // to typing). Skip it — and record the watermark so we do not re-check
      // every tick — instead of typing a duplicate into a mid-turn terminal.
      // The reply only ever carries mail, so notes never consult it.
      if (kind === 'mail' && deps.alreadyPushed?.(r.toTicketId, r.maxId)) {
        watermark[kind].set(r.toTicketId, r.maxId);
        lastDeferred[kind].delete(r.toTicketId);
        lastRateLimited[kind].delete(r.toTicketId);
        deps.debug(`[driver] delivery ${formatId('ticket', r.toTicketId)}: already pushed by the reply — skipping`);
        continue;
      }
      const last = lastPointerAt[kind].get(r.toTicketId);
      if (last !== undefined && deps.now() - last < POINTER_INTERVAL_MS) {
        if (lastRateLimited[kind].get(r.toTicketId) !== r.unread) {
          lastRateLimited[kind].set(r.toTicketId, r.unread);
          deps.debug(`[driver] delivery ${formatId('ticket', r.toTicketId)}: ${tag}rate-limited — coalescing`);
        }
        continue;
      }
      lastRateLimited[kind].delete(r.toTicketId);
      const pointer = kind === 'notes' ? notesPointer(r.unread) : mailPointer(r.unread);
      const outcome = deps.delivery.deliver(r.toTicketId, pointer);
      if (outcome === 'deferred') {
        if (lastDeferred[kind].get(r.toTicketId) !== r.unread) {
          lastDeferred[kind].set(r.toTicketId, r.unread);
          deps.debug(`[driver] delivery ${formatId('ticket', r.toTicketId)}: ${tag}deferred (${r.unread} unread)`);
        }
        continue;
      }
      lastDeferred[kind].delete(r.toTicketId);
      if (outcome === 'armed') {
        // A push route is armed but NOTHING is delivered yet — the turn-end
        // reply will push it. The watermark stays put, so if that hook never
        // arrives the next sweep re-evaluates and types the pointer once the
        // recipient is idle, instead of silently stranding the batch.
        deps.debug(`[driver] delivery ${formatId('ticket', r.toTicketId)}: ${tag}armed (${r.unread} unread)`);
        continue;
      }
      watermark[kind].set(r.toTicketId, r.maxId);
      lastPointerAt[kind].set(r.toTicketId, deps.now());
      deps.debug(`[driver] delivery ${formatId('ticket', r.toTicketId)}: ${tag}pointer delivered (${r.unread} unread)`);
      out.push(r.toTicketId);
    }
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:unit -- src/extension/ops/messageDeliveryOps.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/extension/ops/messageDeliveryOps.ts src/extension/ops/messageDeliveryOps.test.ts
git commit -m "fix: dedupe repeating deferred and rate-limited message delivery logs"
```

---

### Task 3: Dedupe Artifacts Watch ENOENT Errors and Announce When Armed

**Files:**
- Modify: `src/artifacts/watcher.ts:50-57,114-157`
- Test: `src/artifacts/watcher.test.ts`

**Interfaces:**
- Consumes: `CaptureTarget`, `TaggedOutput`, `FsWatch`.
- Produces: `createWorktreeWatcher(deps: WatcherDeps): WorktreeWatcher` (dedupes ENOENT logs per prefix, logs `[artifacts] watching <dir>` when a failed prefix arms, clears on `remove`).

- [ ] **Step 1: Write the failing tests**

In `src/artifacts/watcher.test.ts`, add the following tests inside `describe('worktree watcher', ...)`:

```ts
  it('logs watch failure once over multiple syncs, and logs watching when it later arms', () => {
    const debug = vi.fn();
    const existing = new Set<string>();
    const w = createWorktreeWatcher({
      watch: (dir, cb) => {
        if (!existing.has(dir)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        void cb;
        return { close: () => {} };
      },
      capture: async () => 0,
      outputs: () => [{ approachId: 'a', glob: 'docs/**', kind: 'plan' }],
      debug,
    });

    // 1. Initial add - dir missing, throws ENOENT and logs once
    w.add(target);
    const failureLogs = () => debug.mock.calls.flat().filter((m) => m.includes('cannot watch /wt/docs'));
    expect(failureLogs()).toHaveLength(1);

    // 2. Subsequent syncs while still missing do not log failure again
    w.sync([target]);
    w.sync([target]);
    expect(failureLogs()).toHaveLength(1);

    // 3. Dir appears, next sync arms watch and logs watching line
    existing.add('/wt/docs');
    w.sync([target]);
    const watchingLogs = debug.mock.calls.flat().filter((m) => m === '[artifacts] watching /wt/docs');
    expect(watchingLogs).toHaveLength(1);
    expect(w.watched()).toEqual(['/wt/docs']);
  });

  it('remove clears the failedPrefixes set so a re-added missing prefix logs failure again', () => {
    const debug = vi.fn();
    const w = createWorktreeWatcher({
      watch: (dir) => {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      },
      capture: async () => 0,
      outputs: () => [{ approachId: 'a', glob: 'docs/**', kind: 'plan' }],
      debug,
    });

    w.add(target);
    const failureLogs = () => debug.mock.calls.flat().filter((m) => m.includes('cannot watch /wt/docs'));
    expect(failureLogs()).toHaveLength(1);

    w.remove(target.worktreePath);
    w.add(target);
    expect(failureLogs()).toHaveLength(2);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:unit -- src/artifacts/watcher.test.ts`
Expected: FAIL because `cannot watch ...` is logged on every `sync()` call.

- [ ] **Step 3: Write minimal implementation**

In `src/artifacts/watcher.ts`:
1. In `interface Entry`, add `failedPrefixes: Set<string>;`:
```ts
interface Entry {
  target: CaptureTarget;
  /** Repo-relative prefix dir -> live handle. */
  handles: Map<string, FsWatchHandle>;
  pending: Set<string>;
  timer: unknown;
  failedPrefixes: Set<string>;
}
```

2. In `createWorktreeWatcher`:
In `teardown(entry: Entry)`:
```ts
  const teardown = (entry: Entry): void => {
    if (entry.timer !== undefined) clearTimer(entry.timer);
    for (const handle of entry.handles.values()) handle.close();
    entry.handles.clear();
    entry.failedPrefixes.clear();
  };
```

In `reconcile(entry: Entry)`:
```ts
    for (const prefix of dirs) {
      if (entry.handles.has(prefix)) continue;
      const dir = join(entry.target.worktreePath, prefix);
      try {
        const handle = deps.watch(dir, (p) => onChange(entry, `${prefix}/${p}`));
        entry.handles.set(prefix, handle);
        if (entry.failedPrefixes.delete(prefix)) {
          deps.debug(`[artifacts] watching ${dir}`);
        }
      } catch (err) {
        if (!entry.failedPrefixes.has(prefix)) {
          entry.failedPrefixes.add(prefix);
          deps.debug(`[artifacts] cannot watch ${dir}: ${String(err)}`);
        }
      }
    }
```

In `add(target: CaptureTarget)`:
```ts
    add(target) {
      const existing = entries.get(target.worktreePath);
      const entry = existing ?? {
        target,
        handles: new Map(),
        pending: new Set(),
        timer: undefined,
        failedPrefixes: new Set(),
      };
      if (existing === undefined) {
        deps.debug(`[artifacts] watching ${target.worktreePath}`);
        entries.set(target.worktreePath, entry);
      } else {
        existing.target = target;
      }
      reconcile(entry);
    },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:unit -- src/artifacts/watcher.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/artifacts/watcher.ts src/artifacts/watcher.test.ts
git commit -m "fix: dedupe artifacts watcher ENOENT errors and announce when armed"
```

---

### Task 4: Dedupe Repeating 1-Second Dashboard `push live` Debug Lines

**Files:**
- Modify: `src/ui/dashboard/liveTick.ts:88-110`
- Modify: `src/ui/dashboard/panel.ts:80-90,340-350,750-765`
- Test: `src/ui/dashboard/liveTick.test.ts`
- Test: `src/ui/dashboard/panel.test.ts`

**Interfaces:**
- Produces in `src/ui/dashboard/liveTick.ts`:
  - `LIVE_HEARTBEAT_MS = 60_000`
  - `liveSections(state: DashboardState): string[]`
  - `interface LiveLogState { lastAt: number; lastReason: string; lastSections: string; }`
  - `shouldLogLiveTick(prev: LiveLogState | undefined, now: number, reason: string, sections: readonly string[], heartbeatMs?: number): { shouldLog: boolean; next: LiveLogState }`
- Consumes in `src/ui/dashboard/panel.ts`:
  - `shouldLogLiveTick`, `liveSections`, `LiveLogState` used in `tracePush` when `kind === 'live'`.

- [ ] **Step 1: Write the failing unit tests for `liveTick.ts` and integration tests for `panel.ts`**

In `src/ui/dashboard/liveTick.test.ts`, add:

```ts
import { changedPaths, hasLiveWork, liveClocks, LIVE_TICK_MS, structureKey, liveSections, shouldLogLiveTick, LIVE_HEARTBEAT_MS } from './liveTick.js';

describe('liveSections', () => {
  it('extracts stages with running live lines or running processes', () => {
    const state = stateWith({
      uat: view({
        stageKey: 'uat',
        live: { status: 'run', label: 'testing' },
        processes: [{ id: 'tester', kind: 'tester', label: 'Tester', status: 'run' }],
      }),
      impl: view({
        stageKey: 'impl',
        processes: [{ id: 'session', kind: 'session', label: 'Session', status: 'pass' }],
      }),
    });
    expect(liveSections(state)).toEqual(['uat:[tester]']);
  });

  it('is empty when nothing is running', () => {
    expect(liveSections(stateWith({}))).toEqual([]);
  });
});

describe('shouldLogLiveTick', () => {
  it('always logs on the first tick (prev undefined)', () => {
    const res = shouldLogLiveTick(undefined, 1000, 'clocks', ['uat:[tester]']);
    expect(res.shouldLog).toBe(true);
    expect(res.next).toEqual({ lastAt: 1000, lastReason: 'clocks', lastSections: 'uat:[tester]' });
  });

  it('suppresses logs when reason and sections are identical within the heartbeat window', () => {
    const first = shouldLogLiveTick(undefined, 1000, 'clocks', ['uat:[tester]']).next;
    const second = shouldLogLiveTick(first, 2000, 'clocks', ['uat:[tester]']);
    expect(second.shouldLog).toBe(false);
    expect(second.next).toBe(first);
  });

  it('logs when reason changes (e.g. clocks to state)', () => {
    const first = shouldLogLiveTick(undefined, 1000, 'clocks', ['uat:[tester]']).next;
    const second = shouldLogLiveTick(first, 2000, 'state; changed: insideViews', ['uat:[tester]']);
    expect(second.shouldLog).toBe(true);
    expect(second.next.lastReason).toBe('state; changed: insideViews');
  });

  it('logs when active sections change', () => {
    const first = shouldLogLiveTick(undefined, 1000, 'clocks', ['uat:[tester]']).next;
    const second = shouldLogLiveTick(first, 2000, 'clocks', ['uat:[tester]', 'review:[eval]']);
    expect(second.shouldLog).toBe(true);
    expect(second.next.lastSections).toBe('uat:[tester];review:[eval]');
  });

  it('logs heartbeat once heartbeat window elapses', () => {
    const first = shouldLogLiveTick(undefined, 1000, 'clocks', ['uat:[tester]']).next;
    const second = shouldLogLiveTick(first, 1000 + LIVE_HEARTBEAT_MS, 'clocks', ['uat:[tester]']);
    expect(second.shouldLog).toBe(true);
    expect(second.next.lastAt).toBe(1000 + LIVE_HEARTBEAT_MS);
  });
});
```

In `src/ui/dashboard/panel.test.ts`, inside `describe('live snapshot ticks', ...)`, add:

```ts
    it('dedupes repeating push live debug lines and emits a heartbeat after 1 minute', () => {
      const t = createTicket(store, { key: 'A', title: 'a' });
      setStage(store, t.id, 'uat', { status: 'running', startedAt: new Date().toISOString() });
      openProcessRun(store, {
        ticketId: t.id,
        stageKey: 'uat',
        processId: 'tester',
        attempt: 1,
        startedAt: new Date().toISOString(),
      });
      const { host } = fakeHost();
      const debug = vi.fn();
      const mgr = new DashboardManager(
        store, host, () => ({}) as never,
        undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
        undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
        undefined, undefined, undefined, undefined, undefined, undefined, undefined,
        { debug, isDebugEnabled: () => true },
      );

      mgr.openDashboard(t.id);
      const liveLines = () => debug.mock.calls
        .map((c) => c[0] as string)
        .filter((m) => m.includes('push live'));

      // Advance 3 seconds (3 ticks); should log exactly once
      vi.advanceTimersByTime(LIVE_TICK_MS * 3);
      expect(liveLines()).toHaveLength(1);

      // Advance to 60 seconds total; heartbeat logs second line
      vi.advanceTimersByTime(LIVE_TICK_MS * 57);
      expect(liveLines()).toHaveLength(2);
    });
```

- [ ] **Step 2: Run tests to verify failure**

Run: `npm run test:unit -- src/ui/dashboard/liveTick.test.ts src/ui/dashboard/panel.test.ts`
Expected: FAIL because `liveSections` and `shouldLogLiveTick` are not yet exported from `liveTick.ts`, and `panel.ts` logs on every tick.

- [ ] **Step 3: Write minimal implementation**

In `src/ui/dashboard/liveTick.ts`:
Add `LIVE_HEARTBEAT_MS`, `liveSections`, `LiveLogState`, and `shouldLogLiveTick`:

```ts
export const LIVE_HEARTBEAT_MS = 60_000;

export function liveSections(state: DashboardState): string[] {
  const sections: string[] = [];
  for (const [key, view] of Object.entries(state.insideViews ?? {})) {
    const active = view.processes?.filter((p) => p.status === 'run').map((p) => p.id) ?? [];
    if (view.live?.status === 'run' || active.length > 0) {
      sections.push(`${key}${active.length > 0 ? `:[${active.sort().join(',')}]` : ''}`);
    }
  }
  return sections.sort();
}

export interface LiveLogState {
  lastAt: number;
  lastReason: string;
  lastSections: string;
}

export function shouldLogLiveTick(
  prev: LiveLogState | undefined,
  now: number,
  reason: string,
  sections: readonly string[],
  heartbeatMs = LIVE_HEARTBEAT_MS,
): { shouldLog: boolean; next: LiveLogState } {
  const sectionsKey = sections.join(';');
  if (!prev) {
    return { shouldLog: true, next: { lastAt: now, lastReason: reason, lastSections: sectionsKey } };
  }
  if (reason !== prev.lastReason || sectionsKey !== prev.lastSections) {
    return { shouldLog: true, next: { lastAt: now, lastReason: reason, lastSections: sectionsKey } };
  }
  if (now - prev.lastAt >= heartbeatMs) {
    return { shouldLog: true, next: { lastAt: now, lastReason: reason, lastSections: sectionsKey } };
  }
  return { shouldLog: false, next: prev };
}
```

In `src/ui/dashboard/panel.ts`:
1. Import `liveSections`, `shouldLogLiveTick`, and type `LiveLogState` from `./liveTick.js`:
```ts
import { changedPaths, hasLiveWork, liveClocks, LIVE_TICK_MS, structureKey, liveSections, shouldLogLiveTick, type LiveLogState } from './liveTick.js';
```

2. Add `liveLogState` to `DashboardManager`:
```ts
  private readonly liveLogState = new Map<number, LiveLogState>();
```

3. Clear `liveLogState` when panel is closed/disposed:
In `disposePanel(ticketId: number)` or where `this.sentState.delete(ticketId)` is called:
```ts
  this.sentState.delete(ticketId);
  this.sentStructure.delete(ticketId);
  this.liveLogState.delete(ticketId);
```

4. Update `tracePush`:
```ts
  private tracePush(ticketId: number, kind: PushKind, clocksOnly: boolean, state: DashboardState): void {
    if (!this.debug?.isDebugEnabled()) return;
    const prev = this.sentState.get(ticketId);
    if (!clocksOnly) this.sentState.set(ticketId, state);
    const changed = clocksOnly ? '' : `; changed: ${prev ? changedPaths(prev, state).slice(0, 8).join(', ') || 'none' : 'first'}`;
    if (kind === 'live') {
      const reason = clocksOnly ? 'clocks' : `state${changed}`;
      const sections = liveSections(state);
      const logState = this.liveLogState.get(ticketId);
      const { shouldLog, next } = shouldLogLiveTick(logState, Date.now(), reason, sections);
      if (!shouldLog) return;
      this.liveLogState.set(ticketId, next);
    }
    const caller = new Error().stack?.split('\n')[4]?.trim() ?? '?';
    this.debug.debug(`[dashboard] ticket ${ticketId} push ${kind} → ${clocksOnly ? 'clocks' : 'state'}${changed} from ${caller}`);
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:unit -- src/ui/dashboard/liveTick.test.ts src/ui/dashboard/panel.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ui/dashboard/liveTick.ts src/ui/dashboard/liveTick.test.ts src/ui/dashboard/panel.ts src/ui/dashboard/panel.test.ts
git commit -m "fix: dedupe repeating 1s dashboard push live debug lines"
```

---

### Task 5: Full Test Suite Verification and Docs Lint

**Files:**
- Test: All unit tests and doc checks.

- [ ] **Step 1: Run full unit test suite**

Run: `npm run test:unit`
Expected: All tests pass.

- [ ] **Step 2: Run type check**

Run: `npm run typecheck`
Expected: Exit code 0, no TypeScript compilation errors.

- [ ] **Step 3: Run documentation checks**

Run: `npm run docs:check`
Expected: Pass.
