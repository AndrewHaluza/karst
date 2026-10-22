# openStore WAL-switch busy retry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `openStore` no longer fails with `database is locked` when several processes open a non-WAL file together.

**Architecture:** Read `journal_mode` first; skip the set when already `wal`. Otherwise set WAL inside a bounded retry on SQLITE_BUSY (50 ms `Atomics.wait` sleeps, ~5 s total), re-read `journal_mode`, accept `wal`. Set `busy_timeout = 5000` explicitly first. Existing close-on-throw stays.

**Tech Stack:** TypeScript ESM, better-sqlite3, vitest (integration config).

**Spec:** ticket FIX-OPENSTORE-FAILS-WITH prompt + context brief (D223); `docs/arch/store-and-schema.md` `[@arch:SQLITE]`.

## Global Constraints

- ESM imports need `.js` suffix; `noUncheckedIndexedAccess` on.
- No `spawnSync`; `Atomics.wait` sleep is the sync-open path's only option (openStore is sync).
- Test naming: spawns child process => `*.integration.test.ts`. Do not edit the NDL-36 test.
- Run `npm run -s <script>`; single file via `npx vitest run --config vitest.integration.config.ts src/store/db.integration.test.ts`. Never dump full output.
- Conventional commits; files <400 lines typical.
- Rejected: flaky/retry-marking the test; WAL pragma inside migrate's transaction; dropping WAL.

---

### Task 1: Retry WAL switch + stress test + arch line

**Files:**
- Modify: `src/store/db.ts:19-35`
- Modify: `src/store/db.integration.test.ts` (add test right after the NDL-36 test, ~line 933)
- Modify: `docs/arch/store-and-schema.md` (`[@arch:SQLITE]` block, line ~68)

**Interfaces:**
- Consumes: `openStore(path: string): Store` (unchanged signature), `migrationRaceWorker.ts <db-path>` (unchanged).
- Produces: same `openStore`; internal non-exported `enableWal(db)`.

- [ ] **Step 1: Write the failing stress test**

Insert after the NDL-36 test's closing `}, 20000);`:

```ts
  it('many windows switching a non-WAL DB to WAL together never fail the open', async () => {
    // SQLite can return SQLITE_BUSY at once (no busy_timeout wait) when a
    // rollback-journal file is switched to WAL while another connection holds
    // it. 8 concurrent children make that race reproduce reliably.
    const dir = mkdtempSync(join(tmpdir(), 'karst-db-wal-race-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, 'registry.db');
    const legacy = new Database(path);
    legacy.exec(v34SchemaText());
    legacy.pragma('user_version = 34');
    legacy.close();

    const workerPath = join(dirname(fileURLToPath(import.meta.url)), 'migrationRaceWorker.ts');
    const run = (): Promise<{ code: number | null; stderr: string }> =>
      new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ['--import', 'tsx', workerPath, path], {
          stdio: ['ignore', 'ignore', 'pipe'],
        });
        let stderr = '';
        child.stderr.on('data', (chunk) => {
          stderr += chunk.toString();
        });
        child.on('error', reject);
        child.on('exit', (code) => resolve({ code, stderr }));
      });

    const results = await Promise.all(Array.from({ length: 8 }, run));

    for (const r of results) {
      expect(r.stderr).toBe('');
      expect(r.code).toBe(0);
    }
    const check = new Database(path);
    cleanups.push(() => check.close());
    expect(check.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(check.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION);
  }, 60000);
```

- [ ] **Step 2: Run, expect FAIL**

Run: `npx vitest run --config vitest.integration.config.ts src/store/db.integration.test.ts -t "many windows" 2>&1 | tail -20`
Expected: FAIL with `database is locked` (rerun up to ~5 times if it passes once; the race is probabilistic but 8 children make it likely).

- [ ] **Step 3: Implement**

Replace `src/store/db.ts` lines 19-35 with:

```ts
const BUSY_TIMEOUT_MS = 5000;
const WAL_RETRY_SLEEP_MS = 50;
const WAL_MAX_ATTEMPTS = Math.ceil(BUSY_TIMEOUT_MS / WAL_RETRY_SLEEP_MS);

function isBusy(err: unknown): boolean {
  return (
    err instanceof Error &&
    ((err as { code?: string }).code?.startsWith('SQLITE_BUSY') === true ||
      /database is locked/i.test(err.message))
  );
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Switch to WAL. Changing a rollback-journal file to WAL needs an exclusive
 * lock and SQLite may return SQLITE_BUSY at once, bypassing busy_timeout, so
 * the switch is retried here. A peer that won the race leaves the file in WAL,
 * which the re-read after each failure accepts.
 */
function enableWal(db: Database.Database): void {
  for (let attempt = 1; ; attempt++) {
    if (db.pragma('journal_mode', { simple: true }) === 'wal') return;
    try {
      db.pragma('journal_mode = WAL');
      return;
    } catch (err) {
      if (!isBusy(err) || attempt >= WAL_MAX_ATTEMPTS) throw err;
      sleepSync(WAL_RETRY_SLEEP_MS);
    }
  }
}

export function openStore(path: string): Store {
  const db = new Database(path);
  try {
    db.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);
    enableWal(db);
    db.pragma('foreign_keys = ON');
    migrate(db);
  } catch (err) {
    // Don't leak the native handle if setup/migration throws.
    db.close();
    throw err;
  }

  return {
    db,
    close: () => db.close(),
  };
}
```

Keep the existing doc comment above `openStore` (move it to sit directly above `openStore`, below the helpers). `:memory:` returns `memory` mode: `pragma('journal_mode = WAL')` succeeds silently there, same as before.

- [ ] **Step 4: Run, expect PASS**

Run: `npx vitest run --config vitest.integration.config.ts src/store/db.integration.test.ts 2>&1 | tail -15` (run 3 times to check stability), then `npx vitest run src/store 2>&1 | tail -10` and `npm run -s typecheck 2>&1 | tail -10`.
Expected: all PASS.

- [ ] **Step 5: Arch doc line**

In `docs/arch/store-and-schema.md`, add one line before `END_DOC_BLOCK: [@arch:SQLITE]`:

```
`openStore` retries the WAL switch on SQLITE_BUSY (bounded, ~5 s) because the busy handler does not cover a journal-mode change.
```

- [ ] **Step 6: Commit**

```bash
git add src/store/db.ts src/store/db.integration.test.ts docs/arch/store-and-schema.md docs/superpowers/plans/2026-10-21-openstore-wal-busy-retry.md
git commit -m "fix: retry WAL switch on SQLITE_BUSY so concurrent openStore calls don't fail with 'database is locked'"
```

## Self-Review

- Decisions 1-5 map to Step 3 (1,2,3), Step 1 (4), Step 5 (5). NDL-36 test untouched.
- Final attempt rethrows original error; close-on-throw kept.
- Names consistent: `enableWal`, `isBusy`, `sleepSync`.

Execution: inline via executing-plans (single small task).
