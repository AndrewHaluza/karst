# Per-Ticket Gate Disable Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user disable individual named UAT/review gates for ONE ticket, so a flaky or broken gate stops blocking that ticket without editing the global `karst.yml` and without restarting the session.

**Architecture:** A new nullable `tickets.disabled_gates` JSON column (per-stage name arrays) is read at gate-resolution time and applied as a pure filter over `resolveGates`'s OUTPUT — `workflow/gates/resolve.ts` itself stays untouched, so the declared/discovered resolution keeps exactly one meaning. Each removed gate still gets an append-only `gate_runs` row carrying a new `skipped` flag, so evidence records what did NOT run instead of leaving a silent hole. The dashboard grows a "Gates" section that resolves the real gate names host-side (async, filesystem probe) and posts a per-name toggle through the existing `routeAction`/`action-result` seam.

**Tech Stack:** TypeScript (ESM, `moduleResolution: Bundler`, `.js` import suffixes), vitest, better-sqlite3 (extension) + `node:sqlite` (CLI), standalone webview HTML with marker-injected design system.

## Global Constraints

Copied verbatim from the project's CLAUDE.md and the spec; every task's requirements implicitly include these.

- **Schema checklist (all four in lockstep):** `src/store/schema.sql` (fresh DBs) + a guarded ALTER in `src/store/migrations.ts` + bump `SCHEMA_VERSION` + update `src/store/db.test.ts` version/table assertions.
- **`SCHEMA_VERSION` is currently `23`, not 22.** The spec says "migration v23"; that number is already taken by `review_findings`. **This feature is v24.** Every `toBe(23)` in `db.test.ts` (22 occurrences) becomes `toBe(24)`.
- **Migrations never backfill data they cannot derive.** A pre-v24 `gate_runs` row has `skipped` NULL; NULL means unknown/not-skipped and is never guessed.
- **Guards read the CURRENT columns** via `tableColumns(db, table)`, so a fresh DB skips the ALTER and a re-open is a no-op.
- **`gate_runs` is append-only evidence.** Rows are written only from inside `commitGateOutcome`'s transaction; nothing deletes or updates them.
- **`resolveGates` (`src/workflow/gates/resolve.ts`) is NOT modified.** The per-ticket cut is a filter applied to its output.
- **`exit_code IS NULL` already means "repo defines no such script (NOT a pass)".** A skipped gate must never reuse that fact — that is why `skipped` is its own column.
- **Immutability:** never mutate a `ResolvedGate`, a `GateRun`, or a `DisabledGates` object; return new objects (`{...old, field}`).
- **Type widening only for actions:** `DashboardActions` methods are `() => void | Promise<void>`.
- **UI-R11–R14:** every posting control shows pending on click (`aria-busy` + `disabled`), cannot be re-triggered, and settles on a terminal `action-result`; the runtime watchdog reports "unknown", never a false failure.
- **UI-R04/R05:** only `--k-*` tokens as style values — no hex, no raw px, in any CSS this plan adds.
- **Mirrored TS→HTML constants are behavior.** This plan adds exactly one new mirror: the `skip` entry in the webview's `OP_GLYPH` map, pinned by a test in `src/ui/dashboard/webview.test.ts`.
- **Commands:** `npx vitest run <file>` for a single suite, `npm test` for all, `npm run typecheck` for `tsc --noEmit`. Conventional commits.

---

## File Structure

**Created:**
- `src/store/ticketGates.ts` — the per-ticket disabled-gate override: read, per-stage scoped write, tolerant JSON parse. Mirrors `store/ticketTypes.ts`'s role as the small vocabulary module for a nullable per-ticket column.
- `src/store/ticketGates.test.ts`
- `src/workflow/gates/disable.ts` — the pure partition of a resolved gate list into kept + skipped by name. No store, no manifest.
- `src/workflow/gates/disable.test.ts`
- `src/ui/dashboard/gateOptions.ts` — host-side async resolution of the gate names a ticket's stages would actually run, for the panel's Gates section.
- `src/ui/dashboard/gateOptions.test.ts`

**Modified:**
- `src/store/schema.sql` — two columns.
- `src/store/migrations.ts` — `SCHEMA_VERSION = 24` + the v24 step.
- `src/store/db.test.ts` — version assertions + new column assertions.
- `src/store/gateRuns.ts` — `skipped` through `GateRun`, `GateRunInput`, `rowToGateRun`, `recordGateRun`, `listGateRuns`.
- `src/workflow/stages/uat.ts` — `resolveTargetGates` gains `disabledNames`; the run reads the ticket's list and records skipped rows.
- `src/workflow/review/gates.ts` — `resolveReviewGates` gains `disabledNames`.
- `src/workflow/stages/review.ts` — same call-site threading as uat.
- `src/workflow/uat/aggregate.ts` — `aggregateUat` learns that "everything was disabled" is a pass, not `nothing-to-run`.
- `src/workflow/review/aggregate.ts` — same, via `AggregateReviewOpts`.
- `src/model/inside/types.ts` — `OpStatus` gains `'skip'`.
- `src/model/inside/gates.ts` — a skipped row renders "Skipped — disabled by user".
- `src/context/ticketContext.ts` — the CLI's gate list carries `skipped`.
- `src/ui/dashboard/messages.ts` — `set-disabled-gates` message + action + parse + route.
- `src/ui/dashboard/panel.ts` — pushes `gate-options` like it pushes `worktree-stats`.
- `src/ui/dashboard/webview.html` — Gates section, toggles, `OP_GLYPH.skip`, `.op.skip` CSS.
- `src/ui/dashboard/webview.test.ts` — pins the new mirror.
- `src/extension.ts` — binds the two new host dependencies.

---

## Open questions flagged for the user (do NOT decide these silently)

These are recorded here because the spec takes a position that conflicts with an existing invariant, or names a file that turns out to be the wrong seam. **Phase 3 Task 9 and Phase 4 Task 12 are the ones affected.** If the user overrules, the change is local to those tasks.

1. **"Every gate disabled" as a PASS.** The spec says a stage that resolved to zero gates *because the user disabled them all* is "still a pass". `aggregateUat` currently states the opposite as its central rule: *"Not a pass. 'Nothing ran' means the stage asked nothing, and converting that into green is the bug this whole design exists to close."* This plan implements the spec (Task 9), narrowly: the pass requires that at least one gate was disabled AND no gate resolved for any other reason, and it always carries a warning naming the disabled gates. The safer alternative — park with `nothing-to-run` and a reason naming the user's own disable — is one line different. **Confirm before merging.**
2. **`model/stagePalette.ts` is the wrong file for a "skipped" state.** That module is the stage→color map (`scope`…`done`), not an evidence-row vocabulary. The row vocabulary is `OpStatus` in `src/model/inside/types.ts`. This plan adds `'skip'` there and leaves `stagePalette.ts` untouched.
3. **The Gates section needs an async, filesystem-touching resolution.** `buildDashboardState` is synchronous and store-only by design, but the *resolved* gate names need a `package.json` probe per worktree. This plan therefore pushes them on their own message (`gate-options`), exactly mirroring `pushWorktreeStats`, rather than making state-building async. The panel shows nothing in the section until that message lands.
4. **Disabling a gate does not retroactively change a recorded verdict.** A ticket already parked or failed on a gate must still be re-run (existing Resume/retry controls) for the disable to matter. No task in this plan changes that.

---

# Phase 1 — Storage

## Task 1: Migration v24 — `tickets.disabled_gates` and `gate_runs.skipped`

**Files:**
- Modify: `src/store/schema.sql`
- Modify: `src/store/migrations.ts`
- Test: `src/store/db.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: two columns. `tickets.disabled_gates TEXT` (JSON object, NULL = nothing disabled). `gate_runs.skipped INTEGER` (1 = deliberately not run, NULL/0 = ran or pre-v24). `SCHEMA_VERSION === 24`.

- [ ] **Step 1: Write the failing tests**

In `src/store/db.test.ts`, add two new tests near the existing column tests (the ones that read `PRAGMA table_info('tickets')`):

```ts
  it('carries the v24 per-ticket disabled-gates column', () => {
    const store = openStore(':memory:');
    const cols = (store.db.prepare("PRAGMA table_info('tickets')").all() as { name: string }[])
      .map((c) => c.name);
    expect(cols).toContain('disabled_gates');
  });

  it('carries the v24 skipped column on gate_runs', () => {
    const store = openStore(':memory:');
    const cols = (store.db.prepare("PRAGMA table_info('gate_runs')").all() as { name: string }[])
      .map((c) => c.name);
    expect(cols).toContain('skipped');
  });

  it('migrates a v23 database to v24 without losing gate rows', () => {
    const path = join(tmpdir(), `karst-v23-${Date.now()}.db`);
    const legacy = new Database(path);
    legacy.exec(readFileSync('src/store/schema.sql', 'utf8'));
    legacy.exec("ALTER TABLE tickets DROP COLUMN disabled_gates");
    legacy.exec("ALTER TABLE gate_runs DROP COLUMN skipped");
    legacy.exec(
      "INSERT INTO tickets (id, key, title) VALUES (1, 'K-1', 'legacy')",
    );
    legacy.exec(
      "INSERT INTO gate_runs (ticket_id, stage_key, attempt, run_at, gate_name, exit_code)" +
        " VALUES (1, 'uat', 1, '2026-01-01T00:00:00.000Z', 'test', 0)",
    );
    legacy.pragma('user_version = 23');
    legacy.close();

    const migrated = openStore(path);
    expect(migrated.db.pragma('user_version', { simple: true })).toBe(24);
    const cols = (migrated.db.prepare("PRAGMA table_info('gate_runs')").all() as { name: string }[])
      .map((c) => c.name);
    expect(cols).toContain('skipped');
    const row = migrated.db.prepare('SELECT gate_name, skipped FROM gate_runs').get() as {
      gate_name: string;
      skipped: number | null;
    };
    expect(row.gate_name).toBe('test');
    expect(row.skipped).toBeNull(); // never backfilled
    migrated.db.close();
    rmSync(path, { force: true });
  });
```

Match the file's existing import list and helper style for `Database`/`join`/`tmpdir`/`readFileSync`/`rmSync` — the suite already opens legacy databases this way for v11–v18; copy the closest existing legacy-migration test's setup verbatim rather than inventing a new one. If the file's helpers make `ALTER TABLE … DROP COLUMN` awkward (older SQLite), build the legacy tables with explicit `CREATE TABLE` DDL omitting the two new columns, exactly as the v15/v16 tests do.

Then change every `expect(...pragma('user_version', { simple: true })).toBe(23)` in the file to `toBe(24)` — there are 22 of them.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/store/db.test.ts`
Expected: FAIL — `expected [ ... ] to contain 'disabled_gates'`, and the version assertions read 23 instead of 24.

- [ ] **Step 3: Add the columns to `schema.sql`**

In `src/store/schema.sql`, inside `CREATE TABLE IF NOT EXISTS tickets (…)`, after the v15 `type` line and before `created_at`:

```sql
  -- v24 per-ticket gate disable (kept in sync with migrations.ts v24 ALTER):
  disabled_gates    TEXT,                 -- JSON {"uat":["e2e"],"review":["lint"]}; NULL = nothing disabled
```

Inside `CREATE TABLE IF NOT EXISTS gate_runs (…)`, after the `args` line:

```sql
  skipped       INTEGER               -- v24: 1 = resolved but deliberately not run (user disabled it for
                                      -- this ticket). NULL/0 = it ran, or a pre-v24 row. DISTINCT from
                                      -- exit_code IS NULL, which means the repo defines no such script.
```

- [ ] **Step 4: Add the v24 migration step**

In `src/store/migrations.ts`, change line 9 to `export const SCHEMA_VERSION = 24;` and add, immediately before `db.pragma(\`user_version = ${SCHEMA_VERSION}\`)`:

```ts
  if (current < 24) {
    // v24 makes a gate disable-able for ONE ticket. Two columns, both nullable,
    // both guarded like every other column addition — a fresh DB already carries
    // them via schema.sql and a re-open is a no-op.
    //
    // `tickets.disabled_gates` is the override itself, shaped exactly like the
    // nullable `model`/`type` columns before it: absent means "no override,
    // run whatever resolution produced".
    //
    // `gate_runs.skipped` is deliberately NOT `exit_code IS NULL` reused. That
    // already means "the repo defines no such script (NOT a pass)"; a gate that
    // exists and was deliberately not run is a different fact, and conflating
    // them would make a disabled gate read as an absent script.
    //
    // NOTHING IS BACKFILLED. No historical row was ever skipped — the feature
    // did not exist — so NULL is the truthful answer, not 0 asserted as fact.
    const ticketCols = tableColumns(db, 'tickets');
    if (ticketCols.size > 0 && !ticketCols.has('disabled_gates')) {
      db.exec('ALTER TABLE tickets ADD COLUMN disabled_gates TEXT');
    }
    const gateRunCols24 = tableColumns(db, 'gate_runs');
    if (gateRunCols24.size > 0 && !gateRunCols24.has('skipped')) {
      db.exec('ALTER TABLE gate_runs ADD COLUMN skipped INTEGER');
    }
  }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/store/db.test.ts`
Expected: PASS, including the table-count test (no new table was added, so `creates all 15 registry tables` is unchanged).

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: PASS. Any other suite asserting `user_version` must be updated to 24 the same way.

- [ ] **Step 7: Commit**

```bash
git add src/store/schema.sql src/store/migrations.ts src/store/db.test.ts
git commit -m "feat: v24 schema for per-ticket gate disable"
```

---

## Task 2: `store/ticketGates.ts` — read and per-stage write

**Files:**
- Create: `src/store/ticketGates.ts`
- Test: `src/store/ticketGates.test.ts`

**Interfaces:**
- Consumes: `tickets.disabled_gates` (Task 1), `Store` from `./db.js`.
- Produces:
  - `type GateStage = 'uat' | 'review'`
  - `interface DisabledGates { uat: readonly string[]; review: readonly string[] }`
  - `function getDisabledGates(store: Store, ticketId: number): DisabledGates`
  - `function setDisabledGates(store: Store, ticketId: number, stage: GateStage, names: readonly string[]): void`

- [ ] **Step 1: Write the failing test**

Create `src/store/ticketGates.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { openStore } from './db.js';
import { createTicket } from './tickets.js';
import { getDisabledGates, setDisabledGates } from './ticketGates.js';

function ticket(store: ReturnType<typeof openStore>): number {
  return createTicket(store, { key: 'K-1', title: 'A ticket', source: 'manual' }).id;
}

describe('ticketGates', () => {
  it('reads empty lists for a ticket that has disabled nothing', () => {
    const store = openStore(':memory:');
    expect(getDisabledGates(store, ticket(store))).toEqual({ uat: [], review: [] });
  });

  it('round-trips one stage', () => {
    const store = openStore(':memory:');
    const id = ticket(store);
    setDisabledGates(store, id, 'uat', ['e2e']);
    expect(getDisabledGates(store, id)).toEqual({ uat: ['e2e'], review: [] });
  });

  it('writes only the named stage, leaving the other untouched', () => {
    const store = openStore(':memory:');
    const id = ticket(store);
    setDisabledGates(store, id, 'uat', ['e2e']);
    setDisabledGates(store, id, 'review', ['lint']);
    expect(getDisabledGates(store, id)).toEqual({ uat: ['e2e'], review: ['lint'] });
  });

  it('clears a stage back to empty without touching the other', () => {
    const store = openStore(':memory:');
    const id = ticket(store);
    setDisabledGates(store, id, 'uat', ['e2e']);
    setDisabledGates(store, id, 'review', ['lint']);
    setDisabledGates(store, id, 'uat', []);
    expect(getDisabledGates(store, id)).toEqual({ uat: [], review: ['lint'] });
  });

  it('deduplicates and drops blank names on write', () => {
    const store = openStore(':memory:');
    const id = ticket(store);
    setDisabledGates(store, id, 'uat', ['e2e', 'e2e', '  ', 'lint']);
    expect(getDisabledGates(store, id).uat).toEqual(['e2e', 'lint']);
  });

  it('degrades a corrupted column to empty lists instead of throwing', () => {
    const store = openStore(':memory:');
    const id = ticket(store);
    store.db.prepare('UPDATE tickets SET disabled_gates = ? WHERE id = ?').run('{not json', id);
    expect(getDisabledGates(store, id)).toEqual({ uat: [], review: [] });
  });

  it('ignores non-string entries and unknown stage keys in stored JSON', () => {
    const store = openStore(':memory:');
    const id = ticket(store);
    store.db
      .prepare('UPDATE tickets SET disabled_gates = ? WHERE id = ?')
      .run(JSON.stringify({ uat: ['e2e', 3, null], ship: ['nope'] }), id);
    expect(getDisabledGates(store, id)).toEqual({ uat: ['e2e'], review: [] });
  });

  it('is a no-op for an unknown ticket id', () => {
    const store = openStore(':memory:');
    setDisabledGates(store, 9999, 'uat', ['e2e']);
    expect(getDisabledGates(store, 9999)).toEqual({ uat: [], review: [] });
  });
});
```

If `createTicket`'s signature in `src/store/tickets.ts` differs (it takes a project scope option), copy the exact call shape used by `src/store/ticketTypes.test.ts` or `src/store/gateRuns.test.ts`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/store/ticketGates.test.ts`
Expected: FAIL — `Cannot find module './ticketGates.js'`.

- [ ] **Step 3: Write the implementation**

Create `src/store/ticketGates.ts`:

```ts
import type { Store } from './db.js';

/**
 * The stages whose gate list a ticket may cut. Deliberately narrower than
 * `StageKey`: only `uat` and `review` resolve gates at all, so a wider type
 * would let a caller ask a question that has no answer.
 */
export const GATE_STAGES = ['uat', 'review'] as const;
export type GateStage = (typeof GATE_STAGES)[number];

/**
 * Which named gates this ticket has switched off, per stage.
 *
 * An empty array is the whole meaning of "nothing disabled" — there is no
 * separate absent state, exactly as an absent `tickets.model` means "inherit".
 * The lists are gate NAMES, matched against `ResolvedGate.name` after
 * resolution; they never name a command, so a disable can never smuggle one in.
 */
export interface DisabledGates {
  uat: readonly string[];
  review: readonly string[];
}

const EMPTY: DisabledGates = { uat: [], review: [] };

/** Names, trimmed, de-blanked and deduplicated, order preserved. */
function normalizeNames(names: readonly unknown[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of names) {
    if (typeof raw !== 'string') continue;
    const name = raw.trim();
    if (name.length === 0 || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

/**
 * Parse the stored JSON, tolerating bad data — same house convention as
 * `parseArgs` in `gateRuns.ts` and `parseSelectedRepos` in `tickets.ts`: data
 * this module writes is always well-formed, so this guards the boundary, not
 * the writer. A corrupted column must degrade to "nothing disabled" (which runs
 * MORE gates, never fewer) rather than take the stage or the panel down.
 */
function parseDisabled(raw: string | null): DisabledGates {
  if (raw === null) return EMPTY;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return EMPTY;
    const obj = parsed as Record<string, unknown>;
    const pick = (stage: GateStage): string[] =>
      Array.isArray(obj[stage]) ? normalizeNames(obj[stage] as unknown[]) : [];
    return { uat: pick('uat'), review: pick('review') };
  } catch {
    return EMPTY;
  }
}

/** What this ticket has switched off. Never throws; an unknown id reads empty. */
export function getDisabledGates(store: Store, ticketId: number): DisabledGates {
  const row = store.db
    .prepare('SELECT disabled_gates FROM tickets WHERE id = ?')
    .get(ticketId) as { disabled_gates: string | null } | undefined;
  return row ? parseDisabled(row.disabled_gates) : EMPTY;
}

/**
 * Replace ONE stage's list, leaving the other stage's exactly as it was.
 *
 * Scoped like the settings page's per-section save, and for the same reason: a
 * whole-object write from a panel that loaded before the other stage was
 * touched would silently revert it. The current value is re-read here, inside
 * the same statement pair, rather than trusted from the caller.
 */
export function setDisabledGates(
  store: Store,
  ticketId: number,
  stage: GateStage,
  names: readonly string[],
): void {
  const current = getDisabledGates(store, ticketId);
  const next: DisabledGates = { ...current, [stage]: normalizeNames(names) };
  // NULL rather than `{"uat":[],"review":[]}` when nothing is disabled: the
  // column's absent state and its empty state mean the same thing, and storing
  // one canonical form keeps every reader from having to know both.
  const empty = next.uat.length === 0 && next.review.length === 0;
  store.db
    .prepare('UPDATE tickets SET disabled_gates = ?, updated_at = datetime(\'now\') WHERE id = ?')
    .run(empty ? null : JSON.stringify({ uat: next.uat, review: next.review }), ticketId);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/store/ticketGates.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add src/store/ticketGates.ts src/store/ticketGates.test.ts
git commit -m "feat: per-ticket disabled-gate store accessor"
```

---

## Task 3: `gate_runs.skipped` through the store layer

**Files:**
- Modify: `src/store/gateRuns.ts`
- Test: `src/store/gateRuns.test.ts`

**Interfaces:**
- Consumes: the `skipped` column (Task 1).
- Produces: `GateRun.skipped: boolean`, `GateRunInput.skipped?: boolean`. `recordGateRun` writes `1` for `true` and `null` otherwise; `rowToGateRun` maps `1 → true`, everything else (`0`, `null`) → `false`.

- [ ] **Step 1: Write the failing test**

Append to `src/store/gateRuns.test.ts` (reuse whatever ticket-creation helper the file already has):

```ts
  it('records a skipped gate as skipped, with no exit code and no timing', () => {
    const store = openStore(':memory:');
    const ticketId = makeTicket(store);
    recordGateRun(store, {
      ticketId,
      stageKey: 'uat',
      attempt: 1,
      runAt: '2026-08-04T10:00:00.000Z',
      gates: [{ gateName: 'e2e', exitCode: null, skipped: true }],
    });
    const [row] = listGateRuns(store, ticketId);
    expect(row!.skipped).toBe(true);
    expect(row!.exitCode).toBeNull();
    expect(row!.startedAt).toBeNull();
    expect(row!.endedAt).toBeNull();
  });

  it('reads a gate that ran as not skipped', () => {
    const store = openStore(':memory:');
    const ticketId = makeTicket(store);
    recordGateRun(store, {
      ticketId,
      stageKey: 'uat',
      attempt: 1,
      runAt: '2026-08-04T10:00:00.000Z',
      gates: [{ gateName: 'test', exitCode: 0 }],
    });
    expect(listGateRuns(store, ticketId)[0]!.skipped).toBe(false);
  });

  it('reads a pre-v24 row (NULL skipped) as not skipped', () => {
    const store = openStore(':memory:');
    const ticketId = makeTicket(store);
    store.db
      .prepare(
        `INSERT INTO gate_runs (ticket_id, stage_key, attempt, run_at, gate_name, exit_code, skipped)
         VALUES (?, 'uat', 1, '2026-08-04T10:00:00.000Z', 'test', 0, NULL)`,
      )
      .run(ticketId);
    expect(listGateRuns(store, ticketId)[0]!.skipped).toBe(false);
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/store/gateRuns.test.ts`
Expected: FAIL — `Object literal may only specify known properties, 'skipped' does not exist in type 'GateRunInput'` at type level, and `expected undefined to be true` at runtime.

- [ ] **Step 3: Write the implementation**

In `src/store/gateRuns.ts`:

Add to `interface GateRun`, after `args`:

```ts
  /**
   * v24: this gate resolved for the ticket and was deliberately NOT run,
   * because the user disabled it for this ticket alone (`tickets.disabled_gates`).
   *
   * A different fact from `exitCode === null`, which means the repo defines no
   * such script. Conflating the two would make a disabled gate read as a
   * missing script (or the reverse), so this is its own column. `false` for
   * every row written before v24 — nothing was ever skipped then.
   */
  skipped: boolean;
```

Add to `interface GateRunInput`:

```ts
  /** v24: recorded because it was disabled for this ticket, not because it ran. */
  skipped?: boolean;
```

Add to `interface GateRunRow`: `skipped: number | null;`

In `rowToGateRun`'s returned object, add:

```ts
    // Strictly `1`. A NULL is a pre-v24 row and a 0 is an explicit "it ran";
    // both are "not skipped", and neither is guessed at.
    skipped: r.skipped === 1,
```

In `recordGateRun`, extend the INSERT column list and placeholders with `skipped` / `?`, and pass `g.skipped ? 1 : null` as the last bind value.

In `listGateRuns`, add `skipped` to the SELECT column list.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/store/gateRuns.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add src/store/gateRuns.ts src/store/gateRuns.test.ts
git commit -m "feat: record a deliberately skipped gate in gate_runs"
```

---

# Phase 2 — Resolution

## Task 4: `workflow/gates/disable.ts` — the pure partition

**Files:**
- Create: `src/workflow/gates/disable.ts`
- Test: `src/workflow/gates/disable.test.ts`

**Interfaces:**
- Consumes: `ResolvedGate` from `./resolve.js`.
- Produces:
  - `interface GatePartition { kept: ResolvedGate[]; skipped: ResolvedGate[] }`
  - `function partitionDisabled(gates: readonly ResolvedGate[], disabledNames: readonly string[]): GatePartition`

- [ ] **Step 1: Write the failing test**

Create `src/workflow/gates/disable.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { partitionDisabled } from './disable.js';
import type { ResolvedGate } from './resolve.js';

function gate(name: string, required = false): ResolvedGate {
  return { name, command: 'npm', args: ['run', name], script: name, required };
}

describe('partitionDisabled', () => {
  it('keeps everything when nothing is disabled', () => {
    const gates = [gate('test'), gate('e2e')];
    const { kept, skipped } = partitionDisabled(gates, []);
    expect(kept.map((g) => g.name)).toEqual(['test', 'e2e']);
    expect(skipped).toEqual([]);
  });

  it('removes a named gate and reports it as skipped', () => {
    const { kept, skipped } = partitionDisabled([gate('test'), gate('e2e')], ['e2e']);
    expect(kept.map((g) => g.name)).toEqual(['test']);
    expect(skipped.map((g) => g.name)).toEqual(['e2e']);
  });

  it('removes a REQUIRED gate too — an explicit disable outranks a declaration', () => {
    const { kept, skipped } = partitionDisabled([gate('lint', true)], ['lint']);
    expect(kept).toEqual([]);
    expect(skipped.map((g) => g.name)).toEqual(['lint']);
  });

  it('matches by exact name, never by prefix or case', () => {
    const { kept } = partitionDisabled([gate('test'), gate('test:integration')], ['test']);
    expect(kept.map((g) => g.name)).toEqual(['test:integration']);
    expect(partitionDisabled([gate('E2E')], ['e2e']).kept.map((g) => g.name)).toEqual(['E2E']);
  });

  it('ignores a disabled name no gate carries', () => {
    const { kept, skipped } = partitionDisabled([gate('test')], ['nope']);
    expect(kept.map((g) => g.name)).toEqual(['test']);
    expect(skipped).toEqual([]);
  });

  it('removes every gate sharing a disabled name', () => {
    const { skipped } = partitionDisabled([gate('test'), gate('test')], ['test']);
    expect(skipped).toHaveLength(2);
  });

  it('never mutates the input array or its gates', () => {
    const gates = [gate('test'), gate('e2e')];
    const snapshot = JSON.stringify(gates);
    partitionDisabled(gates, ['e2e']);
    expect(JSON.stringify(gates)).toBe(snapshot);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/workflow/gates/disable.test.ts`
Expected: FAIL — `Cannot find module './disable.js'`.

- [ ] **Step 3: Write the implementation**

Create `src/workflow/gates/disable.ts`:

```ts
import type { ResolvedGate } from './resolve.js';

/**
 * A resolved gate list cut by the ticket's own disable list.
 *
 * `skipped` is carried, never discarded: a gate that silently vanished would be
 * indistinguishable from one the repository never had, which is exactly the
 * conflation `gate_runs.skipped` exists to prevent. The caller records one row
 * per skipped gate so the evidence trail states what did not run and why.
 */
export interface GatePartition {
  kept: ResolvedGate[];
  skipped: ResolvedGate[];
}

/**
 * Split a RESOLVED gate list by name.
 *
 * Applied to `resolveGates`'s output rather than threaded into it on purpose:
 * `resolveGates` answers "what did the config declare, or the repo offer", and a
 * per-ticket cut is a different question asked afterwards. Keeping them apart is
 * what lets one function stay the single declared/discovered rule for both
 * stages.
 *
 * Matching is by EXACT name — the same string the user was shown and clicked.
 * No prefix, no case folding: `test` and `test:integration` are two gates, and a
 * fuzzy match would disable a gate nobody asked to disable.
 *
 * `required` is not respected. A declared gate whose script is missing is a
 * failure precisely because the config named a question the repo cannot answer —
 * but a per-ticket disable IS the user retracting that question, for this ticket
 * only, which is the whole feature.
 */
export function partitionDisabled(
  gates: readonly ResolvedGate[],
  disabledNames: readonly string[],
): GatePartition {
  if (disabledNames.length === 0) return { kept: [...gates], skipped: [] };
  const disabled = new Set(disabledNames);
  const kept: ResolvedGate[] = [];
  const skipped: ResolvedGate[] = [];
  for (const gate of gates) (disabled.has(gate.name) ? skipped : kept).push(gate);
  return { kept, skipped };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/workflow/gates/disable.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/workflow/gates/disable.ts src/workflow/gates/disable.test.ts
git commit -m "feat: pure partition of a resolved gate list by disabled name"
```

---

## Task 5: Thread `disabledNames` through both stage-level resolvers

**Files:**
- Modify: `src/workflow/stages/uat.ts` (the local `resolveTargetGates`, lines 80–110)
- Modify: `src/workflow/review/gates.ts` (`resolveReviewGates`, lines 54–84)
- Test: `src/workflow/review/gates.test.ts`, `src/workflow/stages/uat.test.ts`

**Interfaces:**
- Consumes: `partitionDisabled` (Task 4), `GateResolution` from `workflow/gates/resolve.js`.
- Produces: a new exported type and two changed signatures, identical in shape on both sides:

```ts
// src/workflow/gates/disable.ts (added in this task)
export type StageGateResolution =
  | { kind: 'gates'; gates: ResolvedGate[]; skipped: ResolvedGate[] }
  | { kind: 'unavailable'; blocker: BlockerKind; reason: string };

// src/workflow/stages/uat.ts — now EXPORTED so it is directly testable
export function resolveTargetGates(
  probe: ScriptProbe,
  config: UatConfig | undefined,
  names: readonly string[],
  disabledNames?: readonly string[],
): StageGateResolution;

// src/workflow/review/gates.ts
export function resolveReviewGates(
  probe: ScriptProbe,
  config: ReviewConfig | undefined,
  names: readonly string[],
  disabledNames?: readonly string[],
): StageGateResolution;
```

`disabledNames` is optional and defaults to `[]`, so every existing three-argument call site keeps compiling and keeps its exact behavior.

- [ ] **Step 1: Write the failing tests**

Add to `src/workflow/review/gates.test.ts` (reuse the file's existing `probe` fixture helper — an `{ kind: 'ok', scripts: {...} }` object):

```ts
  it('drops a disabled gate from the resolved list and reports it as skipped', () => {
    const probe = { kind: 'ok', scripts: { lint: 'eslint .', typecheck: 'tsc' } } as const;
    const res = resolveReviewGates(probe, undefined, ['api'], ['lint']);
    expect(res.kind).toBe('gates');
    if (res.kind !== 'gates') throw new Error('unreachable');
    expect(res.gates.map((g) => g.name)).toEqual(['typecheck']);
    expect(res.skipped.map((g) => g.name)).toEqual(['lint']);
  });

  it('reports an empty skipped list when nothing is disabled', () => {
    const probe = { kind: 'ok', scripts: { lint: 'eslint .' } } as const;
    const res = resolveReviewGates(probe, undefined, ['api']);
    if (res.kind !== 'gates') throw new Error('unreachable');
    expect(res.skipped).toEqual([]);
  });

  it('resolves to zero gates, all skipped, when every gate is disabled', () => {
    const probe = { kind: 'ok', scripts: { lint: 'eslint .' } } as const;
    const res = resolveReviewGates(probe, undefined, ['api'], ['lint']);
    if (res.kind !== 'gates') throw new Error('unreachable');
    expect(res.gates).toEqual([]);
    expect(res.skipped.map((g) => g.name)).toEqual(['lint']);
  });

  it('leaves an unavailable resolution untouched — a disable cannot make an unreadable repo readable', () => {
    const probe = { kind: 'io-error', message: 'EACCES' } as const;
    const res = resolveReviewGates(probe, undefined, ['api'], ['lint']);
    expect(res.kind).toBe('unavailable');
  });

  it('deduplicates skipped gates by name across repository entries sharing a worktree', () => {
    const probe = { kind: 'ok', scripts: { lint: 'eslint .' } } as const;
    const res = resolveReviewGates(probe, undefined, ['api', 'web'], ['lint']);
    if (res.kind !== 'gates') throw new Error('unreachable');
    expect(res.skipped.map((g) => g.name)).toEqual(['lint']);
  });
```

Add the same five tests to `src/workflow/stages/uat.test.ts` against the now-exported `resolveTargetGates`, using UAT's own probe scripts (`test`, `e2e`) instead of review's (`lint`, `typecheck`). Import it as `import { resolveTargetGates, runUat } from './uat.js';`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/workflow/review/gates.test.ts src/workflow/stages/uat.test.ts`
Expected: FAIL — `Expected 3 arguments, but got 4`, and `resolveTargetGates is not exported`.

- [ ] **Step 3: Add `StageGateResolution` to `disable.ts`**

Append to `src/workflow/gates/disable.ts`:

```ts
import type { BlockerKind } from '../../model/types.js';

/**
 * What a STAGE-level resolver answers, once the ticket's own disables are
 * applied. `GateResolution` (`gates/resolve.ts`) stays the config/probe answer;
 * this is that answer minus what the user switched off, and it carries the
 * difference rather than swallowing it.
 *
 * `unavailable` is unchanged and unreachable through a disable: karst could not
 * ASK this repository anything, which no per-ticket preference can alter.
 */
export type StageGateResolution =
  | { kind: 'gates'; gates: ResolvedGate[]; skipped: ResolvedGate[] }
  | { kind: 'unavailable'; blocker: BlockerKind; reason: string };
```

- [ ] **Step 4: Change `resolveReviewGates`**

In `src/workflow/review/gates.ts`: import `partitionDisabled` and `type StageGateResolution` from `../gates/disable.js`; add the fourth parameter `disabledNames: readonly string[] = []`; change the return type to `StageGateResolution`; and replace the final three lines of the function with:

```ts
  // The per-ticket cut is applied ONCE, over the union — not per name inside the
  // loop. The union is deduplicated by invocation identity, so filtering earlier
  // would report the same disabled gate several times for a worktree backing
  // several repository entries.
  const { kept, skipped } = partitionDisabled([...byIdentity.values()], disabledNames);
  if (kept.length > 0 || skipped.length > 0) return { kind: 'gates', gates: kept, skipped };
  // Zero gates, nothing disabled, and no unavailability is the malformed-
  // package.json case, which the caller turns into a named failure rather than
  // a park.
  return unavailable ?? { kind: 'gates', gates: [], skipped: [] };
```

- [ ] **Step 5: Change `resolveTargetGates` the same way**

In `src/workflow/stages/uat.ts`, apply the identical edit to `resolveTargetGates`, and add `export` to its declaration so the tests can reach it. Its return type becomes `StageGateResolution`; delete the now-unused `GateResolution` import if nothing else in the file uses it.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run src/workflow/review/gates.test.ts src/workflow/stages/uat.test.ts`
Expected: PASS.

- [ ] **Step 7: Typecheck and commit**

```bash
npm run typecheck
git add src/workflow/gates/disable.ts src/workflow/review/gates.ts src/workflow/stages/uat.ts \
        src/workflow/review/gates.test.ts src/workflow/stages/uat.test.ts
git commit -m "feat: apply per-ticket gate disables at each stage's resolution seam"
```

---

## Task 6: UAT reads the ticket's disables and records skipped rows

**Files:**
- Modify: `src/workflow/stages/uat.ts` (`runUat`, lines 112–248)
- Test: `src/workflow/stages/uat.test.ts`

**Interfaces:**
- Consumes: `getDisabledGates` (Task 2), `GateRunInput.skipped` (Task 3), `StageGateResolution` (Task 5).
- Produces: no new exports. `runUat` now writes one `gate_runs` row per skipped gate, per target, with `exitCode: null`, `startedAt: null`, `endedAt: null`, `skipped: true`, and the gate's real `repo`/`command`/`args` identity.

- [ ] **Step 1: Write the failing test**

Add to `src/workflow/stages/uat.test.ts` (use the file's existing `runUat` harness — the fake probe/runGates deps and tmp artifact dir it already builds):

```ts
  it('does not run a gate the ticket disabled', async () => {
    const store = openStore(':memory:');
    const ticketId = seedTicketAtUat(store);
    setDisabledGates(store, ticketId, 'uat', ['e2e']);
    const invoked: string[] = [];
    await runUat(store, { ticketId, cwd: '/repo', artifactDir: tmp() }, {
      probe: () => ({ kind: 'ok', scripts: { test: 'vitest', e2e: 'playwright' } }),
      runGates: async (gates) => {
        invoked.push(...gates.map((g) => g.name));
        return { kind: 'done', results: gates.map((g) => ({
          name: g.name, exitCode: 0, output: '', startedAt: 'a', endedAt: 'b',
        })) };
      },
    });
    expect(invoked).toEqual(['test']);
  });

  it('records the disabled gate as a skipped row beside the gates that ran', async () => {
    const store = openStore(':memory:');
    const ticketId = seedTicketAtUat(store);
    setDisabledGates(store, ticketId, 'uat', ['e2e']);
    await runUat(store, { ticketId, cwd: '/repo', artifactDir: tmp() }, {
      probe: () => ({ kind: 'ok', scripts: { test: 'vitest', e2e: 'playwright' } }),
      runGates: async (gates) => ({ kind: 'done', results: gates.map((g) => ({
        name: g.name, exitCode: 0, output: '', startedAt: 'a', endedAt: 'b',
      })) }),
    });
    const rows = listGateRuns(store, ticketId);
    const skipped = rows.filter((r) => r.skipped);
    expect(skipped).toHaveLength(1);
    expect(skipped[0]!.gateName).toContain('e2e');
    expect(skipped[0]!.exitCode).toBeNull();
    expect(skipped[0]!.startedAt).toBeNull();
    expect(rows.filter((r) => !r.skipped).map((r) => r.exitCode)).toEqual([0]);
  });

  it('a disabled gate never fails the stage', async () => {
    const store = openStore(':memory:');
    const ticketId = seedTicketAtUat(store);
    setDisabledGates(store, ticketId, 'uat', ['e2e']);
    const result = await runUat(store, { ticketId, cwd: '/repo', artifactDir: tmp() }, {
      probe: () => ({ kind: 'ok', scripts: { test: 'vitest', e2e: 'playwright' } }),
      runGates: async (gates) => ({ kind: 'done', results: gates.map((g) => ({
        name: g.name, exitCode: 0, output: '', startedAt: 'a', endedAt: 'b',
      })) }),
    });
    expect(result.kind).toBe('advanced');
  });
```

`seedTicketAtUat` and `tmp()` stand for whatever the suite already uses; do not add new helpers if equivalents exist.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/workflow/stages/uat.test.ts`
Expected: FAIL — `expected [ 'test', 'e2e' ] to equal [ 'test' ]`.

- [ ] **Step 3: Write the implementation**

In `src/workflow/stages/uat.ts`:

Import at the top:

```ts
import { getDisabledGates } from '../../store/ticketGates.js';
```

Inside `runUat`, after `const runAt = now();`:

```ts
  // Read from the store at RESOLUTION time, never from anything cached: a
  // toggle flipped mid-session must take effect on the very next gate run,
  // which is the same live-read property `opts.manifest`'s getter gives the
  // manifest itself.
  const disabledNames = getDisabledGates(store, opts.ticketId).uat;
```

Declare a second collector beside `entries`:

```ts
  // Kept OUT of `entries`: a skipped gate must not reach `aggregateUat` as an
  // entry, where an exit-code-null row reads as "the repo has no such script".
  // It is evidence, not a question that was asked.
  const skippedGates: GateRunInput[] = [];
```

In `finish`, build the recorded rows from both collectors:

```ts
    const gates = [
      ...entries.map<GateRunInput>((entry) => ({ /* unchanged */ })),
      ...skippedGates,
    ];
```

In the target loop, change the resolution call and add the skipped-row collection right after the `unavailable` guard:

```ts
    const resolution = resolveTargetGates(scriptProbe, opts.manifest?.uat, target.names, disabledNames);

    if (resolution.kind === 'unavailable') {
      const reason = `${label}: ${resolution.reason}`;
      return finish({ kind: 'blocked', blocker: resolution.blocker, reason }, [reason]);
    }

    // One row per gate the user switched off, carrying the identity it WOULD
    // have been invoked with. No timing and no exit code, because none exists —
    // `skipped` is what states the difference from a missing script.
    for (const gate of resolution.skipped) {
      skippedGates.push({
        gateName: `${gate.name} (${label})`,
        exitCode: null,
        startedAt: null,
        endedAt: null,
        repo: target.repo,
        command: gate.command,
        args: gate.args,
        skipped: true,
      });
      sections.push(`# ${gate.name} (${label}, skipped)\ndisabled for this ticket`);
    }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/workflow/stages/uat.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/workflow/stages/uat.ts src/workflow/stages/uat.test.ts
git commit -m "feat: uat skips a ticket's disabled gates and records them as evidence"
```

---

## Task 7: Review reads the ticket's disables and records skipped rows

**Files:**
- Modify: `src/workflow/stages/review.ts` (`runReview`, lines 95–303)
- Test: `src/workflow/stages/review.test.ts`

**Interfaces:**
- Consumes: `getDisabledGates` (Task 2), `StageGateResolution` (Task 5).
- Produces: no new exports; the same recorded-row shape Task 6 produces for uat, under `stageKey: 'review'`.

- [ ] **Step 1: Write the failing test**

Add to `src/workflow/stages/review.test.ts`, using the suite's existing `runReview` harness:

```ts
  it('does not run a review gate the ticket disabled', async () => {
    const store = openStore(':memory:');
    const ticketId = seedTicketAtReview(store);
    setDisabledGates(store, ticketId, 'review', ['lint']);
    const invoked: string[] = [];
    await runReview(store, { ticketId, cwd: '/repo', artifactDir: tmp() }, {
      probe: () => ({ kind: 'ok', scripts: { lint: 'eslint .', typecheck: 'tsc' } }),
      runGates: async (gates) => {
        invoked.push(...gates.map((g) => g.name));
        return { kind: 'done', results: gates.map((g) => ({
          name: g.name, exitCode: 0, output: '', startedAt: 'a', endedAt: 'b',
        })) };
      },
    });
    expect(invoked).not.toContain('lint');
  });

  it('records the disabled review gate as a skipped row', async () => {
    const store = openStore(':memory:');
    const ticketId = seedTicketAtReview(store);
    setDisabledGates(store, ticketId, 'review', ['lint']);
    await runReview(store, { ticketId, cwd: '/repo', artifactDir: tmp() }, {
      probe: () => ({ kind: 'ok', scripts: { lint: 'eslint .', typecheck: 'tsc' } }),
      runGates: async (gates) => ({ kind: 'done', results: gates.map((g) => ({
        name: g.name, exitCode: 0, output: '', startedAt: 'a', endedAt: 'b',
      })) }),
    });
    const skipped = listGateRuns(store, ticketId).filter((r) => r.skipped);
    expect(skipped.map((r) => r.stageKey)).toEqual(['review']);
    expect(skipped[0]!.gateName).toContain('lint');
  });

  it("a uat disable does not affect review's gates", async () => {
    const store = openStore(':memory:');
    const ticketId = seedTicketAtReview(store);
    setDisabledGates(store, ticketId, 'uat', ['lint']);
    const invoked: string[] = [];
    await runReview(store, { ticketId, cwd: '/repo', artifactDir: tmp() }, {
      probe: () => ({ kind: 'ok', scripts: { lint: 'eslint .' } }),
      runGates: async (gates) => {
        invoked.push(...gates.map((g) => g.name));
        return { kind: 'done', results: gates.map((g) => ({
          name: g.name, exitCode: 0, output: '', startedAt: 'a', endedAt: 'b',
        })) };
      },
    });
    expect(invoked).toContain('lint');
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/workflow/stages/review.test.ts`
Expected: FAIL — `expected [ 'lint', 'typecheck' ] not to contain 'lint'`.

- [ ] **Step 3: Write the implementation**

Apply exactly the Task 6 edits to `src/workflow/stages/review.ts`, with three differences: read `.review` instead of `.uat` from `getDisabledGates`; pass `disabledNames` as the fourth argument to `resolveReviewGates`; and place the skipped-row loop AFTER the existing `resolution.kind === 'unavailable'` block (which for review has two branches — the `nothing-to-run` `continue` and the `capability-missing` park — both unchanged).

The `finish` closure already appends the `changes` row after the mapped entries; append `...skippedGates` to the `gates` array before that `if (diffOpened)` line, so the changes row stays last.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/workflow/stages/review.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/workflow/stages/review.ts src/workflow/stages/review.test.ts
git commit -m "feat: review skips a ticket's disabled gates and records them as evidence"
```

---

## Task 8: A skipped gate never contributes to the verdict

**Files:**
- Test: `src/workflow/uat/aggregate.test.ts`, `src/workflow/review/aggregate.test.ts`

**Interfaces:**
- Consumes: `aggregateUat`, `aggregateReview` (unchanged signatures at this point).
- Produces: no code change if the tests pass. This task is a **verification gate** for the invariant Task 6/7 rely on — skipped rows never enter `entries`, so neither aggregator can see one.

- [ ] **Step 1: Write the characterization tests**

Add to `src/workflow/uat/aggregate.test.ts`:

```ts
  it('passes on the gates that ran, unaffected by how many were disabled', () => {
    const entry = {
      result: { name: 'test', exitCode: 0, output: '', startedAt: 'a', endedAt: 'b' },
      identity: { repo: '/api', command: 'npm', args: ['test'] },
    };
    const outcome = aggregateUat([entry], []);
    expect(outcome.kind).toBe('verdict');
    if (outcome.kind !== 'verdict') throw new Error('unreachable');
    expect(outcome.verdict).toEqual({ kind: 'passed' });
  });
```

Add the matching test to `src/workflow/review/aggregate.test.ts` using the suite's existing `aggregateReview` call shape and a `{ kind: 'not-run' }` findings lane.

- [ ] **Step 2: Run the tests**

Run: `npx vitest run src/workflow/uat/aggregate.test.ts src/workflow/review/aggregate.test.ts`
Expected: PASS immediately — the aggregators already behave this way, and these tests pin that they keep doing so once skipped rows exist.

- [ ] **Step 3: Commit**

```bash
git add src/workflow/uat/aggregate.test.ts src/workflow/review/aggregate.test.ts
git commit -m "test: pin that a disabled gate cannot reach the aggregators"
```

---

## Task 9: "Everything disabled" is a pass, not `nothing-to-run` — **see Open Question 1**

> **Stop and confirm with the user before implementing this task.** It softens the invariant `aggregateUat` documents as the reason the whole gate design exists. The rest of the plan works without it (the stage would park with `nothing-to-run`, which is arguably the more honest answer).

**Files:**
- Modify: `src/workflow/uat/aggregate.ts` (`aggregateUat`)
- Modify: `src/workflow/review/aggregate.ts` (`AggregateReviewOpts` + `gatesOutcomeBeforeFindings`'s zero-entry branch)
- Modify: `src/workflow/stages/uat.ts`, `src/workflow/stages/review.ts` (pass the new argument)
- Test: `src/workflow/uat/aggregate.test.ts`, `src/workflow/review/aggregate.test.ts`

**Interfaces:**
- Produces:
  - `aggregateUat(entries, reviewIdentities, disabledNames: readonly string[] = [])`
  - `AggregateReviewOpts` gains `disabledGateNames?: readonly string[]`

- [ ] **Step 1: Write the failing test**

Add to `src/workflow/uat/aggregate.test.ts`:

```ts
  it('passes with a warning when every gate was disabled for this ticket', () => {
    const outcome = aggregateUat([], [], ['test', 'e2e']);
    expect(outcome.kind).toBe('verdict');
    if (outcome.kind !== 'verdict') throw new Error('unreachable');
    expect(outcome.verdict).toEqual({ kind: 'passed' });
    expect(outcome.warnings.join(' ')).toContain('test, e2e');
  });

  it('still blocks when nothing ran and nothing was disabled', () => {
    const outcome = aggregateUat([], [], []);
    expect(outcome).toEqual({
      kind: 'blocked',
      blocker: 'nothing-to-run',
      reason: 'no gates resolved for this ticket',
    });
  });

  it('still blocks when a gate resolved, none ran, and a DIFFERENT gate was disabled', () => {
    const entry = {
      result: { name: 'test', exitCode: null, output: '', startedAt: null, endedAt: null },
      identity: { repo: '/api', command: 'npm', args: ['test'] },
    };
    expect(aggregateUat([entry], [], ['e2e']).kind).toBe('blocked');
  });
```

Add the equivalent three tests to `src/workflow/review/aggregate.test.ts`, passing `disabledGateNames` through `opts`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/workflow/uat/aggregate.test.ts src/workflow/review/aggregate.test.ts`
Expected: FAIL — the first test gets `{ kind: 'blocked', blocker: 'nothing-to-run' }`.

- [ ] **Step 3: Write the implementation**

In `src/workflow/uat/aggregate.ts`, add the third parameter and replace the zero-ran branch:

```ts
export function aggregateUat(
  entries: readonly AggregateEntry[],
  reviewIdentities: readonly GateIdentity[],
  /**
   * The gate names this ticket switched off. Not evidence — the skipped rows in
   * `gate_runs` are — but the one fact that distinguishes "the stage asked
   * nothing because the repository offers nothing" (a block, and the rule this
   * module exists to protect) from "the stage asked nothing because the USER
   * retracted every question" (a pass: the ticket asked for nothing and got
   * nothing to fail). Deliberately narrow: this only applies when NO entry
   * resolved at all, and it always warns.
   */
  disabledNames: readonly string[] = [],
): AggregateOutcome {
  const ran = entries.filter((e) => e.result.exitCode !== null);

  if (ran.length === 0) {
    if (entries.length === 0 && disabledNames.length > 0) {
      return {
        kind: 'verdict',
        verdict: { kind: 'passed' },
        warnings: [
          `every uat gate was disabled for this ticket (${disabledNames.join(', ')}), ` +
            'so uat asked nothing. Re-enable them on the ticket dashboard to get a real signal.',
        ],
      };
    }
    return {
      kind: 'blocked',
      blocker: 'nothing-to-run',
      reason:
        entries.length === 0
          ? 'no gates resolved for this ticket'
          : `no gate ran: ${entries.map((e) => e.result.name).join(', ')}`,
    };
  }
  // …rest unchanged
```

In `src/workflow/review/aggregate.ts`, add `disabledGateNames?: readonly string[]` to `AggregateReviewOpts` with the same doc comment, and apply the same narrow branch inside `gatesOutcomeBeforeFindings`'s zero-entry case (pass `opts.disabledGateNames ?? []` into it).

At both stage call sites, pass the names collected in Tasks 6/7:

```ts
  // uat.ts
  const outcome = aggregateUat(entries, reviewIdentities, skippedGates.map((g) => g.gateName));
```

```ts
  // review.ts — inside the existing opts object
      disabledGateNames: skippedGates.map((g) => g.gateName),
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/workflow/uat/aggregate.test.ts src/workflow/review/aggregate.test.ts src/workflow/stages/uat.test.ts src/workflow/stages/review.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/workflow/uat/aggregate.ts src/workflow/review/aggregate.ts \
        src/workflow/stages/uat.ts src/workflow/stages/review.ts \
        src/workflow/uat/aggregate.test.ts src/workflow/review/aggregate.test.ts
git commit -m "feat: a stage whose every gate the user disabled passes with a warning"
```

---

# Phase 3 — Display

## Task 10: `skip` as an evidence-row status

**Files:**
- Modify: `src/model/inside/types.ts` (`OpStatus`, line 12)
- Modify: `src/model/inside/gates.ts` (`gateOp`, lines 52–62)
- Modify: `src/ui/dashboard/webview.html` (`OP_GLYPH` line 869, `.op` CSS around line 488)
- Test: `src/model/inside/gates.test.ts`, `src/ui/dashboard/webview.test.ts`

**Interfaces:**
- Consumes: `GateRun.skipped` (Task 3).
- Produces: `OpStatus` gains `'skip'`; `gateOp` returns `{ status: 'skip', detail: 'Skipped — disabled by user' }` for a skipped row.

- [ ] **Step 1: Write the failing test**

Add to `src/model/inside/gates.test.ts` (reuse the suite's `GateRun` fixture builder; it must now set `skipped`):

```ts
  it('renders a skipped gate as skip, worded as a user decision', () => {
    const runs = [run({ stageKey: 'uat', gateName: 'e2e', exitCode: null, skipped: true })];
    const ops = uatInside(cell('uat', 'passed'), runs, NOW).ops;
    expect(ops).toEqual([
      { status: 'skip', name: 'e2e', detail: 'Skipped — disabled by user', duration: '' },
    ]);
  });

  it('keeps a missing-script row as a note, distinct from a skip', () => {
    const runs = [run({ stageKey: 'uat', gateName: 'e2e', exitCode: null, skipped: false })];
    expect(uatInside(cell('uat', 'passed'), runs, NOW).ops[0]).toEqual({
      status: 'note', name: 'e2e', detail: 'nothing to run', duration: '',
    });
  });
```

Add to `src/ui/dashboard/webview.test.ts`, beside the existing constant-mirror tests:

```ts
  it('renders a glyph for every OpStatus the host can produce', () => {
    const html = readFileSync('src/ui/dashboard/webview.html', 'utf8');
    const map = /const OP_GLYPH = \{([^}]*)\}/.exec(html)?.[1] ?? '';
    for (const status of ['pass', 'fail', 'run', 'wait', 'pending', 'note', 'skip']) {
      expect(map, `OP_GLYPH is missing ${status}`).toContain(`${status}:`);
    }
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/model/inside/gates.test.ts src/ui/dashboard/webview.test.ts`
Expected: FAIL — `expected 'note' to be 'skip'`, and `OP_GLYPH is missing skip`.

- [ ] **Step 3: Write the implementation**

In `src/model/inside/types.ts`:

```ts
/**
 * How an operation row reads.
 *
 * `note` is not a status. It is karst stating a fact it cannot honestly dress as
 * a pass or a fail — a gate the repo cannot answer, a phase karst does not
 * observe, a rule about what will happen next. Keeping it in the union is what
 * stops the panel inventing a verdict to fill a row.
 *
 * `skip` is narrower and is NOT a second `note`: the gate exists, the repository
 * can answer it, and a human decided it should not be asked for this ticket. A
 * `note` says karst had no question; a `skip` says the question was withdrawn,
 * and a reader who cannot tell the two apart cannot tell a broken repo from a
 * deliberate choice.
 */
export type OpStatus = 'pass' | 'fail' | 'run' | 'wait' | 'pending' | 'note' | 'skip';
```

In `src/model/inside/gates.ts`, replace `gateOp`:

```ts
/**
 * One recorded gate as a row.
 *
 * Three distinct outcomes, and the difference between the last two is the whole
 * point of the `skipped` column: `exitCode` 0/non-zero is a verdict; a null exit
 * with `skipped` false means the repo defines no such script, so karst had no
 * question to ask; a null exit with `skipped` true means the gate was there and
 * the user switched it off for this ticket. Neither of the last two is a pass.
 */
function gateOp(run: GateRun): StageOp {
  if (run.skipped) {
    return {
      status: 'skip',
      name: run.gateName,
      detail: 'Skipped — disabled by user',
      duration: '',
    };
  }
  return {
    status: run.exitCode === null ? 'note' : run.exitCode === 0 ? 'pass' : 'fail',
    name: run.gateName,
    detail: run.exitCode === null ? 'nothing to run' : `exit ${run.exitCode}`,
    duration: formatDuration(run.startedAt, run.endedAt),
  };
}
```

In `src/ui/dashboard/webview.html`, extend the glyph map (line 869) and add the CSS beside the other `.op.*` rules (~line 489):

```js
  const OP_GLYPH = { pass: '✓', fail: '✕', run: SPINNER, wait: '⏸', note: '↳', pending: '·', skip: '⊘' };
```

```css
  /* A withdrawn question, not an unanswerable one: dimmed like `pending` but
     glyphed distinctly, so it never reads as a gate still to come. */
  .op.skip .oglyph{color:var(--k-text-faint)}
  .op.skip{opacity:.7}
  .op.skip .ocmd{font-style:italic}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/model/inside/gates.test.ts src/ui/dashboard/webview.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the design-system and CSP conformance suites**

Run: `npx vitest run src/ui/designSystem.test.ts src/ui/webviewCsp.test.ts src/ui/conformance.test.ts`
Expected: PASS — the new CSS uses only `--k-*` tokens (UI-R04/R05) and adds no external resource.

- [ ] **Step 6: Commit**

```bash
git add src/model/inside/types.ts src/model/inside/gates.ts src/model/inside/gates.test.ts \
        src/ui/dashboard/webview.html src/ui/dashboard/webview.test.ts
git commit -m "feat: a skipped gate reads as skipped, never as a missing script (UI-R09)"
```

---

## Task 11: `karst context` reports skipped gates

**Files:**
- Modify: `src/context/ticketContext.ts` (the `gates:` mapping, ~line 253)
- Test: `src/context/ticketContext.test.ts`

**Interfaces:**
- Consumes: `GateRun.skipped` (Task 3).
- Produces: each element of `TicketContextStage['gates']` gains `skipped: boolean`; `renderTicketContext` prints `skipped (disabled for this ticket)` where it prints an exit code today.

- [ ] **Step 1: Write the failing test**

Add to `src/context/ticketContext.test.ts`:

```ts
  it('names a skipped gate as disabled rather than as an absent script', () => {
    const store = openStore(':memory:');
    const ticketId = seedTicketAtUat(store);
    recordGateRun(store, {
      ticketId, stageKey: 'uat', attempt: 1, runAt: '2026-08-04T10:00:00.000Z',
      gates: [
        { gateName: 'test', exitCode: 0 },
        { gateName: 'e2e', exitCode: null, skipped: true },
      ],
    });
    const context = buildTicketContext(store, ticketId);
    expect(context.stage?.gates).toEqual([
      { name: 'test', exitCode: 0, skipped: false },
      { name: 'e2e', exitCode: null, skipped: true },
    ]);
    expect(renderTicketContext(context)).toContain('disabled for this ticket');
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/context/ticketContext.test.ts`
Expected: FAIL — the gate objects have no `skipped` key.

- [ ] **Step 3: Write the implementation**

In `src/context/ticketContext.ts`, add `skipped: boolean;` to the gate element type in `TicketContextStage`, and extend the map:

```ts
        gates: latestBatch(listGateRuns(store, ticketId), stageRow.stageKey).map((g) => ({
          name: g.gateName,
          exitCode: g.exitCode,
          // Carried separately from `exitCode` for the agent's sake as much as a
          // human's: an agent told only "no exit code" would try to fix a
          // package.json that is perfectly fine.
          skipped: g.skipped,
        })),
```

In `renderTicketContext`, where a gate line is composed, branch before the exit-code text:

```ts
    const state = gate.skipped
      ? 'skipped (disabled for this ticket)'
      : gate.exitCode === null
        ? 'not run (no such script)'
        : `exit ${gate.exitCode}`;
```

Match the surrounding renderer's exact line shape — copy the existing gate line and substitute only the state expression.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/context/ticketContext.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/context/ticketContext.ts src/context/ticketContext.test.ts
git commit -m "feat: karst context distinguishes a disabled gate from an absent script"
```

---

# Phase 4 — UI

## Task 12: Host-side resolution of a ticket's gate options

**Files:**
- Create: `src/ui/dashboard/gateOptions.ts`
- Test: `src/ui/dashboard/gateOptions.test.ts`

**Interfaces:**
- Consumes: `planUatTargets`/`planReviewTargets`, `probeScripts`, `resolveTargetGates`, `resolveReviewGates`, `getDisabledGates`, `listWorktreesByTicket`.
- Produces:

```ts
export interface GateOption { name: string; disabled: boolean }
export interface GateOptions { uat: GateOption[]; review: GateOption[] }
export type GateOptionsLoader = (ticketId: number, signal: AbortSignal) => Promise<GateOptions>;
export function buildGateOptionsLoader(deps: {
  store: Store;
  manifest: () => Manifest | undefined;
  probe?: (cwd: string) => ScriptProbe;
  git?: GitRunner;
}): GateOptionsLoader;
```

- [ ] **Step 1: Write the failing test**

Create `src/ui/dashboard/gateOptions.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { openStore } from '../../store/db.js';
import { setDisabledGates } from '../../store/ticketGates.js';
import { buildGateOptionsLoader } from './gateOptions.js';

// Uses manifest/fixtures.ts's builders — the shared test builders every suite
// uses, so a manifest shape change is one file, not 26.
import { manifest, repository } from '../../manifest/fixtures.js';

describe('buildGateOptionsLoader', () => {
  it('lists the gates a ticket would actually run, with their disabled flags', async () => {
    const store = openStore(':memory:');
    const ticketId = seedScopedTicket(store, '/repo/api');
    setDisabledGates(store, ticketId, 'uat', ['e2e']);
    const load = buildGateOptionsLoader({
      store,
      manifest: () => manifest({ repositories: [repository({ name: 'api', repoPath: '/repo/api' })] }),
      probe: () => ({ kind: 'ok', scripts: { test: 'vitest', e2e: 'pw', lint: 'eslint .' } }),
    });
    const options = await load(ticketId, new AbortController().signal);
    expect(options.uat).toEqual([
      { name: 'test', disabled: false },
      { name: 'e2e', disabled: true },
    ]);
    expect(options.review.some((o) => o.name === 'lint')).toBe(true);
  });

  it('lists a disabled gate even though resolution removed it from the run list', async () => {
    const store = openStore(':memory:');
    const ticketId = seedScopedTicket(store, '/repo/api');
    setDisabledGates(store, ticketId, 'uat', ['test', 'e2e']);
    const load = buildGateOptionsLoader({
      store,
      manifest: () => manifest({ repositories: [repository({ name: 'api', repoPath: '/repo/api' })] }),
      probe: () => ({ kind: 'ok', scripts: { test: 'vitest', e2e: 'pw' } }),
    });
    const options = await load(ticketId, new AbortController().signal);
    expect(options.uat.every((o) => o.disabled)).toBe(true);
    expect(options.uat).toHaveLength(2);
  });

  it('returns empty lists rather than throwing when no manifest is resolved', async () => {
    const store = openStore(':memory:');
    const ticketId = seedScopedTicket(store, '/repo/api');
    const load = buildGateOptionsLoader({ store, manifest: () => undefined });
    expect(await load(ticketId, new AbortController().signal)).toEqual({ uat: [], review: [] });
  });

  it('returns empty lists when the repository cannot be probed', async () => {
    const store = openStore(':memory:');
    const ticketId = seedScopedTicket(store, '/repo/api');
    const load = buildGateOptionsLoader({
      store,
      manifest: () => manifest({ repositories: [repository({ name: 'api', repoPath: '/repo/api' })] }),
      probe: () => ({ kind: 'io-error', message: 'EACCES' }),
    });
    expect(await load(ticketId, new AbortController().signal)).toEqual({ uat: [], review: [] });
  });
});
```

`seedScopedTicket` creates a ticket plus one `worktrees` row for the given path — copy the helper the dashboard `state.test.ts` already uses.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/ui/dashboard/gateOptions.test.ts`
Expected: FAIL — `Cannot find module './gateOptions.js'`.

- [ ] **Step 3: Write the implementation**

Create `src/ui/dashboard/gateOptions.ts`:

```ts
import type { Store } from '../../store/db.js';
import type { Manifest } from '../../manifest/types.js';
import { listWorktreesByTicket } from '../../store/dashboard.js';
import { getDisabledGates } from '../../store/ticketGates.js';
import { probeScripts, type ScriptProbe } from '../../workflow/gates/probe.js';
import { defaultGitRunner, type GitRunner } from '../../integrations/git.js';
import { planUatTargets } from '../../workflow/uat/targets.js';
import { planReviewTargets } from '../../workflow/review/targets.js';
import { resolveTargetGates } from '../../workflow/stages/uat.js';
import { resolveReviewGates } from '../../workflow/review/gates.js';

/**
 * One gate a ticket's stage would run, and whether the user has switched it off.
 *
 * The RESOLVED name, never the raw manifest list: repository-scoped overrides
 * and package.json auto-discovery both change what actually runs, and offering
 * a toggle for a gate that would never run (or omitting one that would) is a
 * control that lies.
 */
export interface GateOption {
  name: string;
  disabled: boolean;
}

export interface GateOptions {
  uat: GateOption[];
  review: GateOption[];
}

export type GateOptionsLoader = (ticketId: number, signal: AbortSignal) => Promise<GateOptions>;

/** Names in resolution order, deduplicated — one toggle per name, not per repo. */
function optionsFrom(names: readonly string[], disabled: readonly string[]): GateOption[] {
  const seen = new Set<string>();
  const out: GateOption[] = [];
  for (const name of names) {
    if (seen.has(name)) continue;
    seen.add(name);
    out.push({ name, disabled: disabled.includes(name) });
  }
  // A gate the user disabled is REMOVED from the resolved list by construction,
  // so it would otherwise vanish from the very panel that has to offer the way
  // back. Appended here so a disabled gate is always re-enableable.
  for (const name of disabled) {
    if (seen.has(name)) continue;
    seen.add(name);
    out.push({ name, disabled: true });
  }
  return out;
}

/**
 * Resolve the gate names a ticket's uat/review stages would run right now.
 *
 * Async and filesystem-touching (it probes each worktree's package.json), which
 * is why it is NOT part of `buildDashboardState`: that builder is synchronous
 * and store-only by design, and the panel already has a precedent for a
 * supplemental async push in `pushWorktreeStats`. Every failure degrades to
 * empty lists — a panel that cannot resolve gates shows no toggles, which is
 * strictly better than offering one that would not match what runs.
 */
export function buildGateOptionsLoader(deps: {
  store: Store;
  manifest: () => Manifest | undefined;
  probe?: (cwd: string) => ScriptProbe;
  git?: GitRunner;
}): GateOptionsLoader {
  const probe = deps.probe ?? probeScripts;
  const git = deps.git ?? defaultGitRunner;

  return async (ticketId, signal): Promise<GateOptions> => {
    const empty: GateOptions = { uat: [], review: [] };
    const manifest = deps.manifest();
    if (!manifest) return empty;
    const disabled = getDisabledGates(deps.store, ticketId);
    try {
      const worktrees = listWorktreesByTicket(deps.store, ticketId);
      const [uatPlan, reviewPlan] = await Promise.all([
        planUatTargets(manifest, worktrees, git),
        planReviewTargets(manifest, worktrees, git),
      ]);
      if (signal.aborted) return empty;

      const uatNames: string[] = [];
      if (uatPlan.kind === 'targets') {
        for (const target of uatPlan.targets) {
          const resolution = resolveTargetGates(probe(target.path), manifest.uat, target.names);
          if (resolution.kind !== 'gates') continue;
          uatNames.push(...resolution.gates.map((g) => g.name));
        }
      }

      const reviewNames: string[] = [];
      if (reviewPlan.kind === 'targets') {
        for (const target of reviewPlan.targets) {
          const resolution = resolveReviewGates(probe(target.path), manifest.review, target.names);
          if (resolution.kind !== 'gates') continue;
          reviewNames.push(...resolution.gates.map((g) => g.name));
        }
      }

      return {
        uat: optionsFrom(uatNames, disabled.uat),
        review: optionsFrom(reviewNames, disabled.review),
      };
    } catch {
      // A broken git, an unreadable tree — the panel is an observer here and a
      // failed observation must never surface as a failed ticket.
      return empty;
    }
  };
}
```

Note the deliberate omission: `resolveTargetGates`/`resolveReviewGates` are called WITHOUT `disabledNames`, so the list is what the stage would run *if nothing were disabled* — the full set of togglable names. The `disabled` flag comes from the store.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/ui/dashboard/gateOptions.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add src/ui/dashboard/gateOptions.ts src/ui/dashboard/gateOptions.test.ts
git commit -m "feat: resolve a ticket's togglable gate names host-side"
```

---

## Task 13: The `set-disabled-gates` message and action

**Files:**
- Modify: `src/ui/dashboard/messages.ts`
- Test: `src/ui/dashboard/messages.test.ts`

**Interfaces:**
- Consumes: `GATE_STAGES`/`GateStage` from `store/ticketGates.js`, `GateOptions` from `./gateOptions.js`.
- Produces:
  - `WebviewMessage` gains `{ type: 'set-disabled-gates'; stage: GateStage; name: string; disabled: boolean }`
  - `HostMessage` gains `{ type: 'gate-options'; options: GateOptions }`
  - `DashboardActions` gains `setDisabledGate: (stage: GateStage, name: string, disabled: boolean) => void | Promise<void>`

- [ ] **Step 1: Write the failing test**

Add to `src/ui/dashboard/messages.test.ts`:

```ts
  it('parses a well-formed set-disabled-gates message', () => {
    expect(parseWebviewMessage({ type: 'set-disabled-gates', stage: 'uat', name: 'e2e', disabled: true }))
      .toEqual({ type: 'set-disabled-gates', stage: 'uat', name: 'e2e', disabled: true });
  });

  it('drops a set-disabled-gates message naming a stage that resolves no gates', () => {
    for (const stage of ['ship', 'impl', 'merge', '', 'UAT']) {
      expect(parseWebviewMessage({ type: 'set-disabled-gates', stage, name: 'e2e', disabled: true }))
        .toBeNull();
    }
  });

  it('drops a set-disabled-gates message with a missing, blank or non-string name', () => {
    for (const name of [undefined, '', '   ', 7, { toString: () => 'e2e' }]) {
      expect(parseWebviewMessage({ type: 'set-disabled-gates', stage: 'uat', name, disabled: true }))
        .toBeNull();
    }
  });

  it('drops a set-disabled-gates message whose disabled flag is not a boolean', () => {
    expect(parseWebviewMessage({ type: 'set-disabled-gates', stage: 'uat', name: 'e2e', disabled: 'yes' }))
      .toBeNull();
  });

  it('caps an absurdly long gate name rather than routing it', () => {
    expect(parseWebviewMessage({
      type: 'set-disabled-gates', stage: 'uat', name: 'x'.repeat(300), disabled: true,
    })).toBeNull();
  });

  it('routes set-disabled-gates to setDisabledGate with all three fields', () => {
    const calls: unknown[] = [];
    const actions = { ...noopActions(), setDisabledGate: (...a: unknown[]) => { calls.push(a); } };
    routeAction({ type: 'set-disabled-gates', stage: 'review', name: 'lint', disabled: false }, actions);
    expect(calls).toEqual([['review', 'lint', false]]);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/ui/dashboard/messages.test.ts`
Expected: FAIL — `expected null to equal { type: 'set-disabled-gates', … }`.

- [ ] **Step 3: Write the implementation**

In `src/ui/dashboard/messages.ts`:

Import: `import { GATE_STAGES, type GateStage } from '../../store/ticketGates.js';` and `import type { GateOptions } from './gateOptions.js';`

Add to `WebviewMessage`:

```ts
  /**
   * Switch ONE named gate off (or back on) for this ticket alone.
   *
   * Carries no ticket id: the panel closure already owns the ticket, exactly
   * like `refresh-prs` and `merge-pr`, so a crafted message cannot aim a
   * disable at another ticket. The stage is narrowed to the two that resolve
   * gates at all, and the name is a bounded string matched against a RESOLVED
   * gate name host-side — it never becomes a command.
   */
  | { type: 'set-disabled-gates'; stage: GateStage; name: string; disabled: boolean }
```

Add to `HostMessage`:

```ts
  /**
   * The togglable gate names for this ticket. Its own message, not part of
   * `DashboardState`, because resolving it probes the filesystem and
   * `buildDashboardState` is synchronous — same split as `worktree-stats`.
   */
  | { type: 'gate-options'; options: GateOptions }
```

Add to `DashboardActions`:

```ts
  /**
   * Switch one gate off (or on) for this ticket. Takes the stage and the gate
   * NAME — never a command or a script — so the webview can express only which
   * question to withdraw, never what to run.
   */
  setDisabledGate: (stage: GateStage, name: string, disabled: boolean) => void | Promise<void>;
```

Add the parse case, with a bounded-name guard:

```ts
/** Longest gate name accepted from a webview. Real names are short script keys. */
const MAX_GATE_NAME_CHARS = 128;

function isGateStage(v: unknown): v is GateStage {
  return typeof v === 'string' && (GATE_STAGES as readonly string[]).includes(v);
}
```

```ts
    // Every field is required and typed here, at the trust boundary. A blank or
    // oversized name drops the whole message rather than being trimmed into
    // something the host would then match against a real gate.
    case 'set-disabled-gates': {
      const name = typeof m.name === 'string' ? m.name.trim() : '';
      return isGateStage(m.stage) &&
        name.length > 0 &&
        name.length <= MAX_GATE_NAME_CHARS &&
        typeof m.disabled === 'boolean'
        ? { type: 'set-disabled-gates', stage: m.stage, name, disabled: m.disabled }
        : null;
    }
```

Add the route case:

```ts
    case 'set-disabled-gates':
      return actions.setDisabledGate(msg.stage, msg.name, msg.disabled);
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/ui/dashboard/messages.test.ts`
Expected: PASS. Other suites constructing a `DashboardActions` will now fail to typecheck until they add `setDisabledGate` — add a no-op to each fixture.

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add src/ui/dashboard/messages.ts src/ui/dashboard/messages.test.ts
git commit -m "feat: dashboard message + action for toggling one gate per ticket"
```

---

## Task 14: The panel pushes gate options

**Files:**
- Modify: `src/ui/dashboard/panel.ts`
- Test: `src/ui/dashboard/panel.test.ts`

**Interfaces:**
- Consumes: `GateOptionsLoader` (Task 12), `HostMessage['gate-options']` (Task 13).
- Produces: a new optional `DashboardManager` constructor parameter `loadGateOptions?: GateOptionsLoader`, appended AFTER `fixCapFor` so no existing positional argument moves. `pushState` fires it; only the latest request for a still-open panel may post.

- [ ] **Step 1: Write the failing test**

Add to `src/ui/dashboard/panel.test.ts`:

```ts
  it('pushes gate options after the state push', async () => {
    const { manager, panel, store, ticketId } = openManager({
      loadGateOptions: async () => ({ uat: [{ name: 'e2e', disabled: true }], review: [] }),
    });
    manager.openDashboard(ticketId);
    await Promise.resolve();
    await Promise.resolve();
    const msg = panel.posted.find((p) => (p as { type: string }).type === 'gate-options');
    expect(msg).toEqual({ type: 'gate-options', options: { uat: [{ name: 'e2e', disabled: true }], review: [] } });
  });

  it('does not post gate options to a panel that has been disposed', async () => {
    let release: (v: unknown) => void = () => {};
    const { manager, panel, ticketId } = openManager({
      loadGateOptions: async () => { await new Promise((r) => { release = r; }); return { uat: [], review: [] }; },
    });
    manager.openDashboard(ticketId);
    panel.dispose();
    release(null);
    await Promise.resolve();
    await Promise.resolve();
    expect(panel.posted.some((p) => (p as { type: string }).type === 'gate-options')).toBe(false);
  });

  it('never posts a stale gate-options result after a newer push', async () => {
    const resolvers: Array<(v: { uat: never[]; review: never[] }) => void> = [];
    const { manager, panel, ticketId } = openManager({
      loadGateOptions: async () => new Promise((r) => resolvers.push(r)),
    });
    manager.openDashboard(ticketId);
    manager.pushState(ticketId);
    resolvers[1]!({ uat: [], review: [] });
    resolvers[0]!({ uat: [], review: [] });
    await Promise.resolve();
    await Promise.resolve();
    expect(panel.posted.filter((p) => (p as { type: string }).type === 'gate-options')).toHaveLength(1);
  });

  it('logs and posts nothing when gate resolution rejects', async () => {
    const logged: unknown[] = [];
    const { manager, panel, ticketId } = openManager({
      logError: (m: string) => logged.push(m),
      loadGateOptions: async () => { throw new Error('probe blew up'); },
    });
    manager.openDashboard(ticketId);
    await Promise.resolve();
    await Promise.resolve();
    expect(panel.posted.some((p) => (p as { type: string }).type === 'gate-options')).toBe(false);
    expect(logged).toHaveLength(1);
  });
```

`openManager` stands for the suite's existing manager-construction helper; extend it to accept the new option.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/ui/dashboard/panel.test.ts`
Expected: FAIL — `expected undefined to equal { type: 'gate-options', … }`.

- [ ] **Step 3: Write the implementation**

In `src/ui/dashboard/panel.ts`, add the constructor parameter after `fixCapFor`:

```ts
    /**
     * Resolve this ticket's togglable gate names. Async and filesystem-touching,
     * so it rides its own message rather than `DashboardState` — the same split
     * `loadStats` uses, for the same reason. Absent → the Gates section stays
     * empty, which is exactly the pre-feature panel.
     */
    private readonly loadGateOptions?: GateOptionsLoader,
```

Add the private fields beside the stats ones:

```ts
  private readonly gateRequests = new Map<number, number>();
  private readonly gateControllers = new Map<number, AbortController>();
```

Add the push method, modeled exactly on `pushWorktreeStats`:

```ts
  /**
   * Resolve and push the ticket's gate options. Only the latest request for a
   * still-live panel may post — a slower earlier probe must never overwrite a
   * newer answer, the same guard `pushWorktreeStats` carries.
   */
  private pushGateOptions(ticketId: number, panel: DashboardPanel): void {
    if (!this.loadGateOptions) return;
    this.gateControllers.get(ticketId)?.abort();
    const controller = new AbortController();
    this.gateControllers.set(ticketId, controller);
    const request = (this.gateRequests.get(ticketId) ?? 0) + 1;
    this.gateRequests.set(ticketId, request);
    void this.loadGateOptions(ticketId, controller.signal).then(
      (options) => {
        if (this.panels.get(ticketId) !== panel) return;
        if (this.gateRequests.get(ticketId) !== request) return;
        this.gateControllers.delete(ticketId);
        panel.postMessage({ type: 'gate-options', options });
      },
      (error) => {
        if (this.panels.get(ticketId) !== panel) return;
        if (this.gateRequests.get(ticketId) !== request) return;
        this.gateControllers.delete(ticketId);
        this.logError('karst: dashboard gate options failed', error);
      },
    );
  }
```

Call it at the end of `pushState`, after `this.refreshIcon(...)`:

```ts
    this.pushGateOptions(ticketId, panel);
```

And extend `onDidDispose`'s cleanup with `this.gateControllers.get(ticketId)?.abort();`, `this.gateRequests.delete(ticketId);`, `this.gateControllers.delete(ticketId);`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/ui/dashboard/panel.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ui/dashboard/panel.ts src/ui/dashboard/panel.test.ts
git commit -m "feat: dashboard pushes a ticket's togglable gate options"
```

---

## Task 15: The Gates section in the webview

**Files:**
- Modify: `src/ui/dashboard/webview.html`
- Test: `src/ui/dashboard/webview.test.ts`

**Interfaces:**
- Consumes: the `gate-options` host message (Task 13), `karstRequestId`/`karstBeginPending`/`karstSettle` from the injected design runtime (`src/model/designRuntime.ts`).
- Produces: no host-side exports. Posts `{ type: 'set-disabled-gates', stage, name, disabled, requestId }`.

- [ ] **Step 1: Write the failing test**

Add to `src/ui/dashboard/webview.test.ts` (the suite reads the HTML as text and asserts on it — follow its existing style):

```ts
  it('renders a Gates panel with a per-gate toggle button', () => {
    const html = readFileSync('src/ui/dashboard/webview.html', 'utf8');
    expect(html).toContain('id="gates"');
    expect(html).toContain('data-act="set-disabled-gates"');
  });

  it('handles the gate-options host message', () => {
    const html = readFileSync('src/ui/dashboard/webview.html', 'utf8');
    expect(html).toContain("msg.type === 'gate-options'");
  });

  it('gives every gate toggle a matching aria-label and title (UI-R19–R21)', () => {
    const html = readFileSync('src/ui/dashboard/webview.html', 'utf8');
    const row = /function gateRow\([\s\S]*?\n  \}/.exec(html)?.[0] ?? '';
    expect(row).toContain('aria-label="${esc(label)}"');
    expect(row).toContain('title="${esc(label)}"');
  });

  it('uses a real button for the gate toggle, never a clickable div (UI-R09)', () => {
    const html = readFileSync('src/ui/dashboard/webview.html', 'utf8');
    const row = /function gateRow\([\s\S]*?\n  \}/.exec(html)?.[0] ?? '';
    expect(row).toContain('<button type="button"');
    expect(row).not.toMatch(/<div[^>]*data-act=/);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/ui/dashboard/webview.test.ts`
Expected: FAIL — `expected '…' to contain 'id="gates"'`.

- [ ] **Step 3: Write the markup**

Add the panel beside the existing Worktrees/Pull-requests panels (~line 833):

```html
  <div class="panel"><div class="phead">Gates<span class="count" id="gateCount"></span></div><div class="pbody" id="gates"></div></div>
```

- [ ] **Step 4: Write the renderer and the message handler**

Inside the webview `<script>`, add near the other render functions:

```js
  // The gate options arrive on their own message (they need a filesystem probe
  // the synchronous state build cannot do), so they are held separately from
  // lastState and survive a state push that carries none.
  let gateOptions = { uat: [], review: [] };

  function gateRow(stage, opt) {
    const label = (opt.disabled ? 'Enable ' : 'Disable ') + opt.name + ' for this ticket';
    return `<div class="gaterow${opt.disabled ? ' off' : ''}">`
      + `<span class="gname">${esc(opt.name)}</span>`
      + `<span class="gstate">${opt.disabled ? 'disabled' : 'runs'}</span>`
      + `<button type="button" class="k-btn k-btn--ghost k-btn--sm gtoggle"`
      + ` data-act="set-disabled-gates" data-stage="${esc(stage)}" data-name="${esc(opt.name)}"`
      + ` data-disabled="${opt.disabled ? '1' : '0'}"`
      + ` aria-pressed="${opt.disabled ? 'true' : 'false'}"`
      + ` aria-label="${esc(label)}" title="${esc(label)}">${opt.disabled ? 'Enable' : 'Disable'}</button>`
      + `</div>`;
  }

  function renderGates() {
    const uat = gateOptions.uat || [];
    const review = gateOptions.review || [];
    el('gateCount').textContent = String(uat.length + review.length);
    if (!uat.length && !review.length) {
      el('gates').innerHTML = '<div class="blurb">No gates resolved for this ticket yet.</div>';
      return;
    }
    const group = (title, stage, opts) => opts.length
      ? `<div class="ggroup"><div class="gtitle">${title}</div>`
        + opts.map((o) => gateRow(stage, o)).join('') + '</div>'
      : '';
    el('gates').innerHTML = group('UAT', 'uat', uat) + group('Review', 'review', review);
  }
```

In the message handler, beside the `worktree-stats` case:

```js
    if (msg.type === 'gate-options') { gateOptions = msg.options; renderGates(); return; }
```

In the click dispatcher, add a branch beside the other `data-act` handlers, BEFORE the generic `else post({ type: act, requestId })` fallback:

```js
    // Pending is set locally on click (UI-R11): the round trip is the thing
    // being reported, so it can never also be the thing that starts the report.
    // The label does not change while pending — the spinner carries that.
    if (act === 'set-disabled-gates') {
      const requestId = karstRequestId();
      karstBeginPending(btn, requestId);
      post({
        type: act,
        stage: btn.dataset.stage,
        name: btn.dataset.name,
        disabled: btn.dataset.disabled !== '1',
        requestId,
      });
      return;
    }
```

The button settles on the host's `action-result` through the existing `karstSettle` path, and the host follows a successful write with a fresh `gate-options` push, so the row re-renders from server truth rather than optimistic local state.

- [ ] **Step 5: Add the CSS (tokens only — UI-R04/R05)**

```css
  .ggroup{margin-bottom:var(--k-space-4)}
  .gtitle{font-size:var(--k-text-xs);color:var(--k-text-faint);text-transform:uppercase;
    letter-spacing:var(--k-tracking-wide);margin-bottom:var(--k-space-2)}
  .gaterow{display:flex;align-items:center;gap:var(--k-space-4);
    padding:var(--k-space-2) var(--k-space-4);border-radius:var(--k-radius-md)}
  .gaterow:hover{background:var(--k-surface-hover)}
  .gaterow.off .gname{text-decoration:line-through;color:var(--k-text-faint)}
  .gaterow .gname{font-family:var(--k-font-mono);font-size:var(--k-text-sm);flex:1}
  .gaterow .gstate{font-size:var(--k-text-xs);color:var(--k-text-dim)}
```

If any `--k-*` name above does not exist in `src/model/designTokens.ts`, substitute the nearest one that does — `designSystem.test.ts` will fail on an undefined token, which is the check.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run src/ui/dashboard/webview.test.ts src/ui/designSystem.test.ts src/ui/webviewCsp.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/ui/dashboard/webview.html src/ui/dashboard/webview.test.ts
git commit -m "feat: per-ticket gate toggles on the dashboard (UI-R09, UI-R11-R14, UI-R19)"
```

---

## Task 16: Wire it into the extension host

**Files:**
- Modify: `src/extension.ts`
- Modify: `src/ui/dashboard/webview.html` (copied to `dist/` by `scripts/copy-assets.mjs` — edit the SOURCE only)
- Test: `src/ui/dashboard/messages.test.ts` (action contract), manual F5 verification

**Interfaces:**
- Consumes: `buildGateOptionsLoader` (Task 12), `setDisabledGates` (Task 2), `DashboardActions.setDisabledGate` (Task 13), `DashboardManager`'s new `loadGateOptions` parameter (Task 14).
- Produces: nothing new; this is the composition root.

- [ ] **Step 1: Implement `setDisabledGate` in the dashboard actions factory**

Find where `extension.ts` builds a `DashboardActions` object (the `actionsFor` factory passed to `new DashboardManager(...)`) and add:

```ts
    // Returns a promise, so the button reports a REAL terminal outcome rather
    // than a bare ack (UI-R13): the write is fast and local, so there is no
    // reason to settle on anything weaker.
    setDisabledGate: async (stage, name, disabled) => {
      const current = getDisabledGates(store, ticketId)[stage];
      const next = disabled
        ? [...current, name]
        : current.filter((n) => n !== name);
      setDisabledGates(store, ticketId, stage, next);
      // Re-push so the row re-renders from what was actually stored, never
      // from what the click assumed.
      dashboards.pushState(ticketId);
    },
```

- [ ] **Step 2: Construct and pass the loader**

At the `new DashboardManager(...)` call, append the new argument after `fixCapFor`:

```ts
    buildGateOptionsLoader({ store, manifest: () => loadedManifest() }),
```

`loadedManifest` stands for whatever getter `extension.ts` already uses for the live manifest — the SAME getter `DriveTicketDeps.manifest` is bound to, so a mid-run `karst.yml` edit and a mid-run gate toggle are honored on identical terms.

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 4: Run the whole suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Manual verification (F5)**

1. F5 into the Extension Development Host.
2. Open a ticket dashboard for a ticket with a `package.json` defining `test` and `e2e`.
3. Confirm the Gates panel lists both under UAT; click **Disable** on `e2e`; confirm the button goes busy, then settles, and the row re-renders as `disabled` with an **Enable** button.
4. Drive the ticket through UAT. Confirm the Inside strip shows `e2e — Skipped — disabled by user` with the `⊘` glyph, and that only `test` ran.
5. Without reloading the window, click **Enable**, re-run UAT, and confirm `e2e` runs again — no session restart.
6. Run `node dist/cli/main.js context --db … --manifest … <KEY>` and confirm the skipped gate reads `skipped (disabled for this ticket)`.

- [ ] **Step 6: Commit**

```bash
git add src/extension.ts
git commit -m "feat: wire per-ticket gate disable into the extension host"
```

---

## Task 17: Documentation

**Files:**
- Modify: `CLAUDE.md`
- Modify: `karst.example.yml` (only if a comment there implies `uat.gates`/`review.gates` are the only way to skip a gate)

- [ ] **Step 1: Add the invariant paragraph to CLAUDE.md**

Under Architecture, after the gate-results/`gate_runs` bullet:

> - **A gate may be switched off for ONE ticket, and that is a filter over resolution's OUTPUT, never a change to resolution.** `tickets.disabled_gates` (v24, JSON `{uat:[],review:[]}`, NULL = nothing disabled) is read at run time by `stages/uat.ts` and `stages/review.ts` and applied by `workflow/gates/disable.ts`'s `partitionDisabled` — `workflow/gates/resolve.ts` never sees it, so "what did the config declare or the repo offer" keeps exactly one answer. A disabled gate is still RECORDED: one `gate_runs` row with `skipped = 1` and no exit code, which is a different fact from `exit_code IS NULL` ("the repo defines no such script, NOT a pass") and must never be folded into it — `model/inside/gates.ts` renders the two as `skip` and `note` for exactly that reason. Skipped rows never enter `entries`, so no aggregator can mistake one for a question that was asked. The store writer is per-stage (`setDisabledGates(store, id, stage, names)`) for the same reason Settings Save is per-tab: a whole-object write from a panel loaded before the other stage was touched silently reverts it. The dashboard's toggle list is the RESOLVED names, computed async host-side (`ui/dashboard/gateOptions.ts`, pushed as its own `gate-options` message like `worktree-stats`) — the raw manifest list would offer a toggle for a gate that never runs, and omit one that does.

If Open Question 1 was answered "pass", append: *"A stage whose every gate the user disabled PASSES with a warning naming them — the one deliberate exception to `aggregateUat`'s no-gates-is-never-green rule, narrowed to the case where no gate resolved for any other reason."* If it was answered "block", append the opposite sentence and delete Task 9's code.

- [ ] **Step 2: Run the full suite one last time**

Run: `npm test && npm run typecheck && npm run build`
Expected: all PASS.

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: record the per-ticket gate disable invariant"
```

---

## Self-Review Notes

**Spec coverage:** Storage → Tasks 1–2. Resolution → Tasks 4–7. Evidence → Tasks 1, 3, 6, 7. "Disabled-all is a pass" → Task 9 (gated on Open Question 1). Dashboard/CLI display → Tasks 10–11. UI → Tasks 12–15. Live effect → verified in Task 16 Step 5 (no new wiring, as the spec predicts: the disable is read from the store at resolution time).

**Deviations from the spec, all deliberate and flagged above:** migration is **v24**, not v23; the skipped state lives in `OpStatus` (`model/inside/types.ts`), not `model/stagePalette.ts`; the UI's resolved gate list arrives on its own async message rather than inside `DashboardState`; `partitionDisabled` and `StageGateResolution` are named seams the spec left implicit.

**Out of scope, per the spec, and absent from every task:** editing a gate's command per ticket; a "disable all" convenience action; any automatic re-enable.
