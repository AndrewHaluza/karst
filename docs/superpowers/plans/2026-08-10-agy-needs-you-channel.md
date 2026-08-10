# Antigravity "Needs you" Channel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make an agy (Antigravity CLI) interactive session that stops on a permission/input ask surface "Needs you" (amber, pause icon) on the dashboard and tickets list, by adding a conversation-state watch that normalizes the CLI's real pending-approval state into karst's existing closed hook vocabulary.

**Architecture:** agy 1.1.11's `hooks.json` system LOADS but does NOT execute in the CLI conversation path (verified empirically, see Task 5 docs), so a push bridge would be a silent fake signal. The REAL, verified signal is the per-conversation SQLite DB the CLI writes (`<appdata>/conversations/<conv-id>.db`): a permission ask is a `steps` row with `status = 9`, observed live as `4|5|9` while the "Allow creation of this file?" dialog was open, becoming `4|5|3` after the user answered. The same DB's `trajectory_metadata_blob` (row `id='main'`) contains the workspace path as `file://<path>` bytes, so the watch can find the right conversation for a ticket's worktree. A vscode-free module (`src/agent/agyConversationWatch.ts`) discovers the DB, reads the pending-approval count, and diffs it per ticket into `SessionStart` / `permission.asked` / `UserPromptSubmit` events; a sweep in `extension.ts` (mirroring `runPrSync`) posts those events through the SAME `dispatchHook` seam and closures the hook endpoint uses, so session-id capture (→ `--conversation` resume), launch-intent confirmation, the generation barrier, the amber glyph, the Now line and the dashboard refresh all work unchanged. Session end → idle is already handled by the existing terminal-close sweep.

**Tech Stack:** TypeScript (ESM, `.js` suffixes), better-sqlite3 (read-only open of the foreign agy DB — Node ABI for vitest, Electron ABI in the extension host), vitest, VS Code extension host. agy CLI 1.1.11 (installed at `~/.local/bin/agy`).

## Global Constraints

- `vscode` is NOT a runtime dependency of logic modules; `src/agent/agyConversationWatch.ts` must be vscode-free and host-agnostic (injected fs/db seams for tests).
- Every event posted to `dispatchHook` MUST be from the closed hook vocabulary (`SessionStart`, `permission.asked`, `UserPromptSubmit`) — never free-text event names, never a `Notification` with an unbounded `message`.
- No fake signals: a watch event must correspond to an observed on-disk fact (a conversation DB exists, a `status = 9` step exists/resolved). Hooks that do not execute are NOT a channel (verified: agy CLI loads `hooks.json` but never runs the commands).
- `interactiveUsage` stays `false` for antigravity — there is still no usage channel (truthful absence, never a measured zero).
- The watch is a READ over foreign state; it never writes the agy DB, never spawns `agy`, never runs git. Async/sync: a sweep tick runs on the event loop — keep per-tick work small and bounded (one readdir + a handful of read-only SQLite opens + COUNT queries), and NEVER spawn synchronously.
- SQLite is source of truth; do not break `diagnostics/nonInterference.test.ts` (the watch must not be reachable from diagnostics entry points — it isn't: it lives in `src/agent/` and imports only `node:fs`/`node:path`/`node:os`/`better-sqlite3` plus `runtime/pathScope.ts`).
- Strict TDD (RED→GREEN), conventional commits, small files (<400 lines).
- The `karst` CLI (plain `node`) must NOT import this module (better-sqlite3 is Electron-ABI in the host) — it never will: only `extension.ts` and tests import it.
- Tests run under vitest with Node-ABI better-sqlite3 (`npm test` rebuilds via `pretest`).

---

### Task 1: `src/agent/agyConversationWatch.ts` — the vscode-free watch core

**Files:**
- Create: `src/agent/agyConversationWatch.ts`
- Create: `src/agent/agyConversationWatch.test.ts`

**Interfaces:**
- Consumes: `canonicalPath` from `src/runtime/pathScope.ts` (the path canonicalizer `worktree.ts` → `worktreeServers.ts` already use — never a second canonicalizer).
- Produces:
  - `resolveAgyAppDataDir(env?: NodeJS.ProcessEnv, homedir?: string): string`
  - `interface AgyConversationDb { workspaceBlob(): Buffer | null; pendingApprovalCount(): number; close(): void }`
  - `type OpenAgyDb = (dbPath: string) => AgyConversationDb`
  - `openAgyConversationDb: OpenAgyDb` (better-sqlite3 `{ readonly: true, fileMustExist: true }`)
  - `findConversationForWorktree(appDataDir: string, worktreePath: string, openDb?: OpenAgyDb, listDbs?: (dir: string) => string[]): { dbPath: string; conversationId: string } | null`
  - `interface AgyConversationSnapshot { dbPath: string; conversationId: string; pendingApproval: boolean }`
  - `interface AgyWatchState { dbPath: string | null; started: boolean; awaiting: boolean }`
  - `type AgyWatchEvent = { kind: 'SessionStart'; sessionId: string } | { kind: 'permission.asked' } | { kind: 'UserPromptSubmit' }`
  - `agyWatchTick(state: AgyWatchState, snapshot: AgyConversationSnapshot | null): AgyWatchEvent[]`
- Later tasks rely on: Task 4's sweep calls `resolveAgyAppDataDir`, `findConversationForWorktree`, `openAgyConversationDb`, `agyWatchTick` and keeps `AgyWatchState` per ticket.

- [ ] **Step 1: Write the failing test**

`src/agent/agyConversationWatch.test.ts` — builds REAL foreign-schema conversation DBs with better-sqlite3 in temp dirs (the same driver the store uses under vitest). The blob fixture need not be real protobuf — the matcher does a substring search for `file://<path>` bytes, so `Buffer.concat([Buffer.from([1]), Buffer.from('file://' + path)])` is a faithful fixture.

```ts
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import {
  agyWatchTick,
  findConversationForWorktree,
  openAgyConversationDb,
  resolveAgyAppDataDir,
  type AgyConversationSnapshot,
  type AgyWatchState,
} from './agyConversationWatch.js';

function fixtureDb(dir: string, name: string, workspacePath: string, pending: boolean): string {
  const dbPath = join(dir, 'conversations', `${name}.db`);
  const db = new Database(dbPath);
  db.exec(
    'CREATE TABLE trajectory_metadata_blob (id TEXT PRIMARY KEY, data BLOB);' +
      'CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER NOT NULL DEFAULT 0, status INTEGER NOT NULL DEFAULT 0);',
  );
  db.prepare('INSERT INTO trajectory_metadata_blob (id, data) VALUES (?, ?)').run(
    'main',
    Buffer.concat([Buffer.from([1]), Buffer.from(`file://${workspacePath}`), Buffer.from([2])]),
  );
  db.prepare('INSERT INTO steps (idx, step_type, status) VALUES (0, 14, 3)').run();
  db.prepare('INSERT INTO steps (idx, step_type, status) VALUES (1, 5, ?)').run(pending ? 9 : 3);
  db.close();
  return dbPath;
}

describe('agyConversationWatch', () => {
  let dir: string;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('resolves the app-data dir from the env override, else the home default', () => {
    expect(resolveAgyAppDataDir({ ANTIGRAVITY_EXECUTABLE_DATA_DIR: '/custom/data' }, '/home/u')).toBe(
      '/custom/data',
    );
    expect(resolveAgyAppDataDir({}, '/home/u')).toBe('/home/u/.gemini/antigravity-cli');
  });

  it('finds the conversation DB whose workspace blob names the worktree', () => {
    dir = mkdtempSync(join(tmpdir(), 'karst-agy-watch-'));
    const wt = '/Users/nd/Work/projects/karst/.karst/worktrees/869eg9fke-fix-ticket';
    const expected = fixtureDb(dir, '11111111-1111-4111-8111-111111111111', wt, false);
    fixtureDb(dir, '22222222-2222-4222-8222-222222222222', '/some/other/worktree', false);
    const found = findConversationForWorktree(dir, wt);
    expect(found).toEqual({
      dbPath: expected,
      conversationId: '11111111-1111-4111-8111-111111111111',
    });
  });

  it('returns null when no conversation names the worktree', () => {
    dir = mkdtempSync(join(tmpdir(), 'karst-agy-watch-'));
    fixtureDb(dir, '11111111-1111-4111-8111-111111111111', '/somewhere/else', false);
    expect(findConversationForWorktree(dir, '/Users/nd/other')).toBeNull();
  });

  it('picks the NEWEST db when two conversations share the worktree', () => {
    dir = mkdtempSync(join(tmpdir(), 'karst-agy-watch-'));
    const older = fixtureDb(dir, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '/wt/shared', false);
    const newer = fixtureDb(dir, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', '/wt/shared', false);
    const later = Date.now() + 10_000;
    // bump mtimes so the ordering is deterministic and not second-granularity-fragile
    const { utimesSync } = require('node:fs') as typeof import('node:fs');
    utimesSync(older, new Date(later - 60_000), new Date(later - 60_000));
    utimesSync(newer, new Date(later), new Date(later));
    const found = findConversationForWorktree(dir, '/wt/shared');
    expect(found?.conversationId).toBe('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
  });

  it('reads pendingApproval from a status=9 step', () => {
    dir = mkdtempSync(join(tmpdir(), 'karst-agy-watch-'));
    const dbPath = fixtureDb(dir, '11111111-1111-4111-8111-111111111111', '/wt', true);
    const db = openAgyConversationDb(dbPath);
    expect(db.pendingApprovalCount()).toBe(1);
    db.close();
  });

  it('emits SessionStart on first observation, then permission.asked when a step is pending', () => {
    const state: AgyWatchState = { dbPath: null, started: false, awaiting: false };
    const first: AgyConversationSnapshot = {
      dbPath: '/data/conversations/c1.db',
      conversationId: 'c1',
      pendingApproval: true,
    };
    expect(agyWatchTick(state, first)).toEqual([
      { kind: 'SessionStart', sessionId: 'c1' },
      { kind: 'permission.asked' },
    ]);
    expect(state).toEqual({ dbPath: '/data/conversations/c1.db', started: true, awaiting: true });
  });

  it('emits nothing on an unchanged pending step', () => {
    const state: AgyWatchState = {
      dbPath: '/data/conversations/c1.db',
      started: true,
      awaiting: true,
    };
    const same: AgyConversationSnapshot = {
      dbPath: '/data/conversations/c1.db',
      conversationId: 'c1',
      pendingApproval: true,
    };
    expect(agyWatchTick(state, same)).toEqual([]);
  });

  it('emits UserPromptSubmit when the pending step resolves', () => {
    const state: AgyWatchState = {
      dbPath: '/data/conversations/c1.db',
      started: true,
      awaiting: true,
    };
    const resolved: AgyConversationSnapshot = {
      dbPath: '/data/conversations/c1.db',
      conversationId: 'c1',
      pendingApproval: false,
    };
    expect(agyWatchTick(state, resolved)).toEqual([{ kind: 'UserPromptSubmit' }]);
    expect(state.awaiting).toBe(false);
  });

  it('emits nothing when no conversation is found yet', () => {
    const state: AgyWatchState = { dbPath: null, started: false, awaiting: false };
    expect(agyWatchTick(state, null)).toEqual([]);
  });

  it('treats a NEW conversation db for the same worktree as a fresh session', () => {
    const state: AgyWatchState = {
      dbPath: '/data/conversations/c1.db',
      started: true,
      awaiting: false,
    };
    const fresh: AgyConversationSnapshot = {
      dbPath: '/data/conversations/c2.db',
      conversationId: 'c2',
      pendingApproval: false,
    };
    expect(agyWatchTick(state, fresh)).toEqual([{ kind: 'SessionStart', sessionId: 'c2' }]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/agent/agyConversationWatch.test.ts`
Expected: FAIL — `Cannot find module './agyConversationWatch.js'`.

- [ ] **Step 3: Write the minimal implementation**

`src/agent/agyConversationWatch.ts`:

```ts
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, extname, join } from 'node:path';
import Database from 'better-sqlite3';
import { canonicalPath } from '../runtime/pathScope.js';

/**
 * The Antigravity CLI's conversation state, read as a lifecycle channel.
 *
 * agy 1.1.11 loads `hooks.json` but never EXECUTES hooks in the CLI
 * conversation path (verified empirically — see docs/guides/adding-agent-core.md
 * § Antigravity), so a push bridge would be a silent fake signal. The real,
 * observable channel is the per-conversation SQLite DB the CLI writes at
 * `<appdata>/conversations/<conv-id>.db`: while the user is being asked to
 * approve a tool, the conversation has a `steps` row with `status = 9`
 * (pending user decision), which becomes `status = 3` when the user answers.
 * The same DB's `trajectory_metadata_blob` (row `id='main'`) carries the
 * workspace path as `file://<path>` bytes, which is how a ticket's worktree
 * finds its conversation.
 *
 * This module is vscode-free and host-agnostic: the extension sweep feeds it
 * per-ticket snapshots and it diffs them into the closed hook vocabulary
 * (`SessionStart` / `permission.asked` / `UserPromptSubmit`).
 */

export const AGY_CONVERSATIONS_RELATIVE = join('conversations');

/** agy's app-data dir: `ANTIGRAVITY_EXECUTABLE_DATA_DIR` if set, else `~/.gemini/antigravity-cli`. */
export function resolveAgyAppDataDir(
  env?: NodeJS.ProcessEnv,
  home: string = homedir(),
): string {
  const override = env?.ANTIGRAVITY_EXECUTABLE_DATA_DIR;
  return typeof override === 'string' && override.length > 0
    ? override
    : join(home, '.gemini', 'antigravity-cli');
}

/** Read handle on one conversation DB (foreign schema — strictly read-only). */
export interface AgyConversationDb {
  /** Raw bytes of the `trajectory_metadata_blob` row `id='main'`, or null. */
  workspaceBlob(): Buffer | null;
  /** How many `steps` rows are awaiting a user decision (`status = 9`). */
  pendingApprovalCount(): number;
  close(): void;
}

export type OpenAgyDb = (dbPath: string) => AgyConversationDb;

export function openAgyConversationDb(dbPath: string): AgyConversationDb {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  const blobStmt = db.prepare(
    "SELECT data AS data FROM trajectory_metadata_blob WHERE id = 'main'",
  );
  const pendingStmt = db.prepare('SELECT COUNT(*) AS n FROM steps WHERE status = 9');
  return {
    workspaceBlob(): Buffer | null {
      const row = blobStmt.get() as { data: Buffer | null } | undefined;
      return row?.data ?? null;
    },
    pendingApprovalCount(): number {
      const row = pendingStmt.get() as { n: number } | undefined;
      return row?.n ?? 0;
    },
    close(): void {
      db.close();
    },
  };
}

const FILE_URI_PREFIX = 'file://';

function blobNamesWorktree(blob: Buffer, worktreePath: string): boolean {
  const candidates = [worktreePath, canonicalPath(worktreePath)];
  for (const candidate of candidates) {
    if (candidate && blob.includes(Buffer.from(FILE_URI_PREFIX + candidate))) return true;
  }
  return false;
}

function conversationIdOf(dbPath: string): string {
  return basename(dbPath, extname(dbPath));
}

/**
 * Locate the conversation DB whose workspace blob names `worktreePath`. When
 * several conversations share a worktree (a session ended and a new one began),
 * the NEWEST db file wins — a live session writes its DB continuously, so its
 * file is the freshest. Returns null when nothing matches. Pure over the
 * injected seams; `openDb`/`listDbs` default to the real filesystem.
 */
export function findConversationForWorktree(
  appDataDir: string,
  worktreePath: string,
  openDb: OpenAgyDb = openAgyConversationDb,
  listDbs: (dir: string) => string[] = (dir) => {
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((name) => name.endsWith('.db'))
      .map((name) => join(dir, name));
  },
): { dbPath: string; conversationId: string } | null {
  let best: { dbPath: string; conversationId: string; mtimeMs: number } | null = null;
  for (const dbPath of listDbs(join(appDataDir, AGY_CONVERSATIONS_RELATIVE))) {
    let db: AgyConversationDb;
    try {
      db = openDb(dbPath);
    } catch {
      continue; // a conversation being created concurrently must not fail the tick
    }
    try {
      const blob = db.workspaceBlob();
      if (blob === null || !blobNamesWorktree(blob, worktreePath)) continue;
      const mtimeMs = (() => {
        try {
          return require('node:fs').statSync(dbPath).mtimeMs as number;
        } catch {
          return 0;
        }
      })();
      if (best === null || mtimeMs > best.mtimeMs) {
        best = { dbPath, conversationId: conversationIdOf(dbPath), mtimeMs };
      }
    } finally {
      db.close();
    }
  }
  return best === null ? null : { dbPath: best.dbPath, conversationId: best.conversationId };
}

/** One observed conversation state, diffed against `AgyWatchState`. */
export interface AgyConversationSnapshot {
  dbPath: string;
  conversationId: string;
  /** True while a `status = 9` step exists — the user's answer is pending. */
  pendingApproval: boolean;
}

/** Per-ticket memory of the last observed conversation state. */
export interface AgyWatchState {
  dbPath: string | null;
  started: boolean;
  awaiting: boolean;
}

export type AgyWatchEvent =
  | { kind: 'SessionStart'; sessionId: string }
  | { kind: 'permission.asked' }
  | { kind: 'UserPromptSubmit' };

/**
 * Diff one sweep tick against the last for ONE ticket. Emits only
 * transitions: a session start (once per conversation), the ask becoming
 * pending, and the ask resolving. `null` snapshot (no conversation yet) is
 * silent — the session may not have started, and its end is the terminal's
 * close, not a watcher concern.
 */
export function agyWatchTick(
  state: AgyWatchState,
  snapshot: AgyConversationSnapshot | null,
): AgyWatchEvent[] {
  if (snapshot === null) return [];
  const events: AgyWatchEvent[] = [];
  const sameConversation = state.dbPath === snapshot.dbPath;
  if (!sameConversation || !state.started) {
    state.dbPath = snapshot.dbPath;
    state.started = true;
    state.awaiting = false;
    events.push({ kind: 'SessionStart', sessionId: snapshot.conversationId });
  }
  if (snapshot.pendingApproval && !state.awaiting) {
    state.awaiting = true;
    events.push({ kind: 'permission.asked' });
  } else if (!snapshot.pendingApproval && state.awaiting) {
    state.awaiting = false;
    events.push({ kind: 'UserPromptSubmit' });
  }
  return events;
}
```

Note: `require('node:fs')` inside `findConversationForWorktree` is an ESM interop workaround — in the emitted `.js` the top-level import of `statSync` is cleaner; add `statSync` to the `node:fs` import at the top instead and use it directly (the test injects nothing for stat, and the module is vscode-free either way).

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/agent/agyConversationWatch.test.ts`
Expected: PASS (all 9 cases).

- [ ] **Step 5: Run the whole suite to verify nothing else broke**

Run: `npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/agent/agyConversationWatch.ts src/agent/agyConversationWatch.test.ts
git commit -m "feat: read agy conversation state as a lifecycle channel"
```

---

### Task 2: Flip the Antigravity adapter capabilities truthfully

**Files:**
- Modify: `src/agent/antigravity.ts:113-122` (capabilities + the comment block)
- Modify: `src/agent/antigravity.test.ts:27-39` (capability assertions)

**Interfaces:**
- Consumes: nothing new — `buildInteractiveCommand` already emits `--conversation <id>` when `opts.resume` is set (test 'passes resume and model' pins it).
- Produces: `AntigravityAdapter.capabilities = { lifecycleEvents: true, resume: true, interactiveUsage: false }` — the truthful declaration now that the conversation watch delivers lifecycle events and captures the session id.

- [ ] **Step 1: Write the failing test**

In `src/agent/antigravity.test.ts`, replace the capability assertions:

```ts
it('declares the correct binary and capabilities', () => {
  const adapter = new AntigravityAdapter();
  expect(adapter.requiredBinary).toBe('agy');
  // The conversation watch (agyConversationWatch.ts) reads the CLI's
  // conversation DB: SessionStart from the discovered conversation id, and
  // permission.asked/UserPromptSubmit from a pending `status = 9` step.
  expect(adapter.capabilities.lifecycleEvents).toBe(true);
  // The watch captures the conversation id, and `agy --conversation <id>`
  // resumes it (verified against the installed CLI) — so resume is real.
  expect(adapter.capabilities.resume).toBe(true);
});

// Antigravity has no token-bearing usage channel: agy reports no usage in
// `-p` stdout and the watch reads no usage file. Truthful absence, never a
// measured zero.
it('pins truthful absence of interactive usage — no usage channel exists', () => {
  const adapter = new AntigravityAdapter();
  expect(adapter.capabilities.interactiveUsage).toBe(false);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/agent/antigravity.test.ts`
Expected: FAIL — `expect(adapter.capabilities.lifecycleEvents).toBe(true)` receives `false`.

- [ ] **Step 3: Implement the flip**

In `src/agent/antigravity.ts`, replace the class header comment + capabilities:

```ts
export class AntigravityAdapter implements AgentAdapter {
  // agy 1.1.11 has NO executable hook channel in the CLI (its hooks.json loads
  // but never runs — see docs/guides/adding-agent-core.md § Antigravity), so
  // lifecycle signals come from the conversation watch (agyConversationWatch.ts):
  // it reads the CLI's conversation DB — the pending `status = 9` step that
  // exists exactly while a permission ask is on screen — and normalizes it into
  // the closed hook vocabulary (SessionStart / permission.asked /
  // UserPromptSubmit). The captured conversation id also makes `--conversation`
  // resume real. There is still no usage channel: `interactiveUsage` stays
  // false — truthful absence, never a measured zero.
  readonly capabilities: AgentCapabilities = {
    lifecycleEvents: true,
    resume: true,
    interactiveUsage: false,
  };
  readonly requiredBinary = AGY_BIN;
```

Also update the two stale comments inside `buildInteractiveCommand` (the "agy does not yet expose a lifecycle channel" comment at the `const args` line): remove the comment or point it at the watch:

```ts
  buildInteractiveCommand(opts: InteractiveCommandOpts): InteractiveCommand {
    const args: string[] = [];
    // Lifecycle signals do not ride the launch: the conversation watch
    // (agyConversationWatch.ts) reads them from the CLI's conversation DB.
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/agent/antigravity.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/agent/antigravity.ts src/agent/antigravity.test.ts
git commit -m "feat: flip antigravity lifecycleEvents and resume capabilities truthfully"
```

---

### Task 3: Pin the display chain — an agy wait reads "Needs you"

**Files:**
- Create: `src/hooks/agyWatchDispatch.test.ts` (new — colocated with dispatch tests, proves the watch events → dispatch → glyph/Now-line chain)

**Interfaces:**
- Consumes: `dispatchHook` (`src/hooks/dispatch.ts`), `ticketGlyph` (`src/model/ticketGlyph.ts`), `buildNowLine(cell, { agentWaiting: true })` (`src/model/nowLine.ts` — signature confirmed: second arg is a ctx object with optional `agentWaiting: boolean`; a waiting agent renders `'Now: the agent is waiting — it asked for your input.'`), `openStore(':memory:')` (`src/store/db.ts`), `createTicket` (store), `worktree` row helpers (`src/runtime/worktree.ts` — `worktreeRegisteredAt`/the row shape used in `dispatch.test.ts`; mirror `src/hooks/dispatch.test.ts`'s setup exactly), the `StepperCell` shape from `src/model/nowLine.test.ts` (`{ stageKey, status: 'running' }`).
- Produces: the proof the ticket's acceptance criterion 4 asks for — an agy wait (watch emits `permission.asked` → dispatch → `agent_state='waiting'` → `ticketGlyph === 'amber'` → Now line "the agent is waiting") and its resolution (watch emits `UserPromptSubmit` → `agent_state='running'` → glyph `'blue'`).

- [ ] **Step 1: Read the existing dispatch test setup**

Read `src/hooks/dispatch.test.ts` in full. Copy the store/ticket/worktree fixture pattern (how tickets and worktree rows are created in-memory, how the ticket is read back — `getTicket(store, id)`). `buildNowLine` is confirmed: `buildNowLine({ stageKey: 'impl', status: 'running' }, { agentWaiting: true })` → `{ text: 'Now: the agent is waiting — it asked for your input.' }`.

- [ ] **Step 2: Write the failing test**

`src/hooks/agyWatchDispatch.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { openStore, type Store } from '../store/db.js';
import { createTicket, getTicket } from '../store/tickets.js';
import { worktreeRegisteredAt } from '../runtime/worktree.js';
import { dispatchHook } from './dispatch.js';
import { ticketGlyph } from '../model/ticketGlyph.js';
import { buildNowLine } from '../model/nowLine.js';
// (mirror dispatch.test.ts's fixture helpers for tickets + worktrees)

describe('agy conversation watch → dispatch → needs-you display', () => {
  function setup(): { store: Store; ticketId: number; cwd: string } {
    const store = openStore(':memory:');
    const ticketId = createTicket(store, { /* mirror dispatch.test.ts */ });
    worktreeRegisteredAt('/wt/agy', /* repo path per dispatch.test.ts */);
    return { store, ticketId, cwd: '/wt/agy' };
  }

  it('an agy permission ask renders amber "Needs you" and resolves to running', () => {
    const { store, ticketId, cwd } = setup();
    // The watch emits SessionStart once it discovers the conversation id...
    dispatchHook(store, {
      hook_event_name: 'SessionStart',
      cwd,
      session_id: '11111111-1111-4111-8111-111111111111',
    });
    expect(ticketGlyph(getTicket(store, ticketId))).toBe('blue');
    // ...and permission.asked while the CLI's steps table has a status=9 row.
    dispatchHook(store, {
      hook_event_name: 'permission.asked',
      cwd,
      session_id: '11111111-1111-4111-8111-111111111111',
    });
    expect(getTicket(store, ticketId).agentState).toBe('waiting');
    expect(ticketGlyph(getTicket(store, ticketId))).toBe('amber');
    expect(
      buildNowLine({ stageKey: 'impl', status: 'running' }, { agentWaiting: true }).text,
    ).toContain('the agent is waiting');
    // The user answers → the status=9 row resolves → the watch emits UserPromptSubmit.
    dispatchHook(store, {
      hook_event_name: 'UserPromptSubmit',
      cwd,
      session_id: '11111111-1111-4111-8111-111111111111',
    });
    expect(getTicket(store, ticketId).agentState).toBe('running');
    expect(ticketGlyph(getTicket(store, ticketId))).toBe('blue');
  });
});
```

Copy the `createTicket` call and the `worktreeRegisteredAt` invocation EXACTLY from `src/hooks/dispatch.test.ts` (its fixture columns and repo-path argument); do not invent signatures.

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run src/hooks/agyWatchDispatch.test.ts`
Expected: FAIL for the intended reason (e.g. worktree fixture not registered, or the waiting assertion fails because the setup fixture is wrong) — the point of this step is that the test exercises the real chain before the wiring exists.

- [ ] **Step 4: Make the test pass by fixing the fixtures**

The chain is already implemented (dispatch maps `permission.asked` → waiting, `UserPromptSubmit` → running; glyph maps waiting → amber). Fix the fixture until the assertions pass. Do NOT change production code in this task.

- [ ] **Step 5: Run the related suites**

Run: `npx vitest run src/hooks/dispatch.test.ts src/hooks/agyWatchDispatch.test.ts src/model/ticketGlyph.test.ts src/model/nowLine.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/hooks/agyWatchDispatch.test.ts
git commit -m "test: pin agy wait reads Needs you through dispatch, glyph and Now line"
```

---

### Task 4: Wire the watch sweep in the extension host

**Files:**
- Modify: `src/extension.ts` (endpoint closures extraction ~line 2330; sweep after `runPrSync` ~line 2510; session-close callback ~line 635)

**Interfaces:**
- Consumes: `resolveAgyAppDataDir`, `findConversationForWorktree`, `openAgyConversationDb`, `agyWatchTick`, `AgyWatchState`, `AgyWatchEvent` (Task 1); `identity.identify` (existing `TerminalIdentityRegistry`); `listWorktreesByTicket` (existing); `dispatchHook` (existing); the same notify/shouldApplyState/sessionProviderFor/recorder closures the endpoint uses.
- Produces: `AGY_WATCH_INTERVAL_MS` (10_000), `runAgyConversationWatch` sweep + interval, `agyWatchStates` map, cleanup in the session-close callback.

- [ ] **Step 1: Extract the endpoint callbacks into named consts**

In `extension.ts`, before `startHookEndpoint(...)` (~line 2330), pull the four inline closures into consts so the watch can reuse them verbatim:

```ts
const notifyHook = (ticketId: number, payload: HookPayload): void => {
  if (payload.hook_event_name === 'SessionStart') {
    recoveryLifecycle.sessionStarted(ticketId, payload.launchId);
  }
  const ownership = sessionOwnershipAction(payload.hook_event_name, sessions.isOpen(ticketId));
  const ownershipChanged =
    ownership === 'add' ? !ownedSessionTickets.has(ticketId)
      : ownership === 'remove' ? ownedSessionTickets.has(ticketId) : false;
  if (ownership === 'add') ownedSessionTickets.add(ticketId);
  if (ownership === 'remove') ownedSessionTickets.delete(ticketId);
  if (ownershipChanged) void persistOwnedSessionTickets();
  provider.refresh();
  dashboard.pushState(ticketId);
  maybeDrive(ticketId, 'hook');
};
const shouldApplyHookState = (ticketId: number, payload: HookPayload): boolean =>
  shouldApplySessionHookState(sessions, recoveryLifecycle, ticketId, payload);
const sessionProviderFor = (ticketId: number): AgentProvider | null =>
  resolveProvider(
    getTicket(localStore, ticketId).agentProvider,
    currentManifest()?.agentProvider,
  );
```

Then pass `notifyHook`, `shouldApplyHookState`, `sessionProviderFor` (and the existing `hookChannelRecorder` + ticketApi object) to `startHookEndpoint`. Verify `npm run typecheck` before continuing — this is a pure refactor.

- [ ] **Step 2: Add the sweep after the PR sync wiring** (~line 2510)

```ts
  // Antigravity conversation watch: agy 1.1.11 executes no hooks in the CLI
  // (its hooks.json loads but never runs), so its lifecycle signals are READ,
  // not pushed — the CLI's own conversation DB. A permission ask is a
  // `steps` row with status = 9, observed while the approval dialog is on
  // screen; answering resolves it to status = 3. The sweep locates the
  // conversation by the worktree path stored in the DB's workspace blob,
  // diffs the pending-approval state per ticket, and posts the normalized
  // events (SessionStart / permission.asked / UserPromptSubmit) through the
  // SAME dispatchHook seam and closures as the hook endpoint, so the session
  // id capture, launch-intent confirmation, generation barrier, glyph, Now
  // line and dashboard refresh are shared. Session end → idle is the
  // terminal-close sweep's job, not this one's.
  const AGY_WATCH_INTERVAL_MS = 10_000;
  const agyWatchStates = new Map<number, AgyWatchState>();
  let agyWatchRunning = false;
  const runAgyConversationWatch = (): void => {
    if (agyWatchRunning) return;
    agyWatchRunning = true;
    try {
      const appDataDir = resolveAgyAppDataDir();
      for (const terminal of vscode.window.terminals) {
        const named = identity.identify(terminal);
        if (named?.identity?.provider !== 'antigravity') continue;
        const worktree = listWorktreesByTicket(localStore, named.ticketId)[0];
        if (!worktree) continue;
        let snapshot: AgyConversationSnapshot | null = null;
        try {
          const found = findConversationForWorktree(appDataDir, worktree.path);
          if (found) {
            const db = openAgyConversationDb(found.dbPath);
            try {
              snapshot = {
                dbPath: found.dbPath,
                conversationId: found.conversationId,
                pendingApproval: db.pendingApprovalCount() > 0,
              };
            } finally {
              db.close();
            }
          }
        } catch (error) {
          logError(`karst: agy conversation read failed for ticket ${named.ticketId}`, error);
          continue;
        }
        const state =
          agyWatchStates.get(named.ticketId) ?? { dbPath: null, started: false, awaiting: false };
        const events = agyWatchTick(state, snapshot);
        if (events.length === 0) continue;
        agyWatchStates.set(named.ticketId, state);
        // The session id for non-SessionStart events is the CURRENT
        // conversation's id — the same one SessionStart carried.
        const conversationId = snapshot?.conversationId;
        for (const event of events) {
          const base = {
            cwd: worktree.path,
            session_id:
              event.kind === 'SessionStart'
                ? event.sessionId
                : (conversationId ?? undefined),
            ...(named.launchId ? { launchId: named.launchId } : {}),
          };
          const payload: HookPayload =
            event.kind === 'SessionStart'
              ? { hook_event_name: 'SessionStart', ...base }
              : event.kind === 'permission.asked'
                ? { hook_event_name: 'permission.asked', ...base }
                : { hook_event_name: 'UserPromptSubmit', ...base };
          try {
            dispatchHook(
              localStore,
              payload,
              notifyHook,
              shouldApplyHookState,
              sessionProviderFor,
              hookChannelRecorder,
            );
          } catch (error) {
            logError(`karst: agy watch dispatch failed for ticket ${named.ticketId}`, error);
          }
        }
      }
    } catch (error) {
      logError('karst: agy conversation watch failed', error);
    } finally {
      agyWatchRunning = false;
    }
  };
  void runAgyConversationWatch();
  const agyWatchTimer = setInterval(runAgyConversationWatch, AGY_WATCH_INTERVAL_MS);
  context.subscriptions.push({ dispose: () => clearInterval(agyWatchTimer) });
```

Add the missing imports at the top of `extension.ts`:

```ts
import {
  agyWatchTick,
  findConversationForWorktree,
  openAgyConversationDb,
  resolveAgyAppDataDir,
  type AgyConversationSnapshot,
  type AgyWatchState,
} from './agent/agyConversationWatch.js';
import type { HookPayload } from './hooks/dispatch.js';
```

(`HookPayload` may already be imported — check; add only what is missing.)

- [ ] **Step 3: Clear the per-ticket watch state when its terminal closes**

In the session-close callback (`(ticketId) => { ownedSessionTickets.delete(ticketId); ... }` ~line 635), add the first line:

```ts
    (ticketId) => {
      agyWatchStates.delete(ticketId);
      ownedSessionTickets.delete(ticketId);
      void persistOwnedSessionTickets();
      setAgentState(localStore, ticketId, 'idle');
      ...
```

Note: `agyWatchStates` is declared later in the file than this callback — if the callback is defined before the sweep const, declare `const agyWatchStates = new Map<number, AgyWatchState>();` NEAR THE TOP of the activation (next to `ownedSessionTickets`) and reference it in both places. Move the declaration accordingly.

- [ ] **Step 4: Typecheck and run the suites**

Run: `npm run typecheck && npx vitest run src/agent/agyConversationWatch.test.ts src/hooks/agyWatchDispatch.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: PASS (the sweep is host-side and not unit-tested; the vscode-free logic is fully covered in Task 1/3).

- [ ] **Step 6: Commit**

```bash
git add src/extension.ts
git commit -m "feat: watch agy conversations for pending permission asks"
```

---

### Task 5: Document the research finding and the channel

**Files:**
- Modify: `docs/guides/adding-agent-core.md` (new § Antigravity implementation notes)
- Modify: `AGENTS.md` (the agy capability invariant, one short paragraph near the adapter invariants)

**Interfaces:** none (documentation only).

- [ ] **Step 1: Add the Antigravity section to `docs/guides/adding-agent-core.md`**

Append a section after § 13 (OpenCode notes):

```markdown
## 14. Antigravity implementation notes

Antigravity (agy 1.1.11, Go binary at `~/.local/bin/agy`) was verified against
the installed CLI rather than its docs.

- **Hooks do not execute in the CLI.** agy ships a full hooks system
  (`hooks.json` at `<appdata>/hooks.json` AND `<workspace>/.agents/hooks.json`,
  merged; events PreToolUse/PostToolUse/PreInvocation/PostInvocation/Stop;
  stdin JSON payloads with `conversationId`/`workspacePaths`; `ask`/`allow`/
  `deny`/`force_ask` decisions). The CLI LOADS the files ("loaded 4 named hooks
  from 2 hooks.json file(s)") but NEVER RUNS the commands — verified across
  print and interactive sessions, allowed and permission-requiring tools.
  The hook machinery is wired for the IDE/Antigravity-2.0 surface (the
  model-mediated "call the 'finish' tool to submit your hook decision" path and
  `policyguardian: NewHooks called with nil modelAPI` in the binary). Do NOT
  build a bridge on it — a silent no-op is a fake signal.
- **The lifecycle channel is the conversation DB.** The CLI writes
  `<appdata>/conversations/<conv-id>.db` (SQLite). While a permission dialog
  ("Allow creation of this file?") is on screen, the conversation has a
  `steps` row with `status = 9` (pending user decision); answering resolves it
  to `status = 3`. The `trajectory_metadata_blob` row (`id='main'`) carries the
  workspace path as `file://<path>` bytes, which locates the conversation for a
  ticket's worktree. Karst's `agyConversationWatch` sweep reads this state
  read-only and normalizes it into the closed hook vocabulary
  (`SessionStart` / `permission.asked` / `UserPromptSubmit`) through the same
  `dispatchHook` seam as the HTTP endpoint. `--conversation <id>` resumes a
  session (verified: the CLI prints `agy --conversation=<id>` on exit).
- `ANTIGRAVITY_CONVERSATION_ID` exists in the binary but is NOT set on the CLI
  process environment — do not rely on it for discovery.
- The `-p` (print/headless) mode runs no hooks and writes no conversation DB;
  headless `sessionId` stays `''`.
- Capabilities: `lifecycleEvents: true` and `resume: true` (the watch delivers
  both), `interactiveUsage: false` (no usage channel exists — never a measured
  zero).
```

- [ ] **Step 2: Add the AGENTS.md invariant**

Near the adapter invariants (after the opencode/`--pure` paragraph), add:

```markdown
- **agy has no executable hook channel; its lifecycle signals are READ from the
  CLI's own conversation DB, not pushed.** agy 1.1.11 loads `hooks.json` (both
  `<appdata>/hooks.json` and `<workspace>/.agents/hooks.json`) but never runs
  the hook commands in the CLI conversation path (verified empirically; the
  machinery targets the IDE surface), so a bridge script would be a silent
  fake signal. `src/agent/agyConversationWatch.ts` is the channel: a sweep in
  `extension.ts` finds the conversation DB by the worktree path stored in its
  `trajectory_metadata_blob`, and a `steps` row with `status = 9` is a pending
  permission ask (observed live: dialog open → 9, answered → 3). Events are
  normalized into the CLOSED hook vocabulary (`SessionStart` once per
  conversation, `permission.asked` on 9 appearing, `UserPromptSubmit` on it
  resolving) and posted through the SAME `dispatchHook` seam and closures as
  the HTTP endpoint, so session-id capture (`--conversation` resume), launch
  intent confirmation, the generation barrier, the amber glyph and the Now
  line are shared. Session end → idle stays the terminal-close sweep's job.
  `interactiveUsage` stays false — no usage channel exists.
```

- [ ] **Step 3: Verify the docs read correctly**

Run: `rg -n "agy" docs/guides/adding-agent-core.md | head` and re-read the new section for accuracy against the research in Task 1's module comment.

- [ ] **Step 4: Final full verification**

Run: `npm run typecheck && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add docs/guides/adding-agent-core.md AGENTS.md
git commit -m "docs: document the agy conversation-DB lifecycle channel"
```

---

## Manual verification (acceptance criterion 5)

After the build (`npm run build`), run in the Extension Dev Host (F5):

1. Launch a fix/impl session with `antigravity` as the interactive provider in a real ticket worktree.
2. Let the agent hit a tool that needs approval (e.g. a file write outside its allow list). While the approval dialog is on screen, the ticket should read amber "Needs you" on BOTH the dashboard and the tickets list within ~10 s (the watch interval).
3. Answer the dialog. The ticket should return to running/blue (amber clears) within ~10 s.
4. Close the terminal. The ticket should read idle (existing terminal-close sweep).

## Self-Review

**1. Spec coverage:**
- Research first (AC 1) — done in Task 5 + Task 1 comments: hooks system examined (loads, doesn't execute), transcript JSONL examined (no wait marker), conversation DB verified live as the pending-ask signal (status 9 → 3), env var verified absent on the CLI process.
- Channel + closed vocabulary (AC 2) — Task 1 (`agyWatchTick` emits only `SessionStart`/`permission.asked`/`UserPromptSubmit`) + Task 4 (posts through `dispatchHook`, the same seam as the codex bridge/opencode plugin).
- Capability flip + resume (AC 3) — Task 2 (`lifecycleEvents: true`, `resume: true`, `interactiveUsage: false` kept truthful).
- Tests (AC 4) — Task 1 (watch unit tests), Task 2 (adapter test pinning flips), Task 3 (dispatch + glyph + Now-line chain proving an agy wait reads "Needs you", mirroring 869eg458d's display-side pinning).
- Manual verify (AC 5) — section above.
- Fallback path (AC 6) — not needed: a real channel exists and is used; the finding (hooks don't execute) is documented in `docs/guides/adding-agent-core.md` rather than a fake signal.

**2. Placeholder scan:** Every task has concrete code; no "TBD"/"add appropriate handling". The only deliberate ellipses are fixture copies explicitly directed to mirror `dispatch.test.ts`/`nowLine.test.ts` exactly.

**3. Type consistency:** `AgyWatchState`/`AgyConversationSnapshot`/`AgyWatchEvent`/`findConversationForWorktree`/`agyWatchTick`/`openAgyConversationDb`/`resolveAgyAppDataDir` are defined once in Task 1 and used verbatim in Tasks 3-4. The events are the existing `HookPayload.hook_event_name` values. `named.identity.provider`, `named.launchId`, `listWorktreesByTicket(...)[0].path` are existing extension surfaces verified in this research.
