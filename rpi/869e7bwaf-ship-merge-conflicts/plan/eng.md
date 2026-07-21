# ENG — Ship stage merge-conflict tracking

**Ticket**: `869e7bwaf` · Research: `../research/RESEARCH.md`

---

## 1. Architecture

```
shipTicket (workflow/stages/ship.ts)
  └─ per worktree, after pushBranch:
       checkMergeable(git, wt.path, wt.baseRef)        ← workflow/mergeCheck.ts (pure over GitRunner)
         ├─ git fetch origin <baseRef>                 (best effort; failure → unknown)
         ├─ git rev-parse HEAD / origin/<baseRef>      (SHAs, for staleness)
         └─ git merge-tree --write-tree --name-only <base> HEAD
              exit 0  → clean
              exit 1  → conflicted + stdout paths
              other   → unknown + stderr reason
       setMergeCheck(store, …)                          ← store/mergeChecks.ts (upsert)

read paths (all optional-nullable):
  listMergeChecksByTicket → ui/dashboard/state.ts → model/inside shipInside()
  listMergeChecksByTicket → context/ticketContext.ts → renderTicketContext → karst context CLI
```

Three new files, four modified. No new dependency. No stage-graph change.

## 2. Types

```ts
// src/workflow/mergeCheck.ts
export type MergeState = 'clean' | 'conflicted' | 'unknown';

export interface MergeCheck {
  state: MergeState;
  /** Conflicting paths. Non-empty only when state === 'conflicted'; always [] otherwise. */
  files: readonly string[];
  /** git's own message. Non-null only when state === 'unknown'. */
  reason: string | null;
  /** SHAs the verdict was computed from; null when they could not be read. */
  headSha: string | null;
  baseSha: string | null;
}
```

`checkMergeable` **never throws** — every failure becomes `unknown` with a reason. A merge probe that throws would abort ship, turning an observability feature into a new failure mode for a stage with no `failed` edge.

## 3. Detection mechanics

```
git fetch origin <baseRef>                                   # refresh base or we measure against stale
git rev-parse HEAD                                           # headSha
git rev-parse FETCH_HEAD (fallback origin/<baseRef>)         # baseSha
git merge-tree --write-tree --name-only <baseSha> <headSha>
```

- `merge-tree --write-tree` is **read-only** — no working tree, no index mutation. Safe against a live agent worktree. (`git merge-tree` without `--write-tree` is the deprecated trivial-merge mode; do not use it.)
- Exit codes: `0` clean · `1` conflict, conflicted paths on stdout · `>1` real error.
- Requires git ≥ 2.38. Local git is 2.50.1 (verified). Older git exits 129 with `unknown option` → falls into `unknown` with git's own text, which is exactly the right degradation (**R3** closed).
- `--name-only` output on exit 1 is the OID/conflict block followed by paths; parse defensively — split lines, drop empties, keep the trailing path list. If parsing yields zero paths, state stays `conflicted` with `files: []` (never downgraded to `clean`).
- `baseRef` null on the worktree row → `unknown`, reason `no base ref recorded`. No guessing `main`.

## 4. Event-loop fix (prerequisite, N1)

`src/integrations/git.ts:22` `defaultGitRunner` uses `spawnSync`. This feature adds a **network** `git fetch` to the ship path — under `spawnSync` that blocks the extension host for the whole round trip, freezing every other session's hook channel. CLAUDE.md bans `spawnSync` on the gate path for exactly this reason.

`GitRunner` is already `(args, cwd) => Promise<GitResult>`, so the swap is implementation-only — **zero call-site changes**.

```ts
export const defaultGitRunner: GitRunner = (args, cwd) =>
  new Promise((resolve) => {
    const child = spawn('git', args, { cwd });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, GIT_TIMEOUT_MS);
    // …collect, clearTimeout on settle, resolve {stdout, stderr, exitCode}
  });
```

- Pattern copied from `src/workflow/gates/run.ts:24` (`runCommand`), already proven and guarded by a test.
- Timeout (default 60_000 ms) → `exitCode: 1`, `stderr: 'git timed out after 60s'`. Required by F5; also closes **R2**.
- Never throws — the exit code is the answer, preserving the documented contract.

## 5. Schema — migration v9

`schema.sql` (fresh DBs) **and** a guarded step in `migrations.ts`, per the CLAUDE.md checklist.

```sql
-- Current mergeability of a ticket's branch against its base, per repo.
-- NOT append-only, unlike gate_runs/phase_marks, and deliberately so: this is
-- current state, not evidence of a past event. A stale 'clean' is a lie the
-- requirement explicitly forbids, so a re-check OVERWRITES.
CREATE TABLE IF NOT EXISTS merge_checks (
  ticket_id   INTEGER NOT NULL,   -- -> tickets.id
  repo        TEXT    NOT NULL,   -- matches worktrees.repo
  state       TEXT    NOT NULL,   -- clean | conflicted | unknown
  files       TEXT    NOT NULL,   -- JSON array of conflicting paths; '[]' when none
  reason      TEXT,               -- git's own message; NULL unless state='unknown'
  head_sha    TEXT,
  base_sha    TEXT,
  base_ref    TEXT,
  checked_at  TEXT    NOT NULL,
  PRIMARY KEY (ticket_id, repo)
);
```

- Key `(ticket_id, repo)`: conflict is per-repo (each worktree has its own `base_ref`), and one current answer per repo is exactly what F4 wants.
- **No backfill** — mergeability is a live property of two moving refs; a migration cannot know what it was, and synthesising rows would assert facts karst never observed. Pre-feature tickets show nothing until their next ship. Same reasoning as v7/v8, stated in the migration comment.
- `SCHEMA_VERSION` 8 → **9**.
- `db.test.ts`: bump every `user_version` assertion 8→9, add `merge_checks` to `EXPECTED_TABLES`, update "creates all 10 registry tables" → 11, add a v8→v9 upgrade test mirroring the existing v7→v8 one (**R4** closed).

## 6. Store API — `src/store/mergeChecks.ts`

```ts
export interface MergeCheckRow {
  ticketId: number; repo: string;
  state: MergeState; files: readonly string[]; reason: string | null;
  headSha: string | null; baseSha: string | null; baseRef: string | null;
  checkedAt: string;
}

export function setMergeCheck(store: Store, row: Omit<MergeCheckRow, 'checkedAt'> & { checkedAt?: string }): void;
export function listMergeChecksByTicket(store: Store, ticketId: number): MergeCheckRow[];
```

`setMergeCheck` is a single upsert:

```sql
INSERT INTO merge_checks (ticket_id, repo, state, files, reason, head_sha, base_sha, base_ref, checked_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(ticket_id, repo) DO UPDATE SET
  state=excluded.state, files=excluded.files, reason=excluded.reason,
  head_sha=excluded.head_sha, base_sha=excluded.base_sha,
  base_ref=excluded.base_ref, checked_at=excluded.checked_at
```

**Driver-agnostic** (positional `?` only, `store.db.prepare(...).run/all`, no named params, no `.pluck()`) — the CLI reaches this through `node:sqlite`, per CLAUDE.md.

`files` is JSON in, parsed out; a malformed/legacy value parses to `[]` rather than throwing (boundary validation).

## 7. Ship integration

In the per-worktree loop of `shipTicket`, after `pushBranch(git, wt.path)`:

```ts
const check = await checkMergeable(git, wt.path, wt.baseRef);
setMergeCheck(store, { ticketId: opts.ticketId, repo: wt.repo, ...check, baseRef: wt.baseRef });
```

- **After push, before/alongside PR open** — push updates the remote branch, so checking after it measures what a reviewer would actually see.
- Runs on the *idempotent-skip* path too (worktree with a prior open PR): a re-ship whose PRs already exist must still refresh mergeability, or F4 fails on exactly the re-run that motivates it. So the check happens **before** the `if (prior) continue` early-return.
- Written outside the `transition` transaction, on purpose. Research proposed the `premutate` hook; rejected on inspection — `premutate` fires once at transition time and cannot carry a per-worktree loop, and merge state is not part of the verdict it must land atomically with. A recorded check that survives a later ship failure is *more* useful, not less.
- Wrapped so a `setMergeCheck` failure cannot abort ship: the check is observability, ship is the operation.
- The stage outcome is unchanged — `transition(store, id, 'ship', { kind: 'passed' })` still runs regardless of merge state (pm.md decision).

## 8. Read-path wiring

| File | Change |
|---|---|
| `src/store/dashboard.ts` | none (PR query untouched) — merge checks load via their own `listMergeChecksByTicket` |
| `src/ui/dashboard/state.ts:103` | load `mergeChecks` alongside `prs`, pass into `buildStageInside` input |
| `src/model/inside/index.ts` | `StageInsideInput.mergeChecks?: readonly MergeCheckRow[]`; `shipInside` appends one op per check (ux.md table) |
| `src/context/ticketContext.ts` | `TicketContextPr.mergeCheck?: {...}`; `buildTicketContext` joins by repo; `renderTicketContext` suffixes the PR line |
| `src/cli/*` | none — inherits via `renderTicketContext` |

Every new field is **optional** and every renderer omits its output when absent → pre-feature tickets render byte-identically (A5).

## 9. Staleness (F4)

Two mechanisms, both cheap:

1. **Refresh on every ship** — ship re-runs the check unconditionally, including on the idempotent-skip path (§7). This is the primary mechanism.
2. **Stale detection at read** — the row stores `head_sha`/`base_sha`. A consumer that knows the current SHAs can mark a row stale. Phase 5 renders `(stale)` only where SHAs are already available; **no new git call is made from a read path** — reads stay pure and non-blocking.

Never presented: a `clean` older than the refs it was computed from, silently labelled current.

## 10. Testing strategy

| Suite | File | Covers |
|---|---|---|
| Unit | `src/workflow/mergeCheck.test.ts` | clean (exit 0) · conflicted + path parse (exit 1) · unknown: bad exit, spawn error, timeout, missing base ref, old-git `unknown option` · never throws · empty path list stays conflicted |
| Unit | `src/store/mergeChecks.test.ts` | insert · upsert overwrites (A4) · JSON round-trip · malformed JSON → `[]` · per-repo isolation |
| Unit | `src/integrations/git.test.ts` | async runner resolves; **leaves the event loop free while the child runs** (mirrors `gates/run.test.ts`) ; timeout path |
| Integration | `src/workflow/stages/ship.test.ts` | check runs per worktree with fake `GitRunner` · row written · conflict does NOT fail the stage (A6) · re-ship on existing-PR path still refreshes (F4) · `setMergeCheck` failure does not abort ship |
| Integration | `src/store/db.test.ts` | v9 version + table count · v8→v9 upgrade creates `merge_checks` |
| Render | `src/context/ticketContext.test.ts`, `src/model/inside/*.test.ts` | all three states rendered · absent check renders nothing (A5) |

Strict TDD: RED first for each. All fakes — no real repo, no network (N4).

## 11. Risk register (post-plan)

| # | Risk | Status |
|---|---|---|
| R1 | Conflict vs. no `failed` edge on ship | **Closed** — annotation only (pm.md) |
| R2 | `git fetch` latency/failure in extension host | **Closed** — async runner + timeout (§4) |
| R3 | git ≥ 2.38 requirement | **Closed** — degrades to `unknown` with git's text (§3) |
| R4 | `db.test.ts` assertions | **Closed** — enumerated in §5 |
| R5 | Ship slower by one fetch per repo | Accepted — bounded by timeout, off the UI thread, ship is already network-bound |
| R6 | `--name-only` output shape varies by git version | Mitigated — defensive parse; unparsable ⇒ `conflicted` with `[]`, never `clean` |
