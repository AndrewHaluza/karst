# Ticket Dashboard: Shared Services Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The ticket's Servers panel lists the shared baseline services it consumes beside the services it runs in its own worktrees, so the user can see that, for example, the API is running from `develop` rather than from the ticket's branch.

**Architecture:** A new store read model (`store/sharedServers.ts`) joins the ticket's `baseline_refs` edges to the baseline `servers` row (`ticket_id IS NULL`, `kind='service'`), resolving the unit through the manifest for its base branch and baseline checkout. `store/baselineRefs.ts` gains a detailed dependents read with the `live` rule (`!archived && (stageCurrent !== 'done' || hasRunningService)`), reused by the Resource Monitor's stop confirmation. The dashboard state carries the rows as `sharedServers` (injected into `buildDashboardState`, like every other manifest fact) while `servers` keeps its exact current meaning, so no existing action changes. The vanilla Servers panel renders ONE grid with two captioned groups; shared rows are read-only (Open/Logs/Manage), and the header ops state that they act on **ticket services**.

**Tech Stack:** TypeScript ESM (`.js` import suffixes), better-sqlite3 store, vitest (unit + VM-rendered webview tests), Playwright visual/layout sweeps. The webview is standalone HTML+JS (`src/ui/dashboard/webview.html`); UI copy arrives host-worded in `DashboardState`.

**Spec:** ticket T778 `TICKET-DASHBOARD-SHOW-THE-SHARED` (planned in P7 as D203). Binding reference blocks: `@arch:PORTS`, `@arch:CONTAINER`, `@arch:WT-REMOVE`, `@arch:SERVICES-WT`, `@ui:UI-R37`, `@ui:UI-R41`, `@ui:UI-R42`, `@ui:UI-R44`, `@ui:UI-R45`, `@ui:UI-R46`.

## Global Constraints

- Strict TDD (RED→GREEN), conventional commits, one commit per task.
- Files stay small (< 400 lines typical). ESM imports need the `.js` suffix. `noUncheckedIndexedAccess` is on.
- `vscode` is **not** a runtime dependency: all logic takes injected interfaces and runs under vitest. `extension.ts` handlers are bindings only.
- Verdicts/read models are deterministic. A ref naming a service no longer in the manifest renders `missing` — **never throw**.
- `baseline_refs` rows are **never deleted** on done or archive: `runtime/startOne.ts:244` reads them to avoid re-pointing a baseline to an alt port. The read model filters; it does not write.
- Shared rows get **no** start/stop/restart control in the ticket panel. A stop affects other tickets and belongs in the follow-up project view.
- `servers` keeps its current meaning (ticket-scoped rows only). Every existing action and its tests keep their behavior.
- Never edit `tests/visual/__baselines__` or `tests/visual/layout-known-failures.json` to pass a gate. The only baseline change allowed here is **recording the new variant's** three new PNGs.
- `docs/arch/system-map.md` is generated: after adding a module run `npm run -s docs:graph` and commit the result (CI and the UAT `docs-graph` gate run it with `--check`).
- Output discipline: `npm run -s …`; scope vitest to the file(s) you changed; never pass a reporter flag.
- UI-R37: no existing action may change what it does or what it posts. The only new action in this plan is `open-resources` (Manage), which runs `karst.openResources` unchanged.

## File Structure

| File | Responsibility |
|---|---|
| `src/store/baselineRefs.ts` (modify) | Detailed dependents of one baseline repo; the `live` rule; `baselineDependentsFor` by server id. |
| `src/store/sharedServers.ts` (create) | `SharedServerView` + `listSharedServersByTicket`: refs → baseline row + manifest facts + dependents. |
| `src/ui/dashboard/stateTypes.ts` (modify) | `sharedServers: SharedServerView[]` on `DashboardState`. |
| `src/ui/dashboard/state.ts` (modify) | Injected `sharedServersFor` provider → `state.sharedServers` (the builder never reads the manifest). |
| `src/ui/dashboard/panel.ts` (modify) | Binds the provider to the live manifest getter; passes shared log sources to the console. |
| `src/ui/dashboard/consoleOutput.ts` (modify) | The combined logs view includes the shared services' logs. |
| `src/ui/dashboard/messages.ts` (modify) | Wire `open-resources` (parse + route + `DashboardActions.openResources`). |
| `src/ui/dashboard/webviewSend.ts` (modify) | Typed `openResources` sender. |
| `src/extension.ts` (modify) | One binding: `openResources: () => vscode.commands.executeCommand('karst.openResources')`. |
| `src/ui/resources/panel.ts` (modify) | Stop confirmation names live dependents and marks a done-but-running one. |
| `src/ui/dashboard/webview.html` (modify) | `renderServers`: two caption rows in one grid, shared rows, header copy, empty states, CSS. |
| `src/ui/dashboard/renderFixtures.ts` (modify) | `sharedServerFixtures()` + `sharedServers: []` on the neutral state. |
| `tests/visual/variants.ts` (modify) | New `shared-services` dashboard variant. |
| `docs/arch/worktrees-and-servers.md` (modify) | New `@arch:SHARED-VIEW` block + a Rules reference from `WT-00`. |

Tests touched/created: `src/store/baselineRefs.test.ts`, `src/store/sharedServers.test.ts` (new), `src/ui/dashboard/state.test.ts`, `src/ui/dashboard/panel.test.ts`, `src/ui/dashboard/consoleOutput.test.ts` (new), `src/ui/dashboard/messages.test.ts`, `src/ui/dashboard/webviewSend.test.ts`, `src/ui/resources/panel.test.ts`, `src/ui/dashboard/webview.test.ts`.

---

### Task 1: Detailed baseline dependents + the `live` rule

**Files:**
- Modify: `src/store/baselineRefs.ts` (replace the 38-line module's contents)
- Test: `src/store/baselineRefs.test.ts`

**Interfaces:**
- Consumes: `Store` (`./db.js`).
- Produces:
  - `interface BaselineDependent { ticketId: number; key: string | null; title: string | null; stageCurrent: string | null; archived: boolean; hasRunningService: boolean }`
  - `listBaselineDependentsDetailed(store: Store, repo: string): BaselineDependent[]`
  - `isLiveBaselineDependent(d: BaselineDependent): boolean`
  - `baselineDependentsFor(store: Store, serverId: number): BaselineDependent[]` (LIVE rows only; `[]` for a ticket-scoped or missing row)
- Removes: `listBaselineDependents` (its only caller is `baselineDependentsFor`, which moves to the detailed read; keeping a second, differently-filtered dependents function invites the two answers to drift).

- [ ] **Step 1: Write the failing test**

Replace `src/store/baselineRefs.test.ts` with:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openStore, type Store } from './db.js';
import { archiveTicket, createTicket } from './tickets.js';
import { setStage } from './stages.js';
import {
  baselineDependentsFor,
  isLiveBaselineDependent,
  listBaselineDependentsDetailed,
} from './baselineRefs.js';

function addRef(store: Store, ticketId: number, repo: string): void {
  store.db
    .prepare('INSERT OR IGNORE INTO baseline_refs (ticket_id, repo) VALUES (?, ?)')
    .run(ticketId, repo);
}

function addServer(
  store: Store,
  ticketId: number | null,
  repo: string,
  status = 'running',
): number {
  const info = store.db
    .prepare(
      `INSERT INTO servers (ticket_id, repo, host, port, pid, status, log_path, started_at, cwd)
       VALUES (?, ?, 'localhost', 5173, 4242, ?, '/tmp/x.log', '2026-08-12T10:00:00.000Z', '/tmp/wt/x')`,
    )
    .run(ticketId, repo, status);
  return Number(info.lastInsertRowid);
}

/** Move a ticket to `done`, the one stage whose liveness depends on its servers. */
function makeDone(store: Store, ticketId: number): void {
  setStage(store, ticketId, 'done', { status: 'passed', verdict: 'merged' });
  store.db.prepare("UPDATE tickets SET stage_current = 'done' WHERE id = ?").run(ticketId);
}

describe('listBaselineDependentsDetailed', () => {
  let store: Store;
  beforeEach(() => (store = openStore(':memory:')));
  afterEach(() => store.close());

  it('returns every ref of the repo with its ticket facts, ordered by ticket id', () => {
    const b = createTicket(store, { key: 'B', title: 'b' });
    const a = createTicket(store, { key: 'A', title: 'a' });
    addRef(store, b.id, 'api');
    addRef(store, a.id, 'api');
    addServer(store, b.id, 'web', 'running');

    expect(listBaselineDependentsDetailed(store, 'api')).toEqual([
      {
        ticketId: a.id,
        key: 'A',
        title: 'a',
        stageCurrent: 'scope',
        archived: false,
        hasRunningService: false,
      },
      {
        ticketId: b.id,
        key: 'B',
        title: 'b',
        stageCurrent: 'scope',
        archived: false,
        hasRunningService: true,
      },
    ]);
  });

  it('counts only a running SERVICE as a running stack, not a graph agent row', () => {
    const a = createTicket(store, { key: 'A', title: 'a' });
    addRef(store, a.id, 'api');
    store.db
      .prepare(
        `INSERT INTO servers (ticket_id, repo, host, port, pid, status, kind)
         VALUES (?, 'graph', NULL, NULL, 11, 'running', 'agent')`,
      )
      .run(a.id);

    expect(listBaselineDependentsDetailed(store, 'api')[0]!.hasRunningService).toBe(false);
  });

  it('reports archived as a fact, and excludes a ref whose ticket row is gone', () => {
    const a = createTicket(store, { key: 'A', title: 'a' });
    addRef(store, a.id, 'api');
    addRef(store, 9999, 'api');
    archiveTicket(store, a.id);

    const rows = listBaselineDependentsDetailed(store, 'api');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.archived).toBe(true);
  });

  it('returns [] for a repo with no refs', () => {
    expect(listBaselineDependentsDetailed(store, 'api')).toEqual([]);
  });
});

describe('isLiveBaselineDependent', () => {
  const dep = (over: Partial<Parameters<typeof isLiveBaselineDependent>[0]> = {}) => ({
    ticketId: 1,
    key: 'A',
    title: 'a',
    stageCurrent: 'impl',
    archived: false,
    hasRunningService: false,
    ...over,
  });

  it('counts a non-archived ticket that is not done', () => {
    expect(isLiveBaselineDependent(dep())).toBe(true);
  });

  it('does not count a done ticket whose services are stopped', () => {
    expect(isLiveBaselineDependent(dep({ stageCurrent: 'done' }))).toBe(false);
  });

  it('counts a done ticket that still runs a service — a live stack to break', () => {
    expect(isLiveBaselineDependent(dep({ stageCurrent: 'done', hasRunningService: true }))).toBe(
      true,
    );
  });

  it('never counts an archived ticket, even one still running', () => {
    expect(
      isLiveBaselineDependent(dep({ archived: true, stageCurrent: 'done', hasRunningService: true })),
    ).toBe(false);
  });
});

describe('baselineDependentsFor', () => {
  let store: Store;
  beforeEach(() => (store = openStore(':memory:')));
  afterEach(() => store.close());

  it('returns the live dependents of a baseline row (ticket_id IS NULL)', () => {
    const live = createTicket(store, { key: 'A', title: 'a' });
    const finished = createTicket(store, { key: 'B', title: 'b' });
    const archived = createTicket(store, { key: 'C', title: 'c' });
    addRef(store, live.id, 'api');
    addRef(store, finished.id, 'api');
    addRef(store, archived.id, 'api');
    makeDone(store, finished.id);
    archiveTicket(store, archived.id);
    const baselineId = addServer(store, null, 'api');

    expect(baselineDependentsFor(store, baselineId)).toEqual([
      {
        ticketId: live.id,
        key: 'A',
        title: 'a',
        stageCurrent: 'scope',
        archived: false,
        hasRunningService: false,
      },
    ]);
  });

  it('keeps a done ticket that still runs a service', () => {
    const finished = createTicket(store, { key: 'B', title: 'b' });
    addRef(store, finished.id, 'api');
    makeDone(store, finished.id);
    addServer(store, finished.id, 'web');
    const baselineId = addServer(store, null, 'api');

    expect(baselineDependentsFor(store, baselineId).map((d) => d.key)).toEqual(['B']);
  });

  it('returns [] for a ticket-scoped row and for an id with no row', () => {
    const a = createTicket(store, { key: 'A', title: 'a' });
    addRef(store, a.id, 'api');
    const ticketServerId = addServer(store, a.id, 'api');

    expect(baselineDependentsFor(store, ticketServerId)).toEqual([]);
    expect(baselineDependentsFor(store, 9999)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/store/baselineRefs.test.ts`
Expected: FAIL — `isLiveBaselineDependent` and `listBaselineDependentsDetailed` are not exported.

- [ ] **Step 3: Write the implementation**

Replace `src/store/baselineRefs.ts` with:

```ts
import type { Store } from './db.js';

/**
 * One ticket that declared a dependency on a baseline service, with the facts a
 * "who would this stop affect" prompt needs. Written by `runtime/baseline.ts` at
 * each spin; read here and by `store/sharedServers.ts`.
 *
 * Rows whose ticket has since been deleted are excluded by the join — a stale
 * ref must not inflate the count behind a prompt a human is reading.
 */
export interface BaselineDependent {
  ticketId: number;
  key: string | null;
  title: string | null;
  stageCurrent: string | null;
  /** Soft-deleted: its worktrees are gone, so it is never live. */
  archived: boolean;
  /** It still has a running service of its own — a live stack to break. */
  hasRunningService: boolean;
}

interface DependentRow {
  ticketId: number;
  key: string | null;
  title: string | null;
  stageCurrent: string | null;
  archived: number;
  hasRunningService: number;
}

/**
 * Every ticket that declared a dependency on the baseline `repo`. Returns the
 * RAW rows, including archived ones: the caller decides what counts as live, so
 * this read stays a fact rather than a policy.
 */
export function listBaselineDependentsDetailed(
  store: Store,
  repo: string,
): BaselineDependent[] {
  const rows = store.db
    .prepare(
      `SELECT b.ticket_id AS ticketId, t.key AS key, t.title AS title,
              t.stage_current AS stageCurrent,
              (t.archived_at IS NOT NULL) AS archived,
              EXISTS(SELECT 1 FROM servers s
                      WHERE s.ticket_id = b.ticket_id AND s.kind = 'service'
                        AND s.status = 'running') AS hasRunningService
         FROM baseline_refs b
         JOIN tickets t ON t.id = b.ticket_id
        WHERE b.repo = ?
        ORDER BY b.ticket_id`,
    )
    .all(repo) as DependentRow[];
  return rows.map((r) => ({
    ticketId: r.ticketId,
    key: r.key,
    title: r.title,
    stageCurrent: r.stageCurrent,
    archived: r.archived === 1,
    hasRunningService: r.hasRunningService === 1,
  }));
}

/**
 * Whether stopping the baseline would take a live stack out from under this
 * ticket.
 *
 * A done ticket counts ONLY while it still runs a service of its own: the shared
 * copy is exactly what that running stack is wired to, and stopping it breaks
 * the stack. An archived ticket never counts — its worktrees are gone, so there
 * is nothing left to break.
 *
 * The ref itself is kept either way: `runtime/startOne.ts` reads `baseline_refs`
 * to avoid re-pointing a baseline to an alt port, so filtering (never deleting)
 * is what keeps that wiring intact.
 */
export function isLiveBaselineDependent(d: BaselineDependent): boolean {
  return !d.archived && (d.stageCurrent !== 'done' || d.hasRunningService);
}

/**
 * The same answer addressed by `servers.id`, for a caller that holds a row id
 * rather than a repository name. Returns `[]` for a row that is not a baseline
 * (`ticket_id IS NOT NULL`) and for a row that no longer exists.
 *
 * Only the LIVE dependents: the stop confirmation names exactly the tickets the
 * stop would affect.
 */
export function baselineDependentsFor(store: Store, serverId: number): BaselineDependent[] {
  const row = store.db
    .prepare('SELECT repo, ticket_id FROM servers WHERE id = ?')
    .get(serverId) as { repo: string; ticket_id: number | null } | undefined;
  if (!row || row.ticket_id !== null) return [];
  return listBaselineDependentsDetailed(store, row.repo).filter(isLiveBaselineDependent);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/store/baselineRefs.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add src/store/baselineRefs.ts src/store/baselineRefs.test.ts
git commit -m "feat(store): read baseline dependents with stage and liveness"
```

---

### Task 2: The shared-services read model

**Files:**
- Create: `src/store/sharedServers.ts`
- Test: `src/store/sharedServers.test.ts`

**Interfaces:**
- Consumes: `Store`; `Manifest` (`../manifest/types.js`); `resolveBaselineBranch(manifest, repository)` (`../manifest/baselineBranch.js`); `unitByKey(manifest, key)` (`../manifest/runnable.js`); `baselineCheckoutDir(repoPath, repoName)` (`../runtime/baselinePaths.js`); `formatId('ticket', id)` (`../model/entityId.js`); Task 1's `BaselineDependent`, `listBaselineDependentsDetailed`, `isLiveBaselineDependent`.
- Produces:
  - `interface SharedServerView { id: number | null; service: string; status: 'running' | 'stopped' | 'failed' | 'missing'; host: string | null; port: number | null; logPath: string | null; container: string | null; baseBranch: string | null; checkoutPath: string | null; sharedWith: string; missingReason: string | null; dependents: BaselineDependent[] }`
  - `listSharedServersByTicket(store: Store, manifest: Manifest, ticketId: number): SharedServerView[]`

**Notes for the implementer (the traps):**

1. `baseline_refs.repo` and `servers.repo` hold the **unit key**: the bare repository name for a `service:` shorthand, `repo/service` for a `services:` entry (`src/manifest/runnable.ts:18-32`).
2. The checkout directory is keyed by the **repository name**, not the unit key — `runtime/baseline.ts:405` calls `ensureBaselineCheckout(repo.repoPath, repoName, …)` and sibling services share one checkout. So pass `unit.repo` (== the repository name) as the second argument of `baselineCheckoutDir`, never the unit key.
3. A repository can leave the manifest after the ref was written. `unitByKey` returns `undefined`; the row is `missing` with `missingReason: 'no longer declared in karst.yml'` and null branch/checkout. Never throw.
4. More than one baseline row can survive for one repo (retained stopped rows). Pick the best: running first, then newest.
5. `sharedWith` describes the dependency's **other** live consumers, so the ticket's own panel never says "shared with itself".

- [ ] **Step 1: Write the failing test**

Create `src/store/sharedServers.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openStore, type Store } from './db.js';
import { archiveTicket, createTicket } from './tickets.js';
import { manifest, repo, runnableRepo } from '../manifest/fixtures.js';
import { listSharedServersByTicket, type SharedServerView } from './sharedServers.js';

function addRef(store: Store, ticketId: number, key: string): void {
  store.db
    .prepare('INSERT OR IGNORE INTO baseline_refs (ticket_id, repo) VALUES (?, ?)')
    .run(ticketId, key);
}

function addBaseline(
  store: Store,
  key: string,
  over: { status?: string; host?: string | null; port?: number | null; logPath?: string | null } = {},
): number {
  const info = store.db
    .prepare(
      `INSERT INTO servers (ticket_id, repo, host, port, pid, status, log_path, started_at, cwd, container)
       VALUES (NULL, ?, ?, ?, 4242, ?, ?, '2026-08-12T10:00:00.000Z', '/tmp/baseline', 'karst-baseline-api')`,
    )
    .run(
      key,
      over.host === undefined ? 'localhost' : over.host,
      over.port === undefined ? 4000 : over.port,
      over.status ?? 'running',
      over.logPath === undefined ? `/tmp/${key.replace('/', '-')}.log` : over.logPath,
    );
  return Number(info.lastInsertRowid);
}

/** `api` shorthand + `web/ui` service-map entry, both runnable. */
function twoRepoManifest() {
  return manifest({
    api: runnableRepo({}, { repoPath: '/repos/api', baselineBranch: 'develop' }),
    web: runnableRepo(
      {},
      {
        repoPath: '/repos/web',
        services: { ui: { start: 'npm start', ports: [], dependsOn: [] } },
      } as never,
    ),
  });
}

function view(views: SharedServerView[], service: string): SharedServerView {
  const found = views.find((v) => v.service === service);
  if (!found) throw new Error(`no shared view for ${service}`);
  return found;
}

describe('listSharedServersByTicket', () => {
  let store: Store;
  beforeEach(() => (store = openStore(':memory:')));
  afterEach(() => store.close());

  it('returns the baseline row a ref points at, with its address and log', () => {
    const t = createTicket(store, { key: 'T-1', title: 't' });
    addRef(store, t.id, 'api');
    const id = addBaseline(store, 'api');

    expect(view(listSharedServersByTicket(store, twoRepoManifest(), t.id), 'api')).toMatchObject({
      id,
      service: 'api',
      status: 'running',
      host: 'localhost',
      port: 4000,
      logPath: '/tmp/api.log',
      container: 'karst-baseline-api',
    });
  });

  it('resolves the base branch, baseline checkout and the repo/service display key', () => {
    const t = createTicket(store, { key: 'T-1', title: 't' });
    addRef(store, t.id, 'web/ui');
    addBaseline(store, 'web/ui');

    expect(view(listSharedServersByTicket(store, twoRepoManifest(), t.id), 'web/ui')).toMatchObject({
      service: 'web/ui',
      status: 'running',
      baseBranch: 'develop',
      // ONE checkout per REPOSITORY, shared by its sibling services.
      checkoutPath: '/repos/web/.karst/baseline/web',
    });
  });

  it('reports a ref with no servers row as missing, without inventing an address', () => {
    const t = createTicket(store, { key: 'T-1', title: 't' });
    addRef(store, t.id, 'api');

    expect(view(listSharedServersByTicket(store, twoRepoManifest(), t.id), 'api')).toMatchObject({
      id: null,
      status: 'missing',
      host: null,
      port: null,
      logPath: null,
      baseBranch: 'develop',
      missingReason: null,
    });
  });

  it('marks a unit that left the manifest missing, with the manifest reason, and never throws', () => {
    const t = createTicket(store, { key: 'T-1', title: 't' });
    addRef(store, t.id, 'api/v2');
    addBaseline(store, 'api/v2');
    const shrunk = manifest({ web: runnableRepo({}, { repoPath: '/repos/web' }) });

    expect(view(listSharedServersByTicket(store, shrunk, t.id), 'api/v2')).toMatchObject({
      status: 'missing',
      baseBranch: null,
      checkoutPath: null,
      missingReason: 'no longer declared in karst.yml',
    });
  });

  it('keeps a stopped baseline visible as stopped, addressless', () => {
    const t = createTicket(store, { key: 'T-1', title: 't' });
    addRef(store, t.id, 'api');
    addBaseline(store, 'api', { status: 'stopped', host: null, port: null });

    expect(view(listSharedServersByTicket(store, twoRepoManifest(), t.id), 'api')).toMatchObject({
      status: 'stopped',
      host: null,
      port: null,
    });
  });

  it('passes a failed baseline through as failed', () => {
    const t = createTicket(store, { key: 'T-1', title: 't' });
    addRef(store, t.id, 'api');
    addBaseline(store, 'api', { status: 'failed', host: null, port: null });

    expect(view(listSharedServersByTicket(store, twoRepoManifest(), t.id), 'api').status).toBe(
      'failed',
    );
  });

  it('prefers the running row when a retired stopped row still exists', () => {
    const t = createTicket(store, { key: 'T-1', title: 't' });
    addRef(store, t.id, 'api');
    addBaseline(store, 'api', { status: 'stopped', port: null });
    const live = addBaseline(store, 'api');

    expect(view(listSharedServersByTicket(store, twoRepoManifest(), t.id), 'api')).toMatchObject({
      id: live,
      status: 'running',
    });
  });

  it('names the OTHER live dependents, excluding this ticket and finished or archived ones', () => {
    const t = createTicket(store, { key: 'T-1', title: 't' });
    const other = createTicket(store, { key: 'T-412', title: 'other' });
    const done = createTicket(store, { key: 'T-418', title: 'done' });
    const gone = createTicket(store, { key: 'T-419', title: 'archived' });
    for (const id of [t.id, other.id, done.id, gone.id]) addRef(store, id, 'api');
    // done + still running: it counts.
    store.db.prepare("UPDATE tickets SET stage_current = 'done' WHERE id = ?").run(done.id);
    store.db
      .prepare(
        `INSERT INTO servers (ticket_id, repo, host, port, pid, status)
         VALUES (?, 'web', 'localhost', 5173, 9, 'running')`,
      )
      .run(done.id);
    archiveTicket(store, gone.id);
    addBaseline(store, 'api');

    expect(
      view(listSharedServersByTicket(store, twoRepoManifest(), t.id), 'api').sharedWith,
    ).toBe('shared with T-412, T-418');
  });

  it('falls back to T<id> for a dependent with no key', () => {
    const t = createTicket(store, { key: 'T-1', title: 't' });
    const other = createTicket(store, { key: 'T-412', title: 'other' });
    store.db.prepare('UPDATE tickets SET key = NULL WHERE id = ?').run(other.id);
    addRef(store, t.id, 'api');
    addRef(store, other.id, 'api');
    addBaseline(store, 'api');

    expect(view(listSharedServersByTicket(store, twoRepoManifest(), t.id), 'api').sharedWith).toBe(
      `shared with T${other.id}`,
    );
  });

  it('says "no other live tickets" when nothing else consumes the baseline', () => {
    const t = createTicket(store, { key: 'T-1', title: 't' });
    addRef(store, t.id, 'api');
    addBaseline(store, 'api');

    expect(
      view(listSharedServersByTicket(store, twoRepoManifest(), t.id), 'api').sharedWith,
    ).toBe('no other live tickets');
  });

  it('returns [] for a ticket with no refs, and keeps dependents off other refs', () => {
    const t = createTicket(store, { key: 'T-1', title: 't' });
    addRef(store, t.id, 'api');
    addBaseline(store, 'api');

    expect(listSharedServersByTicket(store, twoRepoManifest(), t.id)[0]!.dependents).toHaveLength(1);
    expect(listSharedServersByTicket(store, twoRepoManifest(), 9999)).toEqual([]);
  });

  it('does not treat a ticket-scoped server row as the shared copy', () => {
    const t = createTicket(store, { key: 'T-1', title: 't' });
    addRef(store, t.id, 'api');
    store.db
      .prepare(
        `INSERT INTO servers (ticket_id, repo, host, port, pid, status)
         VALUES (?, 'api', 'localhost', 5173, 3, 'running')`,
      )
      .run(t.id);

    expect(view(listSharedServersByTicket(store, twoRepoManifest(), t.id), 'api').status).toBe(
      'missing',
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/store/sharedServers.test.ts`
Expected: FAIL — cannot resolve `./sharedServers.js`.

- [ ] **Step 3: Write the implementation**

Create `src/store/sharedServers.ts`:

```ts
import type { Store } from './db.js';
import type { Manifest } from '../manifest/types.js';
import { resolveBaselineBranch } from '../manifest/baselineBranch.js';
import { unitByKey } from '../manifest/runnable.js';
import { baselineCheckoutDir } from '../runtime/baselinePaths.js';
import { formatId } from '../model/entityId.js';
import {
  isLiveBaselineDependent,
  listBaselineDependentsDetailed,
  type BaselineDependent,
} from './baselineRefs.js';

/** Why a ref cannot render a service at all. */
const NO_LONGER_DECLARED = 'no longer declared in karst.yml';

/**
 * One shared (baseline) service a ticket consumes, ready to render. The shared
 * half is read-only in the ticket panel: a stop affects every other consumer, so
 * control lives in the project view.
 */
export interface SharedServerView {
  /** The baseline `servers.id`; null when no row exists (the ref is `missing`). */
  id: number | null;
  /** The manifest unit key — `api`, or `api/web` for a `services:` entry — and
   *  how the unit renders: the key IS the display name. */
  service: string;
  status: 'running' | 'stopped' | 'failed' | 'missing';
  host: string | null;
  port: number | null;
  logPath: string | null;
  container: string | null;
  /** The base branch the shared copy serves; null when the unit left the manifest. */
  baseBranch: string | null;
  /** The shared checkout on disk; null when the unit left the manifest. */
  checkoutPath: string | null;
  /** `shared with T412, T418` — the live dependents OTHER than this ticket. */
  sharedWith: string;
  /** Why a `missing` ref cannot run; null for every other status. */
  missingReason: string | null;
  /** Every ticket that declared this dependency, raw (archived included). */
  dependents: BaselineDependent[];
}

interface BaselineRow {
  id: number;
  host: string | null;
  port: number | null;
  status: string;
  log_path: string | null;
  container: string | null;
}

function statusOf(row: BaselineRow | undefined): SharedServerView['status'] {
  if (!row) return 'missing';
  if (row.status === 'running') return 'running';
  if (row.status === 'failed') return 'failed';
  return 'stopped';
}

/**
 * The shared services ONE ticket consumes: for each of its `baseline_refs`
 * edges, the baseline `servers` row it points at (`ticket_id IS NULL`,
 * `kind = 'service'`), plus the manifest facts that say where that copy runs.
 *
 * The manifest is read ONLY here and only for a ref's own repository: a unit
 * renamed out of `karst.yml` is reported `missing` with the reason, never an
 * exception — the panel must be able to describe a wiring that no longer
 * resolves.
 */
export function listSharedServersByTicket(
  store: Store,
  manifest: Manifest,
  ticketId: number,
): SharedServerView[] {
  const refs = store.db
    .prepare('SELECT repo FROM baseline_refs WHERE ticket_id = ? ORDER BY repo')
    .all(ticketId) as { repo: string }[];

  return refs.map(({ repo: key }) => {
    const unit = unitByKey(manifest, key);
    // Retained stopped rows are normal (stopServer marks, never deletes), so a
    // running row wins over a retired one; the newest is the best of equals.
    const row = store.db
      .prepare(
        `SELECT id, host, port, status, log_path, container FROM servers
          WHERE repo = ? AND ticket_id IS NULL AND kind = 'service'
          ORDER BY CASE WHEN status = 'running' THEN 0 ELSE 1 END, id DESC
          LIMIT 1`,
      )
      .get(key) as BaselineRow | undefined;

    const dependents = listBaselineDependentsDetailed(store, key);
    const others = dependents
      .filter((d) => d.ticketId !== ticketId && isLiveBaselineDependent(d))
      .map((d) => d.key ?? formatId('ticket', d.ticketId));

    return {
      id: row?.id ?? null,
      service: key,
      status: statusOf(row),
      host: row?.host ?? null,
      port: row?.port ?? null,
      logPath: row?.log_path ?? null,
      container: row?.container ?? null,
      baseBranch: unit ? resolveBaselineBranch(manifest, unit.repoDef) : null,
      // ONE checkout per REPOSITORY (`unit.repo`), shared by sibling services.
      checkoutPath: unit ? baselineCheckoutDir(unit.repoDef.repoPath, unit.repo) : null,
      sharedWith: others.length > 0 ? `shared with ${others.join(', ')}` : 'no other live tickets',
      missingReason: unit ? null : NO_LONGER_DECLARED,
      dependents,
    };
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/store/sharedServers.test.ts`
Expected: PASS (13 tests).

- [ ] **Step 5: Commit**

```bash
git add src/store/sharedServers.ts src/store/sharedServers.test.ts
git commit -m "feat(store): list the shared services a ticket consumes"
```

---

### Task 3: Carry `sharedServers` in the dashboard state

**Files:**
- Modify: `src/ui/dashboard/stateTypes.ts` (import + field after `servers`)
- Modify: `src/ui/dashboard/state.ts` (import, last constructor parameter, one read, one return field)
- Modify: `src/ui/dashboard/panel.ts` (private provider + pass it last)
- Test: `src/ui/dashboard/state.test.ts`, `src/ui/dashboard/panel.test.ts`

**Interfaces:**
- Consumes: Task 2's `SharedServerView`, `listSharedServersByTicket`.
- Produces: `DashboardState.sharedServers: SharedServerView[]`; `buildDashboardState(..., sharedServersFor: (ticketId: number) => SharedServerView[] = () => [])` as its 23rd (LAST) parameter.

**Why injected:** `buildDashboardState` is deliberately manifest-free (every manifest fact arrives through a getter — see its `serviceNames`, `repoNameFor`, `baseBranchDefaultFor` parameters). The panel owns the live `manifest?: () => Manifest | undefined` getter, so it builds the rows and the builder just places them. Appending LAST keeps every existing positional caller's argument positions.

- [ ] **Step 1: Write the failing test**

Add to `src/ui/dashboard/state.test.ts`, inside `describe('buildDashboardState', …)` after the first test, plus one assertion in the first test:

```ts
    expect(state.sharedServers).toEqual([]);
```

```ts
  it('places the injected shared services beside the ticket rows', () => {
    const t = createTicket(store, { key: 'PROJ-1', title: 'thing' });
    const shared = {
      id: 5,
      service: 'api',
      status: 'running' as const,
      host: 'localhost',
      port: 4000,
      logPath: '/tmp/api.log',
      container: null,
      baseBranch: 'develop',
      checkoutPath: '/repo/.karst/baseline/api',
      sharedWith: 'no other live tickets',
      missingReason: null,
      dependents: [],
    };

    const state = buildDashboardState(
      store, t.id,
      undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined,
      () => [shared],
    );

    expect(state.sharedServers).toEqual([shared]);
    // `servers` keeps its own meaning: the shared half never leaks into it.
    expect(state.servers).toEqual([]);
  });
```

Add to `src/ui/dashboard/panel.test.ts`, inside `describe('DashboardManager', …)` after the manifest fix-budget test:

```ts
  it('pushes the ticket’s shared services into the dashboard state', () => {
    const t = createTicket(store, { key: 'SH-1', title: 'shared' });
    store.db.prepare('INSERT INTO baseline_refs (ticket_id, repo) VALUES (?, ?)').run(t.id, 'api');
    store.db
      .prepare(
        `INSERT INTO servers (ticket_id, repo, host, port, pid, status, log_path)
         VALUES (NULL, 'api', 'localhost', 4000, 11, 'running', '/tmp/api.log')`,
      )
      .run();
    const { host, panels } = fakeHost();
    const noop = undefined;
    const mgr = new DashboardManager(
      store, host, () => ({}) as never,
      noop, noop, noop, noop, noop, noop, noop, noop, noop, noop,
      noop, noop, noop, noop,
      () => manifest({ api: runnableRepo() }), // the manager's manifest getter
    );

    mgr.openDashboard(t.id);

    const message = panels[0]!.posted.find((m: any) => m.type === 'state') as any;
    expect(message.state.sharedServers).toHaveLength(1);
    expect(message.state.sharedServers[0]).toMatchObject({
      service: 'api',
      status: 'running',
      port: 4000,
      baseBranch: 'develop',
    });
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/ui/dashboard/state.test.ts src/ui/dashboard/panel.test.ts`
Expected: FAIL — `state.sharedServers` is `undefined` (state test) and the panel posts no `sharedServers` (panel test). TypeScript may also flag the extra argument in `state.test.ts`; that is the same failure.

- [ ] **Step 3: Write the implementation**

In `src/ui/dashboard/stateTypes.ts`, extend the store import at line 1:

```ts
import type { SharedServerView } from '../../store/sharedServers.js';
```

and add after `servers: ServerView[];` (line 228):

```ts
  /**
   * The shared (baseline) services this ticket consumes, read-only — one copy
   * per repository, cut from the base branch (`store/sharedServers.ts`).
   * `servers` keeps its OWN meaning: the rows this ticket runs in its worktrees,
   * the only rows the header ops and row lifecycle actions act on.
   */
  sharedServers: SharedServerView[];
```

In `src/ui/dashboard/state.ts`, add the type import beside the other dashboard type imports:

```ts
import type { SharedServerView } from '../../store/sharedServers.js';
```

append the parameter after `displayBlocking?: { … }` (line 225-228), just before the closing `): DashboardState {`:

```ts
  /**
   * The shared services this ticket consumes (`store/sharedServers.ts`). Built
   * host-side because it needs the manifest and the live store; injected for
   * the same reason as `serviceNames` — this builder never reads the manifest.
   * Absent → no shared rows, exactly the pre-feature panel.
   * Appended LAST so every existing positional caller keeps its argument positions.
   */
  sharedServersFor: (ticketId: number) => SharedServerView[] = () => [],
```

and add the field to the returned object immediately after `servers: serverRows,` (line 739):

```ts
    // The read-only half of the stack. Kept OUT of `servers` so no action that
    // already means "this ticket's services" silently widens to a shared one.
    sharedServers: sharedServersFor(ticketId),
```

In `src/ui/dashboard/panel.ts`, add the import:

```ts
import { listSharedServersByTicket, type SharedServerView } from '../../store/sharedServers.js';
```

add this private method above `pushSnapshot` (near the other private helpers):

```ts
  /**
   * The shared (baseline) services this ticket consumes — the read-only half of
   * its stack. Built here because the manager holds the live manifest getter;
   * `buildDashboardState` receives it as an injected fact like every other
   * manifest-derived row.
   */
  private sharedServersFor(ticketId: number): SharedServerView[] {
    const manifest = this.manifest?.();
    return manifest ? listSharedServersByTicket(this.store, manifest, ticketId) : [];
  }
```

and pass it as the final argument of the `buildDashboardState` call, after the `displayBlocking` object literal (line 557-563):

```ts
      // The shared half of the Servers panel (D203): manifest + store, so it
      // arrives as an injected provider and never from this builder.
      (id) => this.sharedServersFor(id),
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/ui/dashboard/state.test.ts src/ui/dashboard/panel.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ui/dashboard/stateTypes.ts src/ui/dashboard/state.ts src/ui/dashboard/panel.ts \
  src/ui/dashboard/state.test.ts src/ui/dashboard/panel.test.ts
git commit -m "feat(dashboard): carry shared services in the dashboard state"
```

---

### Task 4: The `open-resources` action (Manage)

**Files:**
- Modify: `src/ui/dashboard/messages.ts` (union, parse, route, `DashboardActions`)
- Modify: `src/ui/dashboard/webviewSend.ts` (sender)
- Modify: `src/extension.ts` (binding at the `DashboardActions` factory)
- Test: `src/ui/dashboard/messages.test.ts`, `src/ui/dashboard/webviewSend.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `WebviewMessage` variant `{ type: 'open-resources' }`; `DashboardActions.openResources(): void | Promise<void>`; `karstSend.openResources(requestId?)`.

- [ ] **Step 1: Write the failing test**

In `src/ui/dashboard/messages.test.ts`, add `openResources: vi.fn(),` to the `actions()` stub (next to `requestServerLogs`), and add this test after `'parses the panel-level server actions (no payload)'`:

```ts
  it('parses and dispatches open-resources, which carries no payload', () => {
    const a = actions();
    const parsed = parseWebviewMessage({ type: 'open-resources' });
    expect(parsed).toEqual({ type: 'open-resources' });
    // A forged companion field is dropped: this action names no target of its own.
    expect(parseWebviewMessage({ type: 'open-resources', serverId: 9 })).toEqual({
      type: 'open-resources',
    });
    if (parsed) routeAction(parsed, a);
    expect(a.openResources).toHaveBeenCalledTimes(1);
  });
```

In `src/ui/dashboard/webviewSend.test.ts`, inside `'posts the exact expected message for each sender'`, after the `stopServers` assertions:

```ts
    sender.openResources();
    expect(posted.at(-1)).toEqual({ type: 'open-resources' });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/ui/dashboard/messages.test.ts src/ui/dashboard/webviewSend.test.ts`
Expected: FAIL — `openResources` does not exist on the actions stub (TS error) and `sender.openResources` is not a function.

- [ ] **Step 3: Write the implementation**

`src/ui/dashboard/messages.ts`:

1. In `WebviewMessage`, after `| { type: 'stop-servers' }`:

```ts
  /**
   * Open the window's Resource Monitor — the Manage action on a SHARED service
   * row, where starting or stopping is deliberately absent (a stop affects every
   * other ticket). The follow-up project view repoints this at `karst.openServers`.
   */
  | { type: 'open-resources' }
```

2. In `parseWebviewMessage`, beside `case 'stop-servers':`:

```ts
    case 'open-resources':
      return { type: 'open-resources' };
```

3. In the `DashboardActions` interface, after `stopServers: () => void | Promise<void>;`:

```ts
  /** Open the Resource Monitor from a shared row's Manage action (no payload). */
  openResources: () => void | Promise<void>;
```

4. In `routeAction`, after `case 'stop-servers': return actions.stopServers();`:

```ts
    case 'open-resources':
      return actions.openResources();
```

`src/ui/dashboard/webviewSend.ts`, after `stopServers`:

```ts
    openResources: (requestId?: string) => send({ type: 'open-resources' }, requestId),
```

`src/extension.ts`, in the `DashboardActions` factory, after `stopServers`:

```ts
    // Shared service rows (D203) are read-only here; Manage opens the existing
    // Resource Monitor. The project view repoints this at `karst.openServers`.
    openResources: () => void vscode.commands.executeCommand('karst.openResources'),
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/ui/dashboard/messages.test.ts src/ui/dashboard/webviewSend.test.ts`
Expected: PASS.

Also run: `npm run -s typecheck`
Expected: PASS (`extension.ts` satisfies the widened `DashboardActions`).

- [ ] **Step 5: Commit**

```bash
git add src/ui/dashboard/messages.ts src/ui/dashboard/messages.test.ts \
  src/ui/dashboard/webviewSend.ts src/ui/dashboard/webviewSend.test.ts src/extension.ts
git commit -m "feat(dashboard): add a Manage action that opens the Resource Monitor"
```

---

### Task 5: Shared logs in the combined logs view

**Files:**
- Modify: `src/ui/dashboard/consoleOutput.ts` (constructor dep + `requestServerLogs`)
- Modify: `src/ui/dashboard/panel.ts` (supply the dep)
- Test: `src/ui/dashboard/consoleOutput.test.ts` (create)

**Interfaces:**
- Consumes: `listServersByTicket` (unchanged); `ServerLogsReader`.
- Produces: `DashboardConsole` constructor gains a 6th, optional argument `sharedLogServers: (ticketId: number) => Array<{ service: string; logPath: string | null }> = () => []`.

**Why:** the shared row's `Logs` action opens this one combined view. If the view only listed `listServersByTicket`, the button would name a log the panel then omits — the exact "dead end dressed as an available action" UI-R46/UI-R37 disallow. The `logPath` guard is what makes the button appear only when there is a file to show.

- [ ] **Step 1: Write the failing test**

Create `src/ui/dashboard/consoleOutput.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openStore, type Store } from '../../store/db.js';
import { createTicket } from '../../store/tickets.js';
import { DashboardConsole } from './consoleOutput.js';
import type { DashboardPanel } from './panelTypes.js';
import type { ServerLogsReader } from './serverLogsReader.js';

function fakeReader(): ServerLogsReader {
  return {
    readLogs: (servers: Array<{ service: string; logPath: string | null }>) => ({
      servers: servers.map((s) => ({ ...s, content: '', truncated: false })),
    }),
    startPolling: () => Promise.resolve(),
    stopPolling: () => {},
  } as unknown as ServerLogsReader;
}

describe('DashboardConsole server logs', () => {
  let store: Store;
  beforeEach(() => (store = openStore(':memory:')));
  afterEach(() => store.close());

  function addServer(ticketId: number | null, repo: string, logPath: string | null): void {
    store.db
      .prepare(
        `INSERT INTO servers (ticket_id, repo, host, port, pid, status, log_path)
         VALUES (?, ?, 'localhost', 4000, 7, 'running', ?)`,
      )
      .run(ticketId, repo, logPath);
  }

  it('lists the ticket’s own services and its shared services in one logs view', () => {
    const t = createTicket(store, { key: 'T-1', title: 't' });
    addServer(t.id, 'web', '/tmp/web.log');
    const posted: unknown[] = [];
    const panel: DashboardPanel = { postMessage: (m) => posted.push(m) } as unknown as DashboardPanel;

    const console = new DashboardConsole(
      store,
      () => panel,
      undefined,
      undefined,
      fakeReader(),
      () => [{ service: 'api', logPath: '/tmp/api.log' }],
    );
    console.requestServerLogs(t.id);

    expect(posted[0]).toMatchObject({
      type: 'server-logs',
      servers: [
        { service: 'web', logPath: '/tmp/web.log' },
        { service: 'api', logPath: '/tmp/api.log' },
      ],
    });
    console.closeServerLogs(t.id);
  });

  it('does not list a shared service twice when the ticket also runs that key', () => {
    const t = createTicket(store, { key: 'T-1', title: 't' });
    addServer(t.id, 'web', '/tmp/web.log');
    const posted: unknown[] = [];
    const panel: DashboardPanel = { postMessage: (m) => posted.push(m) } as unknown as DashboardPanel;

    const console = new DashboardConsole(
      store,
      () => panel,
      undefined,
      undefined,
      fakeReader(),
      () => [{ service: 'web', logPath: '/tmp/shared-web.log' }],
    );
    console.requestServerLogs(t.id);
    console.closeServerLogs(t.id);

    expect((posted[0] as { servers: unknown[] }).servers).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/ui/dashboard/consoleOutput.test.ts`
Expected: FAIL — the 6th constructor argument is not accepted, and the second `api` row is absent from the message.

- [ ] **Step 3: Write the implementation**

`src/ui/dashboard/consoleOutput.ts`:

```ts
export class DashboardConsole {
  constructor(
    private readonly store: Store,
    private readonly panelFor: (ticketId: number) => DashboardPanel | undefined,
    private readonly stageLogReader: StageLogReader | undefined,
    private readonly agentLogReader: AgentLogReader | undefined,
    private readonly serverLogsReader: ServerLogsReader | undefined,
    /**
     * The shared (baseline) services the ticket consumes, as log sources. The
     * combined logs view is the target of a shared row's Logs action, so it must
     * carry those rows too — otherwise the button names a log the view omits.
     */
    private readonly sharedLogServers: (
      ticketId: number,
    ) => Array<{ service: string; logPath: string | null }> = () => [],
  ) {}
```

and in `requestServerLogs` replace the two lines that build `logServers`:

```ts
    const servers = listServersByTicket(this.store, ticketId);
    // The ticket's own rows first, then every shared service of its stack. Keyed
    // by unit name, so a name already present is kept once: the ticket's own row
    // is the one its cwd and status describe.
    const logServers = servers.map((s) => ({ service: s.service, logPath: s.logPath }));
    const seen = new Set(logServers.map((s) => s.service));
    for (const shared of this.sharedLogServers(ticketId)) {
      if (seen.has(shared.service)) continue;
      seen.add(shared.service);
      logServers.push(shared);
    }
```

`src/ui/dashboard/panel.ts`, in the `DashboardConsole` construction (lines 274-280), append:

```ts
      // Shared rows' Logs action opens this same combined view, so its data
      // arrives from the SAME provider the state uses (D203).
      (id) => this.sharedServersFor(id).map((s) => ({ service: s.service, logPath: s.logPath })),
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/ui/dashboard/consoleOutput.test.ts src/ui/dashboard/panel.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ui/dashboard/consoleOutput.ts src/ui/dashboard/consoleOutput.test.ts \
  src/ui/dashboard/panel.ts
git commit -m "feat(dashboard): include shared service logs in the combined logs view"
```

---

### Task 6: The Resource Monitor stop confirmation names live dependents

**Files:**
- Modify: `src/ui/resources/panel.ts` (dep type + message)
- Test: `src/ui/resources/panel.test.ts`

**Interfaces:**
- Consumes: Task 1's `BaselineDependent` and `isLiveBaselineDependent`-filtered `baselineDependentsFor`.
- Produces: `ResourcesPanelDeps.baselineDependents?: (serverId: number) => BaselineDependent[]`.

**Copy:** a done ticket that is still running is named as such (`PROJ-7 (done, still running)`), because the dependency is real — the shared copy is what its live stack is wired to — even though the ticket is finished. `baselineDependentsFor` has already dropped archived tickets and done tickets with nothing running, so the count and the names are exactly the tickets the stop would affect.

- [ ] **Step 1: Write the failing test**

In `src/ui/resources/panel.test.ts`, add the type import:

```ts
import type { BaselineDependent } from '../../store/baselineRefs.js';
```

and a helper near the top of the file:

```ts
function dependent(ticketId: number, over: Partial<BaselineDependent> = {}): BaselineDependent {
  return {
    ticketId,
    key: `PROJ-${ticketId}`,
    title: null,
    stageCurrent: 'impl',
    archived: false,
    hasRunningService: true,
    ...over,
  };
}
```

Then replace the values in the three existing tests that return `[7, 12]` / `[7]`:

```ts
      baselineDependents: () => [dependent(7), dependent(12)],
```

```ts
      baselineDependents: () => [dependent(7)],
```

```ts
      baselineDependents: () => [dependent(7, { key: null })],
```

The `'falls back to T<id> for a dependent with no resolvable key'` test no longer needs `ticketIdentity: () => new Map()`; keep it (harmless) or delete that line, the fallback now comes from the row's null `key`.

Add a new test after `'confirms with a baseline message naming the dependent ticket KEYS'`:

```ts
  it('marks a done ticket that is still running, since stopping would break its stack', async () => {
    const m = fakeMonitor();
    const p = fakePanel();
    const confirm = vi.fn(async (_message: string) => true);
    const manager = new ResourcesPanelManager(hostFor(p.panel), {
      monitor: m.monitor,
      disk: fakeDisk().disk,
      worktreePaths: () => [],
      confirm,
      baselineDependents: () => [
        dependent(7, { stageCurrent: 'done', hasRunningService: true }),
        dependent(12),
      ],
    });
    manager.open();
    p.receive({ type: 'kill-server', serverId: 1, requestId: 'k1-abc' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const [message] = confirm.mock.calls[0]!;
    expect(message).toContain('PROJ-7 (done, still running)');
    expect(message).toContain('PROJ-12');
    expect(message).not.toContain('PROJ-12 (');
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/ui/resources/panel.test.ts`
Expected: FAIL — the typed dep rejects the old `number[]` values, and the new marker is absent.

- [ ] **Step 3: Write the implementation**

In `src/ui/resources/panel.ts`, add the import:

```ts
import type { BaselineDependent } from '../../store/baselineRefs.js';
```

change the dep:

```ts
  /**
   * The tickets a baseline stop would affect: the LIVE dependents of the
   * baseline behind this server row (`store/baselineRefs.ts` — archived tickets
   * and done tickets with nothing running are already filtered out). `[]` when
   * the row is not a baseline.
   */
  baselineDependents?: (serverId: number) => BaselineDependent[];
```

and replace the label computation in `killServer`:

```ts
          const dependents = this.deps.baselineDependents?.(serverId) ?? [];
          // Name the KEYS the user can match against their board, never the raw
          // `tickets.id`. A done ticket is named with the reason it still counts:
          // its own running stack is what the shared copy is wired to, so a bare
          // key next to unfinished tickets would read as a stale ref.
          const labels = dependents.map((d) => {
            const key = d.key ?? formatId('ticket', d.ticketId);
            return d.stageCurrent === 'done' && d.hasRunningService
              ? `${key} (done, still running)`
              : key;
          });
```

`formatId` stays imported (the `T<id>` fallback). `ticketIdentity` stays in the deps because the attributed rows still use it (line ~222).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/ui/resources/panel.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ui/resources/panel.ts src/ui/resources/panel.test.ts
git commit -m "fix(resources): name only the live dependents a baseline stop would break"
```

---

### Task 7: The Servers panel — two groups in one grid

**Files:**
- Modify: `src/ui/dashboard/webview.html` (CSS block near line 1669; `panelOps`, `serversEmpty` untouched, new `sharedRow`, rewritten `renderServers` near line 3964)
- Test: `src/ui/dashboard/webview.test.ts`

**Interfaces:**
- Consumes: `state.servers` (`ServerView[]`) and Task 3's `state.sharedServers` (`SharedServerView[]`); the actions from Tasks 4-5 (`open-resources`, `server-logs-request`, `open-server`).
- Produces: the rendered Servers panel and its accessible names.

**Layout contract:** ONE `<table>`; each group is a `<tr class="srvgroup">` caption row (`<th scope="colgroup" colspan="5">`) followed by its rows. Captions: `Ticket services` + count + "run from this ticket's worktrees"; `Shared services` + count + "one copy per repository, from the base branch". Shared rows are **read-only**: no `start-server`, `restart-server`, `stop-server`, `spin-servers`, `restart-servers`, or `stop-servers` in the shared group.

- [ ] **Step 1: Write the failing test**

In `src/ui/dashboard/webview.test.ts`, add a helper next to the servers-panel tests (near line 1191) and the tests below it:

```ts
  /** A state with both halves: two ticket services and three shared rows. */
  function sharedServersState(): DashboardState {
    return {
      ...renderStateFor('scope'),
      hasRunnableRepos: true,
      servers: [
        { id: 7, ticketId: 1, service: 'web', host: 'localhost', port: 5173, status: 'running', logPath: '/tmp/web.log' },
        { id: 8, ticketId: 1, service: 'worker', host: null, port: null, status: 'stopped', logPath: null },
      ],
      sharedServers: [
        {
          id: 21, service: 'api', status: 'running', host: 'localhost', port: 4000,
          logPath: '/tmp/api.log', container: null, baseBranch: 'develop',
          checkoutPath: '/repos/api/.karst/baseline/api',
          sharedWith: 'shared with T412, T418', missingReason: null, dependents: [],
        },
        {
          id: 22, service: 'web', status: 'stopped', host: null, port: null,
          logPath: '/tmp/shared-web.log', container: null, baseBranch: 'main',
          checkoutPath: '/repos/web/.karst/baseline/web',
          sharedWith: 'no other live tickets', missingReason: null, dependents: [],
        },
        {
          id: null, service: 'api/v2', status: 'missing', host: null, port: null,
          logPath: null, container: null, baseBranch: null, checkoutPath: null,
          sharedWith: 'no other live tickets', missingReason: 'no longer declared in karst.yml',
          dependents: [],
        },
      ],
    };
  }

  it('renders ticket services and shared services as two captioned groups in one grid', () => {
    const h = bootPreviewHarness();
    h.receive({ type: 'state', state: sharedServersState() });
    const html = h.htmlOf('servers');

    expect(html).toContain('Ticket services');
    expect(html).toContain('run from this ticket');
    expect(html).toContain('Shared services');
    expect(html).toContain('one copy per repository, from the base branch');
    // One grid: exactly one table and one scroll region.
    expect(html.match(/<table>/g)).toHaveLength(1);
    expect(html.match(/class="scroll"/g)).toHaveLength(1);
    // Counts: 2 ticket rows, 3 shared rows, and the header counts everything.
    expect(h.textOf('srvCount')).toBe('5');
    expect(html).toMatch(/Ticket services<\/span><span class="gcount">2</);
    expect(html).toMatch(/Shared services<\/span><span class="gcount">3</);
  });

  it('shows a shared row’s base branch, live dependents, address and read-only actions', () => {
    const h = bootPreviewHarness();
    h.receive({ type: 'state', state: sharedServersState() });
    const html = h.htmlOf('servers');

    expect(html).toContain('develop');
    expect(html).toContain('shared with T412, T418');
    expect(html).toContain('no other live tickets');
    expect(html).toContain('localhost:4000');
    expect(html).toContain('data-act="open-resources"');
    expect(html).toContain('Manage shared services');
    // Open only on the running shared row, and it names that baseline row.
    expect(html).toContain('data-act="open-server" data-id="21"');
    expect(html).not.toContain('data-act="open-server" data-id="22"');
  });

  it('keeps every lifecycle control off the shared rows', () => {
    const h = bootPreviewHarness();
    h.receive({ type: 'state', state: sharedServersState() });
    const html = h.htmlOf('servers');
    const sharedGroup = html.slice(html.indexOf('Shared services'));

    expect(sharedGroup).not.toContain('data-act="start-server"');
    expect(sharedGroup).not.toContain('data-act="restart-server"');
    expect(sharedGroup).not.toContain('data-act="stop-server"');
    expect(sharedGroup).not.toContain('data-act="spin-servers"');
    expect(sharedGroup).not.toContain('data-act="restart-servers"');
    expect(sharedGroup).not.toContain('data-act="stop-servers"');
  });

  it('says the shared half is stopped or missing in words, never by colour alone', () => {
    const h = bootPreviewHarness();
    h.receive({ type: 'state', state: sharedServersState() });
    const html = h.htmlOf('servers');

    expect(html).toContain('<span class="offword">stopped</span>');
    expect(html).toContain('<span class="offword">missing</span>');
    expect(html).toContain('no longer declared in karst.yml');
    // The status word rides the dot too (screen reader + hover).
    expect(html).toContain('role="img" aria-label="stopped" title="stopped"');
  });

  it('names the header ops as ticket-services ops', () => {
    const h = bootPreviewHarness();
    h.receive({ type: 'state', state: sharedServersState() });
    const header = h.htmlOf('srvOps');

    expect(header).toContain('Start all ticket services');
    expect(header).toContain('Restart all ticket services');
    expect(header).toContain('Stop all ticket services');
    expect(header).not.toContain('Start all services');
    // They still post the ticket-scoped actions.
    expect(header).toContain('data-act="spin-servers"');
    expect(header).toContain('data-act="stop-servers"');
  });

  it('offers Logs on a shared row only when it has a log file', () => {
    const h = bootPreviewHarness();
    h.receive({ type: 'state', state: sharedServersState() });
    const html = h.htmlOf('servers');

    // api: running + logPath; web: stopped + logPath; api/v2: missing, no log.
    const sharedGroup = html.slice(html.indexOf('Shared services'));
    expect(sharedGroup.match(/data-act="server-logs-request"/g)).toHaveLength(2);
    // The api/v2 row has no log and therefore no Logs button: split the group on
    // its rows and check the last one alone.
    const rows = sharedGroup.split('<tr>');
    expect(rows.at(-1)).not.toContain('data-act="server-logs-request"');
  });

  it('renders shared rows with a “No ticket services” caption instead of the empty state', () => {
    const h = bootPreviewHarness();
    const state: DashboardState = {
      ...renderStateFor('scope'),
      hasRunnableRepos: true,
      servers: [],
      sharedServers: [sharedServersState().sharedServers[0]!],
    };
    h.receive({ type: 'state', state });
    const html = h.htmlOf('servers');

    expect(html).toContain('No ticket services');
    expect(html).toContain('Shared services');
    expect(html).not.toContain('No servers running');
    // The header's ticket ops stay, disabled with a reason.
    expect(h.htmlOf('srvOps')).toContain('No ticket services to restart');
  });

  it('keeps today’s two empty states when there are no rows at all', () => {
    const h = bootPreviewHarness();
    h.receive({
      type: 'state',
      state: { ...renderStateFor('scope'), hasRunnableRepos: false, servers: [], sharedServers: [] },
    });
    expect(h.htmlOf('servers')).toContain('No runnable services in scope');

    h.receive({
      type: 'state',
      state: { ...renderStateFor('scope'), hasRunnableRepos: true, servers: [], sharedServers: [] },
    });
    expect(h.htmlOf('servers')).toContain('No servers running');
  });

  it('wraps the shared meta line rather than truncating it', () => {
    // UI-R44: the branch and "shared with" text are the row's whole meaning, so
    // the meta line wraps. The long list survives in full in the DOM.
    const long = Array.from({ length: 12 }, (_, i) => `T${400 + i}`).join(', ');
    const h = bootPreviewHarness();
    h.receive({
      type: 'state',
      state: {
        ...renderStateFor('scope'),
        hasRunnableRepos: true,
        servers: [],
        sharedServers: [
          { ...sharedServersState().sharedServers[0]!, sharedWith: `shared with ${long}` },
        ],
      },
    });
    expect(h.htmlOf('servers')).toContain(`shared with ${long}`);
    expect(HTML).toMatch(/\.svpanel td\.c-name \.srvmeta\{[^}]*white-space:normal/);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/ui/dashboard/webview.test.ts`
Expected: FAIL — the page still renders the one-group table, no "Ticket services" caption, and the header says "Start all services".

- [ ] **Step 3: Write the implementation**

**(a) CSS.** In `src/ui/dashboard/webview.html`, after the line `.svpanel td .g{display:inline-flex;gap:var(--k-space-1);justify-content:flex-end}`, insert:

```css
  /* Two groups, ONE grid (D203): the ticket's own services, then the shared ones
     it consumes. The caption row names and counts its group and says where those
     rows run, so a shared row can never be read as the ticket's own — and both
     groups share one set of columns, so the eye scans down either. */
  .svpanel tr.srvgroup th{position:static;padding:var(--k-space-3) var(--k-space-5);
    background:var(--k-surface-hover);border-bottom:var(--k-border-w) solid var(--k-border);
    border-top:var(--k-border-w) solid var(--k-border);text-align:left;
    font-size:var(--k-text-2xs);font-weight:var(--k-weight-semibold);text-transform:uppercase;
    color:var(--k-text-dim);white-space:normal}
  /* A flex row, not inline spans: a wrapped inline element's bounding box spans
     every line it broke across, which reads as an overlap to the layout gate
     (and visually collides at narrow widths). Flex items wrap as boxes. */
  .svpanel tr.srvgroup .gwrap{display:flex;flex-wrap:wrap;align-items:baseline;
    gap:var(--k-space-2)}
  .svpanel tr.srvgroup .gcount{font-variant-numeric:tabular-nums}
  .svpanel tr.srvgroup .gnote{font-weight:var(--k-weight-normal);text-transform:none}
  /* The shared row's meta line WRAPS (UI-R44): the branch and "shared with" text
     are the row's whole meaning, so they are never ellipsised. Only the name
     ellipsises, and its cell carries the full value as a title. Flex for the
     same bounding-box reason as the caption; the chip is shrinkable so a branch
     name wraps rather than escaping a narrow column. */
  .svpanel td.c-name .srvmeta{display:flex;flex-wrap:wrap;align-items:baseline;
    gap:var(--k-space-2);font-size:var(--k-text-sm);color:var(--k-text-dim);
    line-height:1.45;white-space:normal;overflow-wrap:anywhere}
  .svpanel td.c-name .srvmeta .srvbranch{flex:0 1 auto;min-width:0;
    white-space:normal;overflow-wrap:anywhere}
  .svpanel td.c-name .srvmeta .srvnote{min-width:0}
  .svpanel td.c-addr .offword{font-style:normal;color:var(--k-text-dim)}
  .svpanel .srvnone{font-size:var(--k-text-sm);font-style:italic;color:var(--k-text-dim)}
```


**(b) Header copy.** Replace the body of `panelOps` (lines 3898-3918) with:

```js
  function panelOps(state) {
    // Nothing in scope can ever run: these would be permanent dead affordances,
    // so they are absent rather than disabled.
    if (state.hasRunnableRepos === false) return '';
    // TICKET-scoped, always and only. The panel also lists shared rows now, and
    // a header button that reached those would stop another ticket's stack — so
    // every word says which half it acts on.
    const list = state.servers;
    const sharedCount = (state.sharedServers || []).length;
    const none = list.length === 0;
    const anyOffline = list.some((s) => !isOnline(s));
    const anyRunning = list.some(isOnline);
    const startWhy = !none && !anyOffline ? 'Every ticket service is already running' : null;
    const restartWhy = none ? 'No ticket services to restart' : null;
    const stopWhy = !anyRunning ? 'No ticket service is running' : null;
    return iact('spin-servers', null, 'Start all ticket services', 'player-play', startWhy)
      + iact('restart-servers', null, 'Restart all ticket services', 'refresh', restartWhy)
      + iact('stop-servers', null, 'Stop all ticket services', 'player-stop', stopWhy)
      + iact('server-logs-request', null, 'View server logs', 'terminal-2',
          none && sharedCount === 0 ? 'No services to show logs for' : null)
      // Env overrides are a property of the TICKET, not of a running process:
      // they are set before anything starts and applied at the next spin, so
      // this stays available when every row is offline and when there are no
      // rows at all — the states where it is most likely to be wanted.
      + iact('env-overrides-open', null, 'Configure environment variables', 'settings');
  }
```

**(c) Shared rows.** After `serverRow` (line 3962), add:

```js
  /** A shared row's status, in words — the dot is never the only carrier. */
  const sharedWord = (s) =>
    s.status === 'running' ? 'running'
      : s.status === 'failed' ? 'failed'
        : s.status === 'missing' ? 'missing'
          : 'stopped';

  /**
   * One shared (baseline) row: read-only. Open exists only while it runs; Logs
   * only when it has a file; Manage is always there (the Resource Monitor today,
   * the project view's Servers command after the follow-up). There is no
   * start/stop/restart here on purpose — a stop affects every other ticket, so
   * it lives behind the project view's host confirm (UI-R33).
   */
  function sharedRow(s) {
    const on = isOnline(s);
    const word = sharedWord(s);
    const fault = s.status === 'failed' || s.status === 'missing';
    const dot = `<span class="glyph ${on ? 'on' : fault ? 'failed' : 'off'}" role="img"`
      + ` aria-label="${word}" title="${word}"></span>`;
    // An offline shared row has no usable address: the column reads "—" AND the
    // word, so a user who cannot see the dot's colour still reads the state.
    const addr = on
      ? `<span class="full">${esc(addrOf(s))}</span><span class="short">:${esc(s.port)}</span>`
      : `— <span class="offword">${esc(word)}</span>`;
    const addrTitle = on ? esc(addrOf(s)) : `${word} — no address`;
    const meta = (s.baseBranch ? `<span class="srvbranch k-chip">${esc(s.baseBranch)}</span>` : '')
      + (s.missingReason
        ? `<span class="srvnote">${esc(s.missingReason)}</span>`
        : `<span class="srvnote">${esc(s.sharedWith)}</span>`);
    const open = on && s.id != null
      ? iact('open-server', s.id, 'Open in browser', 'external-link')
      : '';
    const logs = s.logPath
      ? iact('server-logs-request', null, 'View server logs', 'terminal-2')
      : '';
    return `<tr><td class="c-dot">${dot}</td>`
      + `<td class="c-name"><span class="srvname" title="${esc(s.service)}">${esc(s.service)}</span>`
      + `<span class="srvmeta">${meta}</span></td>`
      + `<td class="c-addr${on ? '' : ' off'}" title="${addrTitle}">${addr}</td>`
      + `<td class="c-addrops"><span class="g">${open}</span></td>`
      + `<td class="c-acts"><span class="g">${logs}`
      + iact('open-resources', null, 'Manage shared services', 'settings')
      + `</span></td></tr>`;
  }

  /** One group's caption row: name, count and where its rows run. */
  function serverGroupHead(label, count, note) {
    return `<tr class="srvgroup"><th colspan="5" scope="colgroup"><div class="gwrap">`
      + `<span class="gname">${label}</span>`
      + `<span class="gcount">${count}</span>`
      + `<span class="gnote">${note}</span></div></th></tr>`;
  }
```

**(d) `renderServers`.** Replace lines 3964-3993 with:

```js
  function renderServers(state) {
    const ticketRows = state.servers;
    const sharedRows = state.sharedServers || [];
    const total = ticketRows.length + sharedRows.length;
    el('srvCount').textContent = total ? `${total}` : '';
    el('srvOps').innerHTML = panelOps(state);
    if (!total) {
      // No rows at all keeps today's two distinct states: a PROMPT (nothing is
      // running — Start fixes that) versus a STATEMENT (nothing here can run).
      el('servers').innerHTML = serversEmpty(state);
      return;
    }
    // The filter earns its row only once scanning is actually hard, and it
    // filters BOTH groups by the same needle.
    const needle = srvFilter.trim().toLowerCase();
    const filterable = total > 6;
    const bar = filterable
      ? `<div class="filter"><label class="sr" for="srvFilter">Filter services</label>`
        + `<input id="srvFilter" class="k-input" type="search" placeholder="Filter ${total} services…"`
        + ` value="${esc(srvFilter)}" data-filter></div>`
      : '';
    const hit = (s) => !filterable || !needle || s.service.toLowerCase().includes(needle);
    const ticketShown = ticketRows.filter(hit);
    const sharedShown = sharedRows.filter(hit);
    const groups = [];
    if (filterable && needle && ticketShown.length === 0 && sharedShown.length === 0) {
      groups.push(`<tr><td colspan="5"><div class="nomatch">No service matches`
        + ` “${esc(srvFilter)}”.</div></td></tr>`);
    } else {
      if (ticketShown.length > 0) {
        groups.push(serverGroupHead('Ticket services', ticketShown.length,
          "run from this ticket's worktrees") + ticketShown.map(serverRow).join(''));
      } else if (ticketRows.length === 0) {
        // A shared half alone is a truthful stack. It must not fall back to
        // "No servers running", which would deny the rows printed below it.
        groups.push(serverGroupHead('Ticket services', 0, "run from this ticket's worktrees")
          + `<tr><td colspan="5"><span class="srvnone">No ticket services</span></td></tr>`);
      }
      if (sharedShown.length > 0) {
        groups.push(serverGroupHead('Shared services', sharedShown.length,
          'one copy per repository, from the base branch')
          + sharedShown.map(sharedRow).join(''));
      }
    }
    // The address-ops column sits UNDER the Address header (colspan 2): Open is
    // part of the address, so the header says so.
    el('servers').innerHTML = `${bar}<div class="scroll"><table>`
      + `<thead><tr><th scope="col"><span class="sr">Status</span></th>`
      + `<th scope="col">Service</th><th scope="col" colspan="2">Address</th>`
      + `<th scope="col" style="text-align:right">Actions</th></tr></thead>`
      + `<tbody>${groups.join('')}</tbody></table></div>`;
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/ui/dashboard/webview.test.ts`
Expected: PASS (including the pre-existing servers-panel test, which still sees `start-server` on the offline ticket row and no `data-id` on the header's spin).

- [ ] **Step 5: Commit**

```bash
git add src/ui/dashboard/webview.html src/ui/dashboard/webview.test.ts
git commit -m "feat(dashboard): show shared services beside ticket services"
```

---

### Task 8: Fixtures, the visual variant, and the sweeps

**Files:**
- Modify: `src/ui/dashboard/renderFixtures.ts` (neutral state field + `sharedServerFixtures()`)
- Modify: `tests/visual/variants.ts` (new variant)
- New baselines: `tests/visual/__baselines__/{dark,light,hc}/dashboard--shared-services.png`

**Interfaces:**
- Consumes: `SharedServerView` (Task 2).
- Produces: `sharedServerFixtures(): SharedServerView[]`.

- [ ] **Step 1: Write the failing test**

In `src/ui/dashboard/renderFixtures.test.ts`, add:

```ts
  it('pins a shared-services corpus state with a live and an offline shared row', () => {
    const rows = sharedServerFixtures();
    expect(rows.map((r) => r.status)).toEqual(['running', 'stopped']);
    expect(rows[0]!.baseBranch).toBe('develop');
    expect(rows[0]!.sharedWith).toContain('shared with');
    expect(rows[1]!.sharedWith).toBe('no other live tickets');
    // Fixture rows are inert: every id sits in the reserved 900001–999999 band.
    for (const r of rows) expect(r.id === null || (r.id >= 900001 && r.id <= 999999)).toBe(true);
  });
```

Add `sharedServerFixtures` to that file's import from `./renderFixtures.js`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/ui/dashboard/renderFixtures.test.ts`
Expected: FAIL — `sharedServerFixtures` is not exported.

- [ ] **Step 3: Write the implementation**

In `src/ui/dashboard/renderFixtures.ts`, add the type import:

```ts
import type { SharedServerView } from '../../store/sharedServers.js';
```

add `sharedServers: [],` immediately after `servers: [],` in `renderStateFor` (line 1049), and add after `populatedServers()` (line 1120):

```ts
/**
 * Two shared services for the D203 corpus: one running from `develop` and shared
 * with two other live tickets, one stopped and consumed by this ticket alone.
 * `fixture:`-prefixed paths and ids in the reserved fixture band, like every
 * other row in this file — pure data, no store reads.
 */
export function sharedServerFixtures(): SharedServerView[] {
  return [
    {
      id: 942101,
      service: 'api',
      status: 'running',
      host: 'localhost',
      port: 4000,
      logPath: 'fixture:logs/shared-api.log',
      container: null,
      baseBranch: 'develop',
      checkoutPath: 'fixture:/repos/api/.karst/baseline/api',
      sharedWith: 'shared with T942018, T942019',
      missingReason: null,
      dependents: [],
    },
    {
      id: 942102,
      service: 'web',
      status: 'stopped',
      host: null,
      port: null,
      logPath: null,
      container: null,
      baseBranch: 'main',
      checkoutPath: 'fixture:/repos/web/.karst/baseline/web',
      sharedWith: 'no other live tickets',
      missingReason: null,
      dependents: [],
    },
  ];
}
```

In `tests/visual/variants.ts`, import `sharedServerFixtures` from the renderFixtures import block (line 19), and add the variant after `sandbox-on`:

```ts
  // D203: the Servers panel's read-only shared half — one running from the base
  // branch, one stopped — beside the ticket's own rows.
  variant('dashboard', 'shared-services', dashboardScenario('running', 2, (s) => ({
    ...s,
    sharedServers: sharedServerFixtures(),
  }))),
```

- [ ] **Step 4: Run the unit test, then record and verify the visual variant**

Run: `npx vitest run src/ui/dashboard/renderFixtures.test.ts`
Expected: PASS.

Run: `npm run -s typecheck:visual`
Expected: PASS.

Run: `npm run -s test:visual:docker:update 2>&1 | tail -20`
Expected: the sweep records the missing snapshot(s) and exits 0.

Then classify every baseline the update touched:

```bash
git status --short tests/visual/__baselines__
```

- **`dashboard-*`/`dashboard--*` changes are expected.** The "Ticket services" caption row is a NEW row in the Servers panel, so every dashboard state that shows servers renders differently. Keep those.
- **The new `dashboard--shared-services.png`** (dark only — `variant()` defaults to `DARK_ONLY`) is expected.
- **Anything else is host churn, not this change.** The implementer of this plan observed `status-primitives.png` rewritten in three themes on a fresh container checkout; revert those (`git checkout -- <path>`) and never commit them.

```bash
git status --short tests/visual/__baselines__ | awk '$1=="M"{print $2}' \
  | grep -v '/dashboard' | xargs -r git checkout --
```

Run: `npm run -s test:visual:docker 2>&1 | tail -40`
Expected: PASS for every dashboard baseline, including `dashboard--shared-services`. Pre-existing non-dashboard diffs (observed: `status-primitives`) stay red; they are the advisory CI job, not this change — do not re-record them.

Run: `npm run -s test:layout:docker 2>&1 | tail -40`
Expected: PASS. A NEW `dashboard/shared-services` route needs its known dashboard-wide failures backfilled (the ledger's `seed` refuses once the file exists, and `prune` only removes). This is the same backfill #722 performed for every variant route, and it is allowed ONLY for entries whose `(width, check, selector)` already exists for a sibling dashboard route:

```bash
node - <<'JS'
const fs = require('node:fs');
const ledgerPath = 'tests/visual/layout-known-failures.json';
const ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
const report = JSON.parse(fs.readFileSync('tests/visual/.layout-report.json', 'utf8'));
const sib = new Set(ledger.filter((k) => k.startsWith('dashboard/') && !k.startsWith('dashboard/shared-services|'))
  .map((k) => k.split('|').slice(1).join('|')));
const add = report.failures
  .filter((f) => f.route === 'dashboard/shared-services')
  .filter((f) => sib.has([f.width, f.check, f.selector].join('|')))
  .map((f) => `dashboard/shared-services|${f.width}|${f.check}|${f.selector}`);
const merged = [...new Set([...ledger, ...add])].sort();
fs.writeFileSync(ledgerPath, `${JSON.stringify(merged, null, 2)}\n`);
console.log(`backfilled ${add.length} sibling-identical entr(ies)`);
JS
```

If any `dashboard/shared-services` failure is NOT matched by a sibling, it is a real layout bug in the new rows: fix the CSS, never backfill it.

- [ ] **Step 5: Commit**

```bash
git add src/ui/dashboard/renderFixtures.ts src/ui/dashboard/renderFixtures.test.ts \
  tests/visual/variants.ts tests/visual/__baselines__
git commit -m "test(visual): add the shared-services dashboard variant"
```

---

### Task 9: Document the read model and run the full gates

**Files:**
- Modify: `docs/arch/worktrees-and-servers.md` (new keyed block + one Rules line in `WT-00`)
- Modify: `docs/arch/system-map.md` (generated)
- Verify only: everything else

- [ ] **Step 1: Add the keyed block**

Append to `docs/arch/worktrees-and-servers.md` (keep the block format exactly; the `END_DOC_BLOCK` id must match the `##` id):

```markdown
## [@arch:SHARED-VIEW] A ticket's Servers panel reads BOTH halves of its stack, and only the ticket half is controllable
covers: src/store/sharedServers.ts#listSharedServersByTicket, src/store/baselineRefs.ts#listBaselineDependentsDetailed, src/ui/dashboard/state.ts#buildDashboardState

`listServersByTicket` answers only what the TICKET runs (`servers.ticket_id = <id>`). A stack also consumes SHARED baseline services — one copy per repository, cut from the base branch, `servers.ticket_id IS NULL` — and a panel that omits them shows half the stack and cannot say the API is running from `develop` rather than from the ticket's branch.

`store/sharedServers.ts` joins each of the ticket's `baseline_refs` edges to its baseline row (`servers.repo = ref.repo AND ticket_id IS NULL AND kind = 'service'`; a running row wins over a retained stopped one). The manifest resolves the base branch and the shared checkout — `baselineCheckoutDir(repoPath, REPOSITORY_NAME)`, one checkout per repository shared by its sibling services, not one per unit key. A ref whose unit left `karst.yml` renders `missing` with "no longer declared in karst.yml"; it never throws, because a panel must be able to describe a wiring that no longer resolves.

Who counts as affected (`listBaselineDependentsDetailed` + `isLiveBaselineDependent`): `live = !archived && (stageCurrent !== 'done' || hasRunningService)`. A done ticket counts only while it still runs a service of its own — the shared copy is what that live stack is wired to, so stopping it breaks the stack. An archived ticket never counts: its worktrees are gone. The Resource Monitor's stop confirmation names exactly the live dependents and marks a done-but-running one, so the count a human confirms is the count a stop would break.

The refs themselves are NEVER deleted on done or archive: `runtime/startOne.ts` reads `baseline_refs` to avoid re-pointing a baseline dependency to an alt port. The read model filters; it does not write. Shared rows are read-only in the ticket dashboard (Open when running, Logs when a log exists, Manage to the Resource Monitor) — a stop affects other tickets and belongs behind the project view's host confirm (UI-R33). `DashboardState.servers` keeps its ticket-only meaning so no existing action widens silently; `DashboardState.sharedServers` carries the other half.
END_DOC_BLOCK: [@arch:SHARED-VIEW]
```

- [ ] **Step 2: Reference it from the overview**

In `docs/arch/worktrees-and-servers.md`, in `[@arch:WT-00]`'s Rules table row (the last line of the block), append `· @arch:SHARED-VIEW` to the list, and add one line under Connections:

```
- out: @arch:SHARED-VIEW — a ticket's recorded baseline refs feed the dashboard's read-only shared-service rows.
```

- [ ] **Step 3: Regenerate the system map**

Run: `npm run -s docs:graph`
Then: `git diff --stat docs/arch/system-map.md`
Expected: the new module appears in the map. Commit the regenerated file (never hand-edit it).

- [ ] **Step 4: Run the full gates**

```bash
npm run -s typecheck
npm run -s lint:react
npm run -s test:unit 2>&1 | tail -20
npm run -s test:integration 2>&1 | tail -20
```

Expected: all PASS. If `test:integration` fails in the dashboard render integration test, re-run just that file:
`npx vitest run --config vitest.integration.config.ts src/ui/dashboard/render.render.integration.test.ts`

- [ ] **Step 5: Commit**

```bash
git add docs/arch/worktrees-and-servers.md docs/arch/system-map.md
git commit -m "docs(arch): record the shared-services read model"
```

---

## Execution notes (what the gates changed)

Recorded after the plan was executed, so the next reader knows which parts were revised under a gate rather than at design time.

1. **Inline spans vs flex (Task 7).** The first render used inline `<span>`s for the group caption and the shared meta line. The layout gate read a wrapped inline element's multi-line bounding box as a `sibling-overlap` (group caption at 480 px, meta chip/note at 699-900 px). Both are now flex rows with a wrap and a gap; the branch chip is shrinkable so a long branch name wraps inside a narrow name column instead of escaping it. No layout-ledger entry was created for either.
2. **Contrast (Task 7).** `--k-text-faint` on `--k-surface-hover` failed WCAG AA in the light theme (2.13:1). The caption and the "No ticket services" note now use `--k-text-dim`.
3. **Existing dashboard baselines DO change (Task 8).** The caption row is a new visible row, so every dashboard state that shows servers is re-recorded. Only `dashboard*` baselines are legitimate; a fresh container also rewrote `status-primitives.png` (three themes) with no code change — that is host churn, revert it.
4. **New layout route needs a ledger backfill (Task 8).** `dashboard/shared-services` reports the same known dashboard-wide failures as its siblings (rail segment overlap, PR row overlap, `#ticketDataClose` off-viewport) under a new route key. `seed` refuses an existing ledger and `prune` only removes, so the 89 sibling-identical keys were appended (the #722 precedent). Zero unmatched failures remained, which is the proof no new layout bug was accepted.
5. **`extension.ts` line ratchet.** The `openResources` binding fits the recorded cap only without a comment: the file sat one line under `MAX_EXTENSION_LINES`. That is why the binding is bare in the factory.

## Self-Review

**1. Spec coverage**

| Spec requirement | Task |
|---|---|
| `listBaselineDependentsDetailed` with all six fields | 1 |
| `live` rule (archived never; done only while running) | 1 |
| Refs kept (no delete on done/archive) | 1 (filter only), documented in 9 |
| `listSharedServersByTicket` with unit key/display name/status/host/port/logPath/container/checkout/base branch/dependents | 2 |
| Ref not in manifest → `missing` + reason, never throw | 2 |
| `sharedServers` on dashboard state, built in `state.ts`, `servers` unchanged | 3 |
| Reuse detailed dependents in `baselineDependentsFor` for the Resource Monitor; done-but-running marked | 1 + 6 |
| ONE grid, two groups with captions/counts/notes | 7 |
| Shared meta: branch chip, `shared with …` / "no other live tickets", offline `—` + "stopped" | 2 (wording) + 7 (render) |
| Shared actions Open (running)/Logs (logPath)/Manage (`karst.openResources`), no lifecycle | 4, 5, 7 |
| Header ops ticket-scoped, accessible names/titles say "ticket services" | 7 |
| Empty states: shared-only → "No ticket services"; no rows + non-runnable; no rows + runnable | 7 |
| Wrap, don't truncate the meta (UI-R44); identifiers may ellipsis with a reachable title | 7 |
| Unit tests: no row → missing; done+stopped/done+running/archived; dedup; renamed out of manifest | 1, 2 |
| Render tests: groups, counts, empty states, offline/failed/missing, long lists | 7 |
| Fixtures + corpus state with shared rows | 8 |
| `test:visual:docker` + `test:layout:docker`, never edit baselines/ledger | 8 |

Non-goals respected: no control of shared services in this panel (Task 7 omits every lifecycle action and a test asserts it); no lifecycle policy; no change to hot-vs-baseline spin decisions.

**2. Placeholder scan**

No "TBD"/"similar to Task N"/"add error handling" placeholders. Every implementation step carries the code; every test step carries the assertions. The one intentionally open item is external: if `test:layout:docker` reports a NEW failure, the instruction is to report it, not to edit the ledger (a policy, not a missing value).

**3. Type consistency**

- `BaselineDependent` — defined in Task 1, used verbatim in Tasks 2, 6.
- `isLiveBaselineDependent` — Task 1 name, used in Task 2 only.
- `SharedServerView` — Task 2 fields (`id`, `service`, `status`, `host`, `port`, `logPath`, `container`, `baseBranch`, `checkoutPath`, `sharedWith`, `missingReason`, `dependents`) match the state field in Task 3, the view reads in Task 7, the fixtures in Task 8, and the tests in Tasks 2, 3, 7, 8.
- `buildDashboardState` parameter order: `sharedServersFor` is appended LAST (23rd) everywhere it is passed (Task 3 panel call and state test).
- `DashboardConsole` sixth parameter is `sharedLogServers`, supplied once in `panel.ts` (Task 5).
- `ResourcesPanelDeps.baselineDependents` is `(serverId) => BaselineDependent[]` in Task 6; `extension.ts`'s existing binding (`baselineDependentsFor`) already returns that type.
- Wire action is `open-resources` in `messages.ts`, `webviewSend.ts`, `webview.html`'s `SEND_BY_ACT`, and the test assertions (Task 4, Task 7).
