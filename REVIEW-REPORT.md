# Code Review: Retire `merge` stage — fold into `ship` as an entry gate on `done`

## Summary

Well-structured architectural change. Core idea is sound and implementation is thorough. Six issues found (4 fixed, 2 deferred), all low severity. No bugs that block merge.

---

## Issue 1 — Migration timestamp format mismatch with `nowIso()` ✅ FIXED

**File:** `src/store/migrations.ts:630`
**Severity:** Low

The v25 migration used `strftime('%Y-%m-%dT%H:%M:%fZ','now')`, which produces 6 fractional digits (microseconds), while `nowIso()` produces 3 (milliseconds). Stage timestamps are compared lexicographically in `deriveStageCurrent`.

**Fix:** Replaced with `new Date().toISOString()` interpolated into a prepared statement, guaranteeing format consistency.

---

## Issue 2 — v25 migration SQL statements not wrapped in a transaction ✅ FIXED

**File:** `src/store/migrations.ts:624-635`
**Severity:** Low

Two bare `db.exec()` calls were not atomic — the extension could read between them and see inconsistent state.

**Fix:** Wrapped both statements in `db.transaction(() => { ... })`, following the `repairAttachments` pattern already in the file.

---

## Issue 3 — Redundant `mergeGateState` calls in sweep path (deferred)

**File:** `src/workflow/mergeGate.ts`
**Severity:** Negligible

Both `resolveShipLanding` and `settleShipGate` call `mergeGateState(store, ticketId)`. A caller that already computed the state could pass it in. The tables are tiny so performance impact is negligible. Not worth the added parameter threading.

---

## Issue 4 — Non-atomic `clearStageBlock` + `transition` in landed path ✅ FIXED

**File:** `src/workflow/mergeGate.ts:161-162, 225-226`
**Severity:** Low

Two separate DB writes could leave a ticket stranded if `transition` threw after the block was cleared.

**Fix:** Moved `clearStageBlock` into `transition`'s `premutate` callback, which executes inside the same transaction. This matches the atomic pattern used by `commitGateOutcome` in `gates/commit.ts:133-149`.

---

## Issue 5 (new) — Stale `'merge'` in `ADVISORY_STAGES` ✅ FIXED

**File:** `src/context/ticketContext.ts:225`
**Severity:** Low

`ADVISORY_STAGES` included `'merge'`, which is no longer a valid `StageKey`. Dead code, maintenance trap.

**Fix:** Removed `'merge'` from the array. Kept the `readonly string[]` type (the `stageKey` field in the context interface is `string`, not `StageKey`, so narrowing the array type causes a type error).

---

## Issue 6 (new) — `schema.sql` defaults use `datetime('now')` format (deferred)

**File:** `src/store/schema.sql`
**Severity:** Negligible

Several columns (`tickets.created_at`, `tickets.updated_at`, `servers.started_at`) use `DEFAULT (datetime('now'))` which produces `YYYY-MM-DD HH:MM:SS` — no `T`, no `Z`, no fractional seconds. These aren't consumed by `deriveStageCurrent` today, but they violate the `nowIso()` contract documented in `model/time.ts:1-4`.

**Decision:** Deferred. These columns are display-only and have never been part of the lexicographic comparison. Fixing them requires a migration to rewrite existing values — disproportionate risk for zero behavioral gain.
