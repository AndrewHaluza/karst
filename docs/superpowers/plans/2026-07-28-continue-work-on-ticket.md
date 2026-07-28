# Continue Work on a Ticket (Follow-up Tickets) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user turn a `done` ticket into a linked follow-up ticket that inherits its repos/approach/agent/model and carries the parent's brief+PR into the new session's context, instead of starting a blank one.

**Architecture:** One new nullable `tickets.parent_ticket_id` column links a child ticket to its parent. Creating a follow-up is an ordinary `createTicket` call (no new worktree/branch machinery — the child spins a fresh worktree off the repo's configured base, same as any ticket) plus a copy of the parent's onboarding fields. `buildTicketContext` renders a "Continuing from" section when the link is set. Two small UI entry points: a detail-panel button (dashboard) and a sidebar row annotation.

**Tech Stack:** TypeScript, better-sqlite3, vitest, VS Code webview (vanilla JS/HTML, no framework).

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-28-continue-work-on-ticket-design.md`.
- No worktree/branch write-back into ClickUp; karst-local relationship only (spec "Non-goals").
- No agent-invocation cost added to every completed ticket — context sharing is a deterministic markdown render, never a spawned agent call (spec "Alternatives considered", #2).
- Follow every existing schema-versioning convention exactly: `schema.sql` for fresh DBs, a guarded `ALTER` in `migrations.ts` for legacy DBs, `SCHEMA_VERSION` bump, `db.test.ts` version-literal updates (see `src/store/migrations.ts` v12 block for the pattern to copy).
- `vscode`-importing modules (`src/extension.ts`, webview hosts) are not covered by vitest — verify those changes with `npm run typecheck` and `npm run build`, not a unit test.

---

### Task 1: Schema + migration for `tickets.parent_ticket_id`

**Files:**
- Modify: `src/store/schema.sql`
- Modify: `src/store/migrations.ts`
- Test: `src/store/db.test.ts`

**Interfaces:**
- Consumes: nothing new (raw SQL only).
- Produces: a `tickets.parent_ticket_id INTEGER` column (nullable) and an `idx_tickets_parent` index, at `SCHEMA_VERSION = 13`. Task 2 reads/writes this column through the store layer.

- [ ] **Step 1: Write the failing tests**

Add to `src/store/db.test.ts`, directly after the existing `it('tickets carries the v12 agent_provider column', ...)` block (around line 138):

```ts
  it('tickets carries the v13 parent_ticket_id column', () => {
    const store = openStore(':memory:');
    cleanups.push(() => store.close());
    const cols = store.db
      .prepare("PRAGMA table_info('tickets')")
      .all()
      .map((r) => (r as { name: string }).name);
    expect(cols).toContain('parent_ticket_id');
  });

  it('migrates a legacy v12 DB to v13, adding the parent_ticket_id column', () => {
    const dir = mkdtempSync(join(tmpdir(), 'karst-db-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, 'karst.db');
    const legacy = new Database(path);
    legacy.exec(
      "CREATE TABLE tickets (id INTEGER PRIMARY KEY, key TEXT, title TEXT, source TEXT, stage_current TEXT, agent_state TEXT, session_id TEXT, description TEXT, brief TEXT, source_ref TEXT, source_fetched_at TEXT, approach TEXT, agent TEXT, selected_repos TEXT, archived_at TEXT, model TEXT, project_id INTEGER, agent_provider TEXT, created_at TEXT, updated_at TEXT)",
    );
    legacy.prepare('INSERT INTO tickets (key, title) VALUES (?, ?)').run('OLD-12', 'v12 row');
    legacy.pragma('user_version = 12');
    legacy.close();

    const migrated = openStore(path);
    cleanups.push(() => migrated.close());
    const cols = migrated.db
      .prepare("PRAGMA table_info('tickets')")
      .all()
      .map((r) => (r as { name: string }).name);
    expect(cols).toContain('parent_ticket_id');
    const row = migrated.db
      .prepare('SELECT title FROM tickets WHERE key = ?')
      .get('OLD-12') as { title: string } | undefined;
    expect(row?.title).toBe('v12 row'); // data survived
    expect(migrated.db.pragma('user_version', { simple: true })).toBe(13);
  });
```

Then update every existing `.toBe(12)` in this file to `.toBe(13)` (11 occurrences — the `user_version` assertion in each migration test, since every legacy DB now migrates up to the new `SCHEMA_VERSION`).

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/store/db.test.ts`
Expected: FAIL — `parent_ticket_id` column missing; `user_version` assertions expect 13 but schema still reports 12.

- [ ] **Step 3: Add the column + index to `schema.sql`**

In `src/store/schema.sql`, in the `tickets` table definition, change:

```sql
  -- v12 agent_provider column (kept in sync with migrations.ts v12 ALTER):
  agent_provider    TEXT,                 -- per-ticket agent core override; NULL = inherit manifest default
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
```

to:

```sql
  -- v12 agent_provider column (kept in sync with migrations.ts v12 ALTER):
  agent_provider    TEXT,                 -- per-ticket agent core override; NULL = inherit manifest default
  -- v13 parent_ticket_id column (kept in sync with migrations.ts v13 ALTER):
  parent_ticket_id  INTEGER,              -- -> tickets.id; links a follow-up ticket to the parent it continues
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_tickets_parent ON tickets(parent_ticket_id);
```

- [ ] **Step 4: Add the v13 migration step to `migrations.ts`**

In `src/store/migrations.ts`, change:

```ts
export const SCHEMA_VERSION = 12;
```

to:

```ts
export const SCHEMA_VERSION = 13;
```

And after the `if (current < 12) { ... }` block (just before the final `db.pragma(`user_version = ${SCHEMA_VERSION}`);`), add:

```ts
  if (current < 13) {
    // v13 adds parent_ticket_id, linking a follow-up ticket to the completed
    // ticket it continues work from (§ continue work on a ticket). Fresh DBs
    // already carry it (schema.sql); guard so the ALTER only runs for a legacy
    // DB being upgraded. NULL = not a follow-up.
    const cols = ticketColumns(db);
    if (cols.size > 0 && !cols.has('parent_ticket_id')) {
      db.exec('ALTER TABLE tickets ADD COLUMN parent_ticket_id INTEGER');
    }
    db.exec('CREATE INDEX IF NOT EXISTS idx_tickets_parent ON tickets(parent_ticket_id)');
  }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/store/db.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/store/schema.sql src/store/migrations.ts src/store/db.test.ts
git commit -m "feat: add tickets.parent_ticket_id (v13 migration)"
```

---

### Task 2: Store layer — `Ticket.parentTicketId` + `createTicket`

**Files:**
- Modify: `src/store/tickets.ts`
- Modify: `src/store/tickets.test.ts`
- Modify: `src/ui/sidebar/items.test.ts`
- Modify: `src/ui/sidebar/facets.test.ts`
- Modify: `src/model/stageBadge.test.ts`

**Interfaces:**
- Consumes: Task 1's `tickets.parent_ticket_id` column.
- Produces: `Ticket.parentTicketId: number | null`; `createTicket(store, { ..., parentTicketId?: number })`. Task 3 (`createFollowUpTicket`) and Task 4 (`buildTicketContext`) both read `Ticket.parentTicketId`.

- [ ] **Step 1: Write the failing tests**

Add to `src/store/tickets.test.ts`, in the `describe('ticket + stage persistence', ...)` block, directly after `it('new tickets default the onboarding fields', ...)` (around line 168-177):

```ts
  it('a new ticket has a null parentTicketId (not a follow-up) by default', () => {
    const t = createTicket(store, { key: 'PROJ-1', title: 'root ticket' });
    expect(t.parentTicketId).toBeNull();
  });

  it('createTicket persists parentTicketId, readable via getTicket', () => {
    const parent = createTicket(store, { key: 'PROJ-1', title: 'root ticket' });
    const child = createTicket(store, {
      key: 'PROJ-1-fu1',
      title: 'follow-up',
      parentTicketId: parent.id,
    });
    expect(child.parentTicketId).toBe(parent.id);
    expect(getTicket(store, child.id).parentTicketId).toBe(parent.id);
  });
```

Also add `parentTicketId: null,` to the `base: Ticket` fixture at the top of `src/store/tickets.test.ts` (after `projectId: null,`, around line 44), and the identical field to the equivalent fixture object literals in `src/ui/sidebar/items.test.ts` (after `projectId: null,`, around line 22), `src/ui/sidebar/facets.test.ts` (same spot), and `src/model/stageBadge.test.ts` (same spot) — each of those three declares `Partial<TicketWithStages>` factory functions with the identical field list.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/store/tickets.test.ts`
Expected: FAIL — `parentTicketId` does not exist on the returned ticket (TypeScript compile error until Step 3, or `undefined` at runtime if run via a loose transpile).

- [ ] **Step 3: Add `parentTicketId` to the store types and `createTicket`**

In `src/store/tickets.ts`, in the `Ticket` interface, after:

```ts
  projectId: number | null;
}
```

change to:

```ts
  projectId: number | null;
  /**
   * The completed ticket this one continues work from (§ continue work on a
   * ticket); `null` for an ordinary ticket. Set once, at creation.
   */
  parentTicketId: number | null;
}
```

In the `TicketRow` interface, after `project_id: number | null;`, add:

```ts
  parent_ticket_id: number | null;
```

In `rowToTicket`, after `projectId: r.project_id,`, add:

```ts
    parentTicketId: r.parent_ticket_id,
```

In `createTicket`'s input type, after `projectId?: number;` (and its comment), add:

```ts
    /** Links a follow-up ticket to the completed parent it continues work from. */
    parentTicketId?: number;
```

And change the `INSERT` inside `createTicket`:

```ts
    const info = store.db
      .prepare(
        `INSERT INTO tickets (key, title, source, description, project_id, stage_current, agent_state)
         VALUES (?, ?, ?, ?, ?, 'scope', 'none')`,
      )
      .run(
        input.key,
        input.title,
        input.source ?? 'manual',
        input.description ?? null,
        input.projectId ?? null,
      );
```

to:

```ts
    const info = store.db
      .prepare(
        `INSERT INTO tickets (key, title, source, description, project_id, parent_ticket_id, stage_current, agent_state)
         VALUES (?, ?, ?, ?, ?, ?, 'scope', 'none')`,
      )
      .run(
        input.key,
        input.title,
        input.source ?? 'manual',
        input.description ?? null,
        input.projectId ?? null,
        input.parentTicketId ?? null,
      );
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/store/tickets.test.ts src/ui/sidebar/items.test.ts src/ui/sidebar/facets.test.ts src/model/stageBadge.test.ts`
Expected: PASS

- [ ] **Step 5: Typecheck and fix any remaining fixture gaps**

Run: `npm run typecheck`
Expected: no errors. If `tsc` reports a missing `parentTicketId` property on any other object literal typed as `Ticket`/`TicketWithStages` (a fixture this plan didn't enumerate), add `parentTicketId: null,` to it at the same spot as `projectId: null,` and re-run typecheck until clean.

- [ ] **Step 6: Commit**

```bash
git add src/store/tickets.ts src/store/tickets.test.ts src/ui/sidebar/items.test.ts src/ui/sidebar/facets.test.ts src/model/stageBadge.test.ts
git commit -m "feat: thread parentTicketId through the ticket store layer"
```

---

### Task 3: Follow-up ticket creation

**Files:**
- Create: `src/workflow/stages/followUp.ts`
- Test: `src/workflow/stages/followUp.test.ts`

**Interfaces:**
- Consumes: `createTicket`, `getTicket`, `getTicketByKey`, `updateTicketOnboarding`, `type ProjectScope`, `type Ticket` from `../../store/tickets.js` (Task 2).
- Produces: `createFollowUpTicket(store: Store, parentTicketId: number, scope?: ProjectScope): Ticket` and `class TicketNotDoneError extends Error`. Task 5's command handler calls `createFollowUpTicket`.

- [ ] **Step 1: Write the failing test**

Create `src/workflow/stages/followUp.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openStore, type Store } from '../../store/db.js';
import { createTicket, updateTicketOnboarding } from '../../store/tickets.js';
import { createFollowUpTicket, TicketNotDoneError } from './followUp.js';

describe('createFollowUpTicket', () => {
  let store: Store;
  beforeEach(() => (store = openStore(':memory:')));
  afterEach(() => store.close());

  function doneParent(overrides: {
    key?: string;
    title?: string;
    approach?: string;
    agent?: string;
    selectedRepos?: string[];
    model?: string;
    agentProvider?: string;
    projectId?: number;
  } = {}): number {
    const t = createTicket(store, {
      key: overrides.key ?? 'PROJ-1',
      title: overrides.title ?? 'Ship the thing',
      projectId: overrides.projectId,
    });
    updateTicketOnboarding(store, t.id, {
      approach: overrides.approach,
      agent: overrides.agent,
      selectedRepos: overrides.selectedRepos ?? ['frontend'],
      model: overrides.model,
      agentProvider: overrides.agentProvider,
    });
    store.db.prepare("UPDATE tickets SET stage_current = 'done' WHERE id = ?").run(t.id);
    return t.id;
  }

  it('creates a child ticket linked to the parent via parentTicketId', () => {
    const parentId = doneParent();
    const child = createFollowUpTicket(store, parentId);
    expect(child.parentTicketId).toBe(parentId);
    expect(child.key).toBe('PROJ-1-fu1');
    expect(child.title).toBe('Follow-up: Ship the thing');
    expect(child.source).toBe('karst');
  });

  it('copies repos/approach/agent/model/agentProvider from the parent', () => {
    const parentId = doneParent({
      approach: 'rpi',
      agent: 'reviewer',
      selectedRepos: ['frontend', 'backend'],
      model: 'claude-opus-4-8',
      agentProvider: 'codex',
    });
    const child = createFollowUpTicket(store, parentId);
    expect(child.approach).toBe('rpi');
    expect(child.agent).toBe('reviewer');
    expect(child.selectedRepos).toEqual(['frontend', 'backend']);
    expect(child.model).toBe('claude-opus-4-8');
    expect(child.agentProvider).toBe('codex');
  });

  it('generates the next free -fuN suffix when the parent already has a follow-up', () => {
    const parentId = doneParent();
    createFollowUpTicket(store, parentId);
    const second = createFollowUpTicket(store, parentId);
    expect(second.key).toBe('PROJ-1-fu2');
  });

  it('rejects a parent ticket that has not reached done', () => {
    const t = createTicket(store, { key: 'PROJ-2', title: 'still working' });
    expect(() => createFollowUpTicket(store, t.id)).toThrow(TicketNotDoneError);
  });

  it('scopes key generation per project, like getTicketByKey', () => {
    const parentId = doneParent({ projectId: 1 });
    const child = createFollowUpTicket(store, parentId, { projectId: 1 });
    expect(child.projectId).toBe(1);
    expect(child.key).toBe('PROJ-1-fu1');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/workflow/stages/followUp.test.ts`
Expected: FAIL — `./followUp.js` does not exist.

- [ ] **Step 3: Write the implementation**

Create `src/workflow/stages/followUp.ts`:

```ts
import type { Store } from '../../store/db.js';
import {
  createTicket,
  getTicket,
  getTicketByKey,
  updateTicketOnboarding,
  type ProjectScope,
  type Ticket,
} from '../../store/tickets.js';

/**
 * A ticket is only a valid follow-up source once its work has actually
 * shipped (§ continue work on a ticket) — `done` is the stage graph's only
 * terminal state (graph.ts), so this is the one deterministic gate. Checked
 * here even though the UI only offers the action once a ticket is `done`, in
 * case a stale view triggers it anyway.
 */
export class TicketNotDoneError extends Error {
  constructor(ticketId: number, stageCurrent: string | null) {
    super(`ticket #${ticketId} is not done yet (stage: ${stageCurrent ?? 'none'})`);
    this.name = 'TicketNotDoneError';
  }
}

/** Next unclaimed `<parentKey>-fu<n>` suffix, scoped like every other key lookup. */
function nextFollowUpKey(store: Store, parentKey: string, scope: ProjectScope): string {
  for (let n = 1; n <= 999; n++) {
    const candidate = `${parentKey}-fu${n}`;
    if (!getTicketByKey(store, candidate, scope)) return candidate;
  }
  throw new Error(`could not generate a unique follow-up key for ${parentKey}`);
}

/**
 * Create a follow-up ticket linked to a completed parent (§ continue work on
 * a ticket). The child inherits the parent's repos/approach/agent/model so it
 * is ready to spin immediately on a fresh worktree — no special worktree or
 * branch handling is needed, since the parent's merged work already lives on
 * the configured base branch. The user only has to write the actual
 * follow-up ask into the new ticket's description.
 */
export function createFollowUpTicket(
  store: Store,
  parentTicketId: number,
  scope: ProjectScope = {},
): Ticket {
  const parent = getTicket(store, parentTicketId);
  if (parent.stageCurrent !== 'done') {
    throw new TicketNotDoneError(parentTicketId, parent.stageCurrent);
  }

  const parentKey = parent.key ?? `#${parent.id}`;
  const key = nextFollowUpKey(store, parentKey, scope);
  const child = createTicket(store, {
    key,
    title: `Follow-up: ${parent.title ?? parentKey}`,
    source: 'karst',
    projectId: scope.projectId,
    parentTicketId: parent.id,
  });

  updateTicketOnboarding(store, child.id, {
    approach: parent.approach ?? undefined,
    agent: parent.agent ?? undefined,
    selectedRepos: parent.selectedRepos,
    model: parent.model ?? undefined,
    agentProvider: parent.agentProvider ?? undefined,
  });

  return getTicket(store, child.id);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/workflow/stages/followUp.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/workflow/stages/followUp.ts src/workflow/stages/followUp.test.ts
git commit -m "feat: add createFollowUpTicket (links + copies onboarding from a done parent)"
```

---

### Task 4: Context sharing — render the parent section

**Files:**
- Modify: `src/context/ticketContext.ts`
- Modify: `src/context/ticketContext.test.ts`

**Interfaces:**
- Consumes: `Ticket.parentTicketId` (Task 2), `getTicket` from `../store/tickets.js`, `listPrsByTicket` from `../store/dashboard.js` (already imported in this file).
- Produces: `TicketContext.parent: { key: string | null; title: string | null; brief: string | null; prs: { repo: string; number: number | null; url: string | null }[] } | null`. `renderTicketContext` emits a `## Continuing from <key>: <title>` section when `parent` is set.

- [ ] **Step 1: Write the failing tests**

Add to `src/context/ticketContext.test.ts`. First, extend the existing `seed()` helper or add a new one — insert this new test into the `describe('buildTicketContext', ...)` block:

```ts
  it('includes a parent section when the ticket links to a completed parent', () => {
    const parent = createTicket(store, { key: 'PROJ-1', title: 'Root work' });
    updateTicketOnboarding(store, parent.id, { brief: 'Built the thing.' });
    store.db.prepare("UPDATE tickets SET stage_current = 'done' WHERE id = ?").run(parent.id);
    store.db
      .prepare(
        "INSERT INTO prs (ticket_id, repo, number, url, status) VALUES (?, 'frontend', 7, 'https://x/pr/7', 'merged')",
      )
      .run(parent.id);

    const child = createTicket(store, {
      key: 'PROJ-1-fu1',
      title: 'Follow-up: Root work',
      parentTicketId: parent.id,
    });

    const ctx = buildTicketContext(store, undefined, child.id);
    expect(ctx.parent).toEqual({
      key: 'PROJ-1',
      title: 'Root work',
      brief: 'Built the thing.',
      prs: [{ repo: 'frontend', number: 7, url: 'https://x/pr/7' }],
    });

    const md = renderTicketContext(ctx);
    expect(md).toContain('## Continuing from PROJ-1: Root work');
    expect(md).toContain('Built the thing.');
    expect(md).toContain('https://x/pr/7');
  });

  it('omits the parent section for an ordinary (non-follow-up) ticket', () => {
    const t = createTicket(store, { key: 'PROJ-9', title: 'root' });
    const ctx = buildTicketContext(store, undefined, t.id);
    expect(ctx.parent).toBeNull();
    expect(renderTicketContext(ctx)).not.toContain('## Continuing from');
  });

  it('degrades gracefully when the linked parent has been hard-deleted', () => {
    const parent = createTicket(store, { key: 'PROJ-1', title: 'Root work' });
    const child = createTicket(store, {
      key: 'PROJ-1-fu1',
      title: 'Follow-up',
      parentTicketId: parent.id,
    });
    store.db.prepare('DELETE FROM tickets WHERE id = ?').run(parent.id);

    const ctx = buildTicketContext(store, undefined, child.id);
    expect(ctx.parent).toBeNull();
    expect(renderTicketContext(ctx)).not.toContain('## Continuing from');
  });
```

Add `createTicket` to this test file's existing import from `'../store/tickets.js'` (it currently imports only `createTicket, updateTicketOnboarding` — confirm both are already there; they are).

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/context/ticketContext.test.ts`
Expected: FAIL — `ctx.parent` is `undefined`, not present on `TicketContext`.

- [ ] **Step 3: Add the parent section to `TicketContext`/`buildTicketContext`/`renderTicketContext`**

In `src/context/ticketContext.ts`, add a new exported interface after `TicketContextPr`:

```ts
/** The completed ticket this one continues work from, or null for an ordinary ticket. */
export interface TicketContextParent {
  key: string | null;
  title: string | null;
  brief: string | null;
  prs: { repo: string; number: number | null; url: string | null }[];
}
```

Add `parent: TicketContextParent | null;` to the `TicketContext` interface, after `prs: TicketContextPr[];`:

```ts
  prs: TicketContextPr[];
  /** Set when this ticket was created via "create follow-up" from a completed parent. */
  parent: TicketContextParent | null;
  repos: TicketContextRepo[];
```

In `buildTicketContext`, before the final `return { ... }`, resolve the parent. `getTicket` throws on an unknown id (it's used for `ticketId` itself above, via `getTicket(store, ticketId)` assigned to `t`), so guard the lookup rather than let a deleted parent throw:

```ts
  const parent: TicketContextParent | null = (() => {
    if (t.parentTicketId === null) return null;
    let p;
    try {
      p = getTicket(store, t.parentTicketId);
    } catch {
      return null; // parent was hard-deleted; degrade rather than fail context building
    }
    return {
      key: p.key,
      title: p.title,
      brief: p.brief,
      prs: listPrsByTicket(store, p.id).map((pr) => ({
        repo: pr.repo,
        number: pr.number,
        url: pr.url,
      })),
    };
  })();
```

Place this block directly above the function's `return`, and add `parent,` to the returned object (after `prs: listPrsByTicket(...)`, before `repos,`):

```ts
    prs: listPrsByTicket(store, ticketId).map((p) => { /* unchanged */ }),
    parent,
    repos,
  };
```

In `renderTicketContext`, after the `## Pull requests` block (before `return parts.join(...)`), add:

```ts
  if (ctx.parent) {
    const heading = ctx.parent.key && ctx.parent.title
      ? `${ctx.parent.key}: ${ctx.parent.title}`
      : ctx.parent.key || ctx.parent.title || 'parent ticket';
    const lines: string[] = [];
    const brief = ctx.parent.brief?.trim();
    if (brief) lines.push(brief);
    for (const pr of ctx.parent.prs) {
      const num = pr.number !== null ? `#${pr.number}` : '(no number)';
      const url = pr.url ? ` — ${pr.url}` : '';
      lines.push(`- ${pr.repo} ${num}${url}`);
    }
    parts.push(`## Continuing from ${heading}\n${lines.join('\n')}`);
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/context/ticketContext.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/context/ticketContext.ts src/context/ticketContext.test.ts
git commit -m "feat: render the parent ticket's brief+PRs into a follow-up's session context"
```

---

### Task 5: `karst.createFollowUpTicket` command

**Files:**
- Modify: `src/extension.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: `createFollowUpTicket`, `TicketNotDoneError` from `./workflow/stages/followUp.js` (Task 3); existing `ticketIdArg`, `currentProject`, `resolveManifest`, `manifestPathOrThrow`, `onboarding.openEdit`, `provider.refresh` (all already in scope in `extension.ts`, used by the neighboring `editTicket`/`archiveTicket` commands).
- Produces: the `karst.createFollowUpTicket` command, invoked with a ticket id (bare number or `{ ticketId }`, same convention as every other ticket command). Task 6 wires the dashboard button to it.

- [ ] **Step 1: Register the command**

In `src/extension.ts`, add the import at the top, alongside the other workflow imports (near `archiveTicket, unarchiveTicket` at line ~116):

```ts
import { createFollowUpTicket, TicketNotDoneError } from './workflow/stages/followUp.js';
```

Register the command directly after `karst.editTicket` (around line 1518-1525), matching its manifest-resolution pattern:

```ts
    vscode.commands.registerCommand('karst.createFollowUpTicket', async (arg: unknown) => {
      const ticketId = ticketIdArg(arg);
      if (ticketId === undefined) return;
      let child;
      try {
        child = createFollowUpTicket(localStore, ticketId, { projectId: currentProject()?.id });
      } catch (err) {
        const message =
          err instanceof TicketNotDoneError
            ? err.message
            : `Couldn't create a follow-up ticket: ${err instanceof Error ? err.message : String(err)}`;
        void vscode.window.showErrorMessage(message);
        return;
      }
      provider.refresh();
      const manifest = await resolveManifest();
      if (manifest) manifests.set(manifest, manifestPathOrThrow());
      onboarding.openEdit(child.id);
      void vscode.window.showInformationMessage(`Created follow-up ticket ${child.key}.`);
    }),
```

- [ ] **Step 2: Contribute the command in `package.json`**

In `package.json`, in `contributes.commands`, add an entry directly after the `karst.editTicket` entry (around line 79):

```json
      {
        "command": "karst.createFollowUpTicket",
        "title": "Karst: Create Follow-up Ticket",
        "icon": "$(reply)"
      },
```

- [ ] **Step 3: Typecheck and build**

Run: `npm run typecheck`
Expected: no errors.

Run: `npm run build`
Expected: succeeds.

- [ ] **Step 4: Commit**

```bash
git add src/extension.ts package.json
git commit -m "feat: register the karst.createFollowUpTicket command"
```

---

### Task 6: Dashboard "Create follow-up" button

**Files:**
- Modify: `src/ui/dashboard/messages.ts`
- Modify: `src/ui/dashboard/messages.test.ts`
- Modify: `src/extension.ts`
- Modify: `src/ui/dashboard/webview.html`
- Modify: `src/ui/dashboard/webview.test.ts`

**Interfaces:**
- Consumes: `karst.createFollowUpTicket` command (Task 5); existing `DashboardActions`/`WebviewMessage`/`routeAction`/`parseWebviewMessage` machinery (`messages.ts`); existing `state.stageCurrent` (`state.ts`, unchanged).
- Produces: a `{ type: 'create-follow-up-ticket' }` webview message and `DashboardActions.createFollowUpTicket: () => void`, wired to `vscode.commands.executeCommand('karst.createFollowUpTicket', ticketId)`.

- [ ] **Step 1: Write the failing test**

Add to `src/ui/dashboard/messages.test.ts`, in the `actions()` fixture, after `resumeTicket: vi.fn(),`:

```ts
    createFollowUpTicket: vi.fn(),
```

Add a new test near the other single-action dispatch tests (e.g. after the `resume-ticket` test, if one exists — otherwise after the `ship-ticket` test):

```ts
  it('dispatches create-follow-up-ticket', () => {
    const a = actions();
    routeAction({ type: 'create-follow-up-ticket' }, a);
    expect(a.createFollowUpTicket).toHaveBeenCalled();
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/ui/dashboard/messages.test.ts`
Expected: FAIL — `create-follow-up-ticket` is not a recognized message type / `createFollowUpTicket` missing from the fixture (TS compile error).

- [ ] **Step 3: Add the message type + action**

In `src/ui/dashboard/messages.ts`, add to the `WebviewMessage` union, after `| { type: 'resume-ticket' }`:

```ts
  | { type: 'create-follow-up-ticket' }
```

Add to `DashboardActions`, after `resumeTicket: () => void;`:

```ts
  createFollowUpTicket: () => void;
```

Add to `parseWebviewMessage`'s `switch`, after `case 'resume-ticket': return { type: 'resume-ticket' };`:

```ts
    case 'create-follow-up-ticket':
      return { type: 'create-follow-up-ticket' };
```

Add to `routeAction`'s `switch`, after `case 'resume-ticket': actions.resumeTicket(); return;`:

```ts
    case 'create-follow-up-ticket':
      actions.createFollowUpTicket();
      return;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/ui/dashboard/messages.test.ts`
Expected: PASS

- [ ] **Step 5: Wire the action in `extension.ts`**

In `src/extension.ts`, in `makeDashboardActions`'s returned object, after `resumeTicket: () => void vscode.commands.executeCommand('karst.openSession', ticketId),`, add:

```ts
    // Opens the onboarding edit page on the new ticket so the user can type
    // the actual follow-up ask straight away — the command itself copies
    // repos/approach/agent/model from this ticket.
    createFollowUpTicket: () =>
      void vscode.commands.executeCommand('karst.createFollowUpTicket', ticketId),
```

- [ ] **Step 6: Add the button + visibility toggle + click handler to `webview.html`**

In `src/ui/dashboard/webview.html`, change the header:

```html
<div class="dhead">
  <span id="keyPill"></span>
  <h1 id="title"></h1>
  <span class="agent" id="agent"></span>
  <button id="editBtn" title="Edit ticket">Edit</button>
</div>
```

to:

```html
<div class="dhead">
  <span id="keyPill"></span>
  <h1 id="title"></h1>
  <span class="agent" id="agent"></span>
  <button id="followUpBtn" class="hidden" title="Create a new ticket linked to this one, pre-filled with its repos/approach/agent">Create follow-up</button>
  <button id="editBtn" title="Edit ticket">Edit</button>
</div>
```

In the `render(state)` function, after `renderKeyPill(state);`, add:

```js
    el('followUpBtn').classList.toggle('hidden', state.stageCurrent !== 'done');
```

Next to the existing `el('editBtn').addEventListener(...)` line, add:

```js
  el('followUpBtn').addEventListener('click', () => post({ type: 'create-follow-up-ticket' }));
```

- [ ] **Step 7: Write the text-level webview guard test**

Add to `src/ui/dashboard/webview.test.ts`, following the file's existing "text-level guard" style:

```ts
  it('shows the follow-up button only once the ticket is done', () => {
    expect(HTML).toContain('id="followUpBtn"');
    expect(HTML).toContain("el('followUpBtn').classList.toggle('hidden', state.stageCurrent !== 'done')");
  });

  it('wires the follow-up button to create-follow-up-ticket', () => {
    expect(HTML).toContain("post({ type: 'create-follow-up-ticket' })");
  });
```

- [ ] **Step 8: Run tests, typecheck, build**

Run: `npx vitest run src/ui/dashboard/messages.test.ts src/ui/dashboard/webview.test.ts`
Expected: PASS

Run: `npm run typecheck && npm run build`
Expected: succeeds.

- [ ] **Step 9: Commit**

```bash
git add src/ui/dashboard/messages.ts src/ui/dashboard/messages.test.ts src/extension.ts src/ui/dashboard/webview.html src/ui/dashboard/webview.test.ts
git commit -m "feat: add a Create follow-up button to the ticket dashboard"
```

---

### Task 7: Sidebar "follow-up of" annotation

**Files:**
- Modify: `src/ui/sidebar/items.ts`
- Modify: `src/ui/sidebar/items.test.ts`
- Modify: `src/ui/sidebar/state.ts`
- Modify: `src/ui/sidebar/state.test.ts`
- Modify: `src/ui/sidebar/webview.html`
- Modify: `src/ui/sidebar/webview.test.ts`

**Interfaces:**
- Consumes: `Ticket.parentTicketId` (Task 2).
- Produces: `TicketNode.parentKey: string | null`; `buildTicketNodes(tickets, labelTemplate?, parentKeys?: Map<number, string>)`. Sidebar webview renders "↳ `<parentKey>`" beside the row label when set.

- [ ] **Step 1: Write the failing tests**

Add to `src/ui/sidebar/items.test.ts`, in the `describe('buildTicketNodes', ...)` block:

```ts
  it('carries no parentKey for an ordinary ticket', () => {
    const [node] = buildTicketNodes([ticket({ parentTicketId: null })]);
    expect(node.parentKey).toBeNull();
  });

  it('resolves parentKey from the supplied lookup map when parentTicketId is set', () => {
    const parentKeys = new Map([[1, 'PROJ-1']]);
    const [node] = buildTicketNodes([ticket({ id: 2, parentTicketId: 1 })], undefined, parentKeys);
    expect(node.parentKey).toBe('PROJ-1');
  });

  it('falls back to null when parentTicketId points outside the supplied map', () => {
    const [node] = buildTicketNodes([ticket({ id: 2, parentTicketId: 999 })], undefined, new Map());
    expect(node.parentKey).toBeNull();
  });
```

Add the mirror-image test to `src/ui/sidebar/state.test.ts` — find its existing `describe('buildSidebarState', ...)` (or equivalent) and add:

```ts
  it('resolves a follow-up row\'s parentKey even when the parent sits in a different facet', () => {
    const parent = createTicket(store, { key: 'PROJ-1', title: 'root' });
    store.db.prepare("UPDATE tickets SET stage_current = 'done' WHERE id = ?").run(parent.id);
    archiveTicket(store, parent.id); // parent is archived; child is not
    createTicket(store, { key: 'PROJ-1-fu1', title: 'follow-up', parentTicketId: parent.id });

    const state = buildSidebarState(store, { facets: ['all'], filter: '' });
    const child = state.rows.find((r) => r.label.startsWith('PROJ-1-fu1'));
    expect(child?.parentKey).toBe('PROJ-1');
  });
```

`src/ui/sidebar/state.test.ts` already imports `openStore`, `createTicket`, and `archiveTicket` — no new imports needed for this test.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/ui/sidebar/items.test.ts src/ui/sidebar/state.test.ts`
Expected: FAIL — `parentKey` missing from `TicketNode`.

- [ ] **Step 3: Add `parentKey` to `TicketNode`/`buildTicketNodes`**

In `src/ui/sidebar/items.ts`, add to the `TicketNode` interface, after `archived: boolean;`:

```ts
  /** The parent ticket's key, when this ticket was created via "create follow-up"; else null. */
  parentKey: string | null;
```

Change `buildTicketNodes`'s signature and body:

```ts
export function buildTicketNodes(
  tickets: readonly TicketWithStages[],
  labelTemplate?: string,
  /** id -> key, for every ticket in the project (not just the currently visible facet). */
  parentKeys: Map<number, string> = new Map(),
): TicketNode[] {
  return tickets.map((t) => {
    const badge = stageBadge(t);
    const current = t.stages.find((s) => s.stageKey === t.stageCurrent);
    const failed = currentStageStatus(t) === 'failed';
    const blocker: Blocker | null = failed
      ? { reason: current?.verdict ?? null, attempt: current?.attempt ?? 0 }
      : null;
    return {
      kind: 'ticket',
      ticketId: t.id,
      label: ticketLabel(t, labelTemplate),
      glyph: badge.glyph,
      description: `${t.stageCurrent ?? 'none'} (${currentStageStatus(t)})`,
      stageLabel: badge.label,
      stageClass: stageColorClass(badge.stage),
      stageChip: badge.stage ?? 'none',
      blocker,
      activityLabel: activityLabel(t.agentState),
      sessionAction: sessionAction(t),
      lastActiveAt: current?.endedAt ?? current?.startedAt ?? null,
      model: t.model,
      archived: t.archivedAt !== null,
      parentKey: t.parentTicketId !== null ? (parentKeys.get(t.parentTicketId) ?? null) : null,
      collapsible: true,
    };
  });
}
```

- [ ] **Step 4: Wire the lookup map in `buildSidebarState`**

In `src/ui/sidebar/state.ts`, change:

```ts
  const facets = normalizeSelection(opts.facets);
  const source = facets.includes('archived') ? archived : filterBySelection(active, facets);
  const visible = filterTickets(source, opts.filter);

  const rows: TicketRow[] = buildTicketNodes(visible, opts.labelTemplate).map((node) => ({
```

to:

```ts
  const facets = normalizeSelection(opts.facets);
  const source = facets.includes('archived') ? archived : filterBySelection(active, facets);
  const visible = filterTickets(source, opts.filter);

  // Every ticket in the project, active + archived, so a follow-up row can
  // resolve its parent's key even when the parent sits in a facet the user
  // isn't currently viewing (e.g. the parent was archived after the child
  // was created).
  const parentKeys = new Map<number, string>();
  for (const t of [...active, ...archived]) {
    if (t.key !== null) parentKeys.set(t.id, t.key);
  }

  const rows: TicketRow[] = buildTicketNodes(visible, opts.labelTemplate, parentKeys).map((node) => ({
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/ui/sidebar/items.test.ts src/ui/sidebar/state.test.ts`
Expected: PASS

- [ ] **Step 6: Render the annotation in `webview.html`**

In `src/ui/sidebar/webview.html`, add a CSS rule near `.name`'s definition (around line 91):

```css
  .parentref{font-size:10px;color:var(--g-gray);flex:0 0 auto;margin-left:4px}
```

Change:

```js
        + `<span class="name">${esc(row.label)}</span>`
```

to:

```js
        + `<span class="name">${esc(row.label)}</span>`
        + (row.parentKey ? `<span class="parentref" title="Follow-up of ${esc(row.parentKey)}">↳ ${esc(row.parentKey)}</span>` : '')
```

- [ ] **Step 7: Write the text-level webview guard test**

Add to `src/ui/sidebar/webview.test.ts`:

```ts
  it('renders a follow-up annotation beside the row label when parentKey is set', () => {
    expect(HTML).toContain('row.parentKey');
    expect(HTML).toContain('class="parentref"');
  });
```

- [ ] **Step 8: Run tests, typecheck**

Run: `npx vitest run src/ui/sidebar/items.test.ts src/ui/sidebar/state.test.ts src/ui/sidebar/webview.test.ts`
Expected: PASS

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 9: Commit**

```bash
git add src/ui/sidebar/items.ts src/ui/sidebar/items.test.ts src/ui/sidebar/state.ts src/ui/sidebar/state.test.ts src/ui/sidebar/webview.html src/ui/sidebar/webview.test.ts
git commit -m "feat: annotate follow-up tickets with their parent's key in the sidebar"
```

---

## Final verification

- [ ] Run the full suite: `npm test`
- [ ] Run `npm run typecheck`
- [ ] Run `npm run build`
- [ ] Manual smoke test (F5, per CLAUDE.md's `dev:extension` launch): create a ticket, drive it to `done` (or force via SQL as the tests do), open its dashboard, confirm the "Create follow-up" button appears, click it, confirm a new ticket appears in the sidebar tagged "↳ `<parentKey>`", opens onboarding-edit, and its repos/approach/agent match the parent's.
