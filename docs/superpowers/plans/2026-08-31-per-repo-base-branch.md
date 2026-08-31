# Per-Repo Base Branch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a ticket pick a base branch *per repository* — chosen before the ticket is spun, and changed live on a ticket that already has worktrees, branches and PRs.

**Architecture:** Today the base branch has exactly one source: the manifest (`repositories.<name>.baselineBranch ?? manifest.baselineBranch`, via `manifest/baselineBranch.ts`). The store already has a per-worktree column — `worktrees.base_ref` — but nothing reads it as authority: `confirmScope`/`spinTicket` write the manifest value into it, and every downstream consumer (`workflow/gates/targets.ts`, `workflow/stages/ship.ts`) re-derives from the manifest. This plan (1) adds a per-ticket, pre-spin override stored on the ticket (`tickets.base_refs`, JSON keyed by manifest repository NAME), (2) introduces ONE resolver (`workflow/baseRef.ts`) that reads worktree-row-first / ticket-override-second / manifest-last and routes every consumer through it, (3) adds the creation-time UI (a base-branch control on each scoped repo row in the ticket form), and (4) adds the live-change action (`runtime/rebaseWorktree.ts` + a dashboard action) that moves an existing branch to a new base, re-targets the open PR, and invalidates the stale merge check.

**Tech Stack:** TypeScript (ESM, `.js` import suffixes), better-sqlite3 / `node:sqlite`, vitest, VS Code webview HTML (no framework), injected `GitRunner` / `GhRunner` seams.

**Spec:** the ticket prompt of `TICKET-OFF-THE-BRANCH` (reproduced under "Requirements" below). There is no separate spec doc; the requirements section IS the spec this plan argues from.

## Requirements (verbatim from the ticket)

> Currently we're support only global settings for per repo base branch; but for some tasks there need for pick base branch for each repo;
>
> for example task touches 4 repos, 2 based from develop (as regularly for development), but 2 from specific feature branches because ther're on top of that branchs, like huge epic
>
> So we need to add posibilities:
> 1 for creation pick a base branch for repo (if it's known already, before start the ticket run)
> 2 for already spun ticket with WTs and branches make live changes to change base branch for repos (it should properly handle change of the base branch)
>
> In bothe cases need to invent proper UI with best UX

## Global Constraints

- **Host-agnostic:** no module added by this plan may `import 'vscode'`. Logic takes injected interfaces (`GitRunner`, `GhRunner`, `Store`, `debug`). `src/extension.ts` is the only place that binds real implementations.
- **No `spawnSync` on any path reachable from the extension host.** All git in this plan goes through the async injected `GitRunner`.
- **Strict TDD:** every task writes the failing test first, runs it, sees it fail, then implements. RED→GREEN.
- **Conventional commits**, one commit per task. Cite the UI rule id in the commit message when a change exists to satisfy one (UI-R35).
- **ESM:** every relative import ends in `.js`. `noUncheckedIndexedAccess` is on — array/record indexing needs `!` or a guard.
- **Files stay small:** <400 lines typical, 800 max.
- **New schema column checklist** (`docs/arch/store-and-schema.md`): `schema.sql` + a guarded ALTER in `migrations.ts` + bump `SCHEMA_VERSION` + update `db.test.ts`'s version/table-count assertions. Migrations never backfill data they cannot derive.
- **Shared `repoPath` invariant** (`docs/arch/worktrees-and-servers.md`): manifest entries may share a `repoPath` and then resolve to ONE worktree, which cannot have two branch points. Any per-repo base override must be validated the same way `assertSharedRepoBaselineBranches` validates the manifest.
- **`base_ref` stores the PLAIN branch name** (`develop`), never `origin/develop` — `mergeCheck` and the diff views prepend `origin/` themselves.
- **Debug logging:** new runtime paths get `logger.debug()` via an INJECTED callback with the module prefix `[runtime]` (rebase) / `[merge]` (PR retarget). Never import the logger from a vscode-free module.
- **UI:** every webview change is judged against `docs/ui/UI-RULES.md` v3.0; tokens from `docs/ui/DESIGN-SYSTEM.md`; copy tone from `docs/ui/STYLE-GUIDE.md`. Read `docs/ui/UI-INVARIANTS.md` before touching a webview.

## File Structure

**Created:**
- `src/workflow/baseRef.ts` — the ONE resolver. `resolveTicketBaseRef` (post-spin, worktree-row authoritative) and `resolvePlannedBaseRef` (pre-spin, ticket-override authoritative), plus `assertSharedRepoBaseOverrides`.
- `src/workflow/baseRef.test.ts`
- `src/runtime/branchList.ts` — list candidate base branches for a repoPath (local + `origin/*`, deduped, sorted, current-manifest-default first).
- `src/runtime/branchList.test.ts`
- `src/runtime/rebaseWorktree.ts` — move an existing ticket branch from one base to another: preflight (clean tree), fetch, `git rebase --onto`, abort-on-conflict, structured result.
- `src/runtime/rebaseWorktree.test.ts`
- `src/workflow/changeBaseRef.ts` — the orchestration for the live change: resolve old base → rebase (optional) → write `worktrees.base_ref` → retarget open PR → invalidate merge check.
- `src/workflow/changeBaseRef.test.ts`

**Modified:**
- `src/store/schema.sql` — `tickets.base_refs TEXT`.
- `src/store/migrations.ts` — guarded ALTER, `SCHEMA_VERSION` 47 → 48.
- `src/store/db.test.ts` — version assertion.
- `src/store/tickets.ts` — parse/write `base_refs` as `baseRefs: Record<string,string>`.
- `src/store/worktrees.ts` (or wherever `worktrees` writes live — see Task 5) — `setWorktreeBaseRef`.
- `src/store/mergeChecks.ts` — `clearMergeCheck(store, ticketId, repo)`.
- `src/integrations/github.ts` — `updatePrBase`.
- `src/workflow/stages/scope.ts` — `confirmScope` resolves via `resolvePlannedBaseRef`.
- `src/runtime/spin.ts` — same at line ~188.
- `src/workflow/gates/targets.ts:197` and `src/workflow/stages/ship.ts:818,1078` — read `resolveTicketBaseRef`.
- `src/ui/ticketForm/messages.ts`, `state.ts`, `actions.ts`, `webview.html` — creation-time picker.
- `src/ui/dashboard/messages.ts`, `state.ts`, `panel.ts`, `webview.html` — live-change action.
- `src/extension.ts` — bind branch listing, the change-base command, the debug callbacks.
- `docs/arch/worktrees-and-servers.md`, `docs/arch/store-and-schema.md` — record the new invariant.

---

### Task 1: The resolver and its ordering

**Files:**
- Create: `src/workflow/baseRef.ts`
- Test: `src/workflow/baseRef.test.ts`

**Interfaces:**
- Consumes: `Manifest`, `RepositoryDef` (`src/manifest/types.js`), `resolveBaselineBranch` / `resolveBaselineBranchForPath` (`src/manifest/baselineBranch.js`), `Store` (`src/store/db.js`), `getTicket` (`src/store/tickets.js`).
- Produces:
  - `resolvePlannedBaseRef(ticket: { baseRefs: Record<string, string> }, manifest: Manifest, repoName: string): string`
  - `resolveTicketBaseRef(store: Store, ticketId: number, repoPath: string, manifest: Manifest): string`
  - `assertSharedRepoBaseOverrides(manifest: Manifest, baseRefs: Record<string, string>): void` (throws `Error` naming the two entries)

- [ ] **Step 1: Write the failing test**

```ts
// src/workflow/baseRef.test.ts
import { describe, expect, it } from 'vitest';
import { openStore } from '../store/db.js';
import { createTicket, updateTicketFields } from '../store/tickets.js';
import { fixtureManifest } from '../manifest/fixtures.js';
import {
  assertSharedRepoBaseOverrides,
  resolvePlannedBaseRef,
  resolveTicketBaseRef,
} from './baseRef.js';

describe('resolvePlannedBaseRef', () => {
  it('prefers the ticket override over the manifest default', () => {
    const manifest = fixtureManifest();
    expect(resolvePlannedBaseRef({ baseRefs: { api: 'epic/checkout' } }, manifest, 'api')).toBe(
      'epic/checkout',
    );
  });

  it('falls back to the manifest when there is no override', () => {
    const manifest = fixtureManifest();
    expect(resolvePlannedBaseRef({ baseRefs: {} }, manifest, 'api')).toBe(
      manifest.repositories.api!.baselineBranch ?? manifest.baselineBranch,
    );
  });

  it('ignores a blank override — an empty string is not a branch', () => {
    const manifest = fixtureManifest();
    expect(resolvePlannedBaseRef({ baseRefs: { api: '  ' } }, manifest, 'api')).toBe(
      manifest.repositories.api!.baselineBranch ?? manifest.baselineBranch,
    );
  });
});

describe('resolveTicketBaseRef', () => {
  it('reads the worktree row first — the branch was already cut from it', () => {
    const store = openStore(':memory:');
    const manifest = fixtureManifest();
    const repoPath = manifest.repositories.api!.repoPath;
    const id = createTicket(store, { key: 'K-1', title: 't' });
    store.db
      .prepare(
        `INSERT INTO worktrees (ticket_id, repo, path, branch, base_ref, deps_mode)
         VALUES (?, ?, ?, ?, ?, 'inherited')`,
      )
      .run(id, repoPath, '/tmp/wt', 'karst/feat/k-1', 'epic/checkout');
    expect(resolveTicketBaseRef(store, id, repoPath, manifest)).toBe('epic/checkout');
  });

  it('falls back to the ticket override before the worktree exists', () => {
    const store = openStore(':memory:');
    const manifest = fixtureManifest();
    const id = createTicket(store, { key: 'K-2', title: 't' });
    updateTicketFields(store, id, { baseRefs: { api: 'epic/checkout' } });
    expect(resolveTicketBaseRef(store, id, manifest.repositories.api!.repoPath, manifest)).toBe(
      'epic/checkout',
    );
  });

  it('falls back to the manifest when neither exists', () => {
    const store = openStore(':memory:');
    const manifest = fixtureManifest();
    const id = createTicket(store, { key: 'K-3', title: 't' });
    expect(resolveTicketBaseRef(store, id, manifest.repositories.api!.repoPath, manifest)).toBe(
      manifest.repositories.api!.baselineBranch ?? manifest.baselineBranch,
    );
  });
});

describe('assertSharedRepoBaseOverrides', () => {
  it('rejects two entries at one repoPath resolving to different bases', () => {
    const manifest = fixtureManifest();
    const [a, b] = Object.keys(manifest.repositories);
    // Force the two entries to share a repoPath for the purposes of the check.
    const shared = {
      ...manifest,
      repositories: {
        ...manifest.repositories,
        [b!]: { ...manifest.repositories[b!]!, repoPath: manifest.repositories[a!]!.repoPath },
      },
    };
    expect(() =>
      assertSharedRepoBaseOverrides(shared, { [a!]: 'epic/one', [b!]: 'epic/two' }),
    ).toThrow(/share repoPath/);
  });

  it('accepts two entries at one repoPath resolving to the same base', () => {
    const manifest = fixtureManifest();
    const [a, b] = Object.keys(manifest.repositories);
    const shared = {
      ...manifest,
      repositories: {
        ...manifest.repositories,
        [b!]: { ...manifest.repositories[b!]!, repoPath: manifest.repositories[a!]!.repoPath },
      },
    };
    expect(() =>
      assertSharedRepoBaseOverrides(shared, { [a!]: 'epic/one', [b!]: 'epic/one' }),
    ).not.toThrow();
  });
});
```

Note: read `src/manifest/fixtures.ts` first and use the real fixture factory name and repository keys it exports; if the fixture's repository entry is not called `api`, substitute the actual key throughout this test. If `fixtureManifest` has a different name, use the exported one — do not add a new fixture.

- [ ] **Step 2: Run the test and watch it fail**

Run: `npx vitest run src/workflow/baseRef.test.ts`
Expected: FAIL — `Cannot find module './baseRef.js'`.

- [ ] **Step 3: Implement the resolver**

```ts
// src/workflow/baseRef.ts
import type { Store } from '../store/db.js';
import type { Manifest } from '../manifest/types.js';
import { resolveBaselineBranch, resolveBaselineBranchForPath } from '../manifest/baselineBranch.js';
import { getTicket } from '../store/tickets.js';

/**
 * The ONE place a ticket's base branch is decided.
 *
 * Order is load-bearing:
 *   1. `worktrees.base_ref` — the branch was ALREADY cut from it, so it is the
 *      only answer that matches what git actually did. Changing the manifest
 *      later must not silently retarget an existing PR.
 *   2. the ticket's own pre-spin override (`tickets.base_refs`, keyed by
 *      manifest repository NAME).
 *   3. the manifest default (`repositories.<name>.baselineBranch ?? baselineBranch`).
 *
 * Every value here is a PLAIN branch name; consumers prepend `origin/`.
 */

const nonBlank = (value: string | undefined): string | null => {
  const trimmed = value?.trim() ?? '';
  return trimmed === '' ? null : trimmed;
};

export function resolvePlannedBaseRef(
  ticket: { baseRefs?: Record<string, string> },
  manifest: Manifest,
  repoName: string,
): string {
  const override = nonBlank(ticket.baseRefs?.[repoName]);
  if (override) return override;
  const repository = manifest.repositories[repoName];
  return repository ? resolveBaselineBranch(manifest, repository) : manifest.baselineBranch;
}

export function resolveTicketBaseRef(
  store: Store,
  ticketId: number,
  repoPath: string,
  manifest: Manifest,
): string {
  const row = store.db
    .prepare('SELECT base_ref FROM worktrees WHERE ticket_id = ? AND repo = ? LIMIT 1')
    .get(ticketId, repoPath) as { base_ref: string | null } | undefined;
  const stored = nonBlank(row?.base_ref ?? undefined);
  if (stored) return stored;

  const ticket = getTicket(store, ticketId);
  if (ticket) {
    for (const [name, repository] of Object.entries(manifest.repositories)) {
      if (repository.repoPath !== repoPath) continue;
      const override = nonBlank(ticket.baseRefs?.[name]);
      if (override) return override;
    }
  }
  return resolveBaselineBranchForPath(manifest, repoPath);
}

/**
 * Manifest entries may share a `repoPath` — one deduped worktree, which cannot
 * have two branch points. The manifest enforces this for its own defaults
 * (`assertSharedRepoBaselineBranches`); a per-ticket override can break it the
 * same way, so it is checked before the override is stored.
 */
export function assertSharedRepoBaseOverrides(
  manifest: Manifest,
  baseRefs: Record<string, string>,
): void {
  const seen = new Map<string, { name: string; branch: string }>();
  for (const [name, repository] of Object.entries(manifest.repositories)) {
    const branch = resolvePlannedBaseRef({ baseRefs }, manifest, name);
    const prior = seen.get(repository.repoPath);
    if (prior && prior.branch !== branch) {
      throw new Error(
        `repositories "${prior.name}" and "${name}" share repoPath "${repository.repoPath}" ` +
          `but were given different base branches ("${prior.branch}" and "${branch}")`,
      );
    }
    seen.set(repository.repoPath, { name, branch });
  }
}
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `npx vitest run src/workflow/baseRef.test.ts`
Expected: PASS (the `resolveTicketBaseRef` cases that use `baseRefs` will still fail until Task 2 — if so, land Task 2 first and re-run; the ordering below assumes you do Task 2 first if the store field does not exist yet).

- [ ] **Step 5: Commit**

```bash
git add src/workflow/baseRef.ts src/workflow/baseRef.test.ts
git commit -m "feat(base-ref): add the single per-repo base branch resolver"
```

---

### Task 2: Store the pre-spin override (`tickets.base_refs`)

**Files:**
- Modify: `src/store/schema.sql`
- Modify: `src/store/migrations.ts` (`SCHEMA_VERSION`, new guarded ALTER at the end of `migrate`)
- Modify: `src/store/tickets.ts`
- Modify: `src/store/db.test.ts` (the version assertion)
- Test: `src/store/tickets.test.ts`

**Interfaces:**
- Consumes: the existing `selected_repos` JSON-column pattern in `tickets.ts` (`parseSelectedRepos`, the `columns` map in `updateTicketFields`).
- Produces: `Ticket.baseRefs: Record<string, string>` (always an object, `{}` when unset/invalid) and `updateTicketFields(store, id, { baseRefs })`.

- [ ] **Step 1: Write the failing test**

Append to `src/store/tickets.test.ts`:

```ts
describe('baseRefs', () => {
  it('defaults to an empty object', () => {
    const store = openStore(':memory:');
    const id = createTicket(store, { key: 'B-1', title: 't' });
    expect(getTicket(store, id)!.baseRefs).toEqual({});
  });

  it('round-trips a per-repo override', () => {
    const store = openStore(':memory:');
    const id = createTicket(store, { key: 'B-2', title: 't' });
    updateTicketFields(store, id, { baseRefs: { api: 'epic/checkout', web: 'develop' } });
    expect(getTicket(store, id)!.baseRefs).toEqual({ api: 'epic/checkout', web: 'develop' });
  });

  it('tolerates a corrupt column, exactly like selected_repos', () => {
    const store = openStore(':memory:');
    const id = createTicket(store, { key: 'B-3', title: 't' });
    store.db.prepare('UPDATE tickets SET base_refs = ? WHERE id = ?').run('not json', id);
    expect(getTicket(store, id)!.baseRefs).toEqual({});
  });

  it('drops non-string values rather than trusting the column', () => {
    const store = openStore(':memory:');
    const id = createTicket(store, { key: 'B-4', title: 't' });
    store.db
      .prepare('UPDATE tickets SET base_refs = ? WHERE id = ?')
      .run(JSON.stringify({ api: 3, web: 'develop' }), id);
    expect(getTicket(store, id)!.baseRefs).toEqual({ web: 'develop' });
  });
});
```

Use the same imports the surrounding file already has; do not add a second `openStore` import.

- [ ] **Step 2: Run the test and watch it fail**

Run: `npx vitest run src/store/tickets.test.ts -t baseRefs`
Expected: FAIL — `no such column: base_refs`.

- [ ] **Step 3: Implement the column**

In `src/store/schema.sql`, add to the `tickets` table definition, beside `selected_repos`:

```sql
  base_refs       TEXT,
```

In `src/store/migrations.ts`, bump the version:

```ts
export const SCHEMA_VERSION = 48;
```

and add a guarded step immediately before the final `db.pragma(\`user_version = ${SCHEMA_VERSION}\`);`, following the existing guarded-ALTER style in that file (guards read the CURRENT columns via `tableColumns`, so a fresh DB skips the step and a re-open is a no-op):

```ts
  // v48 — per-repo base branch chosen before the ticket is spun. Nothing to
  // backfill: an absent value means "use the manifest default", which is
  // exactly what every pre-v48 ticket did.
  if (!tableColumns(db, 'tickets').includes('base_refs')) {
    db.exec('ALTER TABLE tickets ADD COLUMN base_refs TEXT');
  }
```

In `src/store/tickets.ts`:

```ts
/** Parse the `base_refs` JSON column into a record, tolerating bad data. */
function parseBaseRefs(raw: string | null): Record<string, string> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === 'string' && value.trim() !== '') out[key] = value.trim();
    }
    return out;
  } catch {
    return {};
  }
}
```

- add `base_refs: string | null;` to the row interface (beside `selected_repos`),
- add `/** Parsed from the `base_refs` JSON column; `{}` when unset/invalid. */ baseRefs: Record<string, string>;` to the `Ticket` interface,
- add `baseRefs: parseBaseRefs(r.base_refs),` to the row→`Ticket` mapping,
- add `baseRefs?: Record<string, string>;` to the update-patch interface,
- add to `updateTicketFields`:

```ts
  if (patch.baseRefs !== undefined) {
    columns.base_refs = JSON.stringify(patch.baseRefs);
  }
```

Then update the `SCHEMA_VERSION` expectation in `src/store/db.test.ts` (search it for `47`).

- [ ] **Step 4: Run the tests and watch them pass**

Run: `npx vitest run src/store/tickets.test.ts src/store/db.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the whole Task 1 suite now that the field exists**

Run: `npx vitest run src/workflow/baseRef.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/store/schema.sql src/store/migrations.ts src/store/tickets.ts src/store/tickets.test.ts src/store/db.test.ts
git commit -m "feat(store): add tickets.base_refs for pre-spin per-repo base branches"
```

---

### Task 3: Route every consumer through the resolver

**Files:**
- Modify: `src/workflow/stages/scope.ts:96`
- Modify: `src/runtime/spin.ts:188`
- Modify: `src/workflow/gates/targets.ts:197`
- Modify: `src/workflow/stages/ship.ts:818` and `:1078`
- Test: `src/workflow/stages/scope.test.ts`, `src/workflow/gates/targets.test.ts`

**Interfaces:**
- Consumes: `resolvePlannedBaseRef`, `resolveTicketBaseRef` (Task 1); `Ticket.baseRefs` (Task 2).
- Produces: no new exports — behavior change only. After this task, `worktrees.base_ref` is the authority for every post-spin consumer.

- [ ] **Step 1: Write the failing tests**

In `src/workflow/stages/scope.test.ts`, add:

```ts
it('cuts the worktree from the ticket override, not the manifest default', async () => {
  const store = openStore(':memory:');
  const manifest = fixtureManifest();
  const id = createTicket(store, { key: 'S-1', title: 'scoped' });
  updateTicketFields(store, id, { baseRefs: { api: 'epic/checkout' } });

  const calls: string[][] = [];
  const git: GitRunner = async (args) => {
    calls.push(args);
    return { stdout: '', stderr: '', exitCode: 0 };
  };

  const [record] = await confirmScope(store, manifest, id, ['api'], { git });

  expect(record!.baseRef).toBe('epic/checkout');
  expect(calls.some((a) => a.join(' ').includes('epic/checkout'))).toBe(true);
});
```

In `src/workflow/gates/targets.test.ts`, add:

```ts
it('reports the worktree row base, not the manifest default', () => {
  // Arrange a ticket whose worktrees row records `epic/checkout` while the
  // manifest still says `develop`, then assert the target carries the row value.
  // (Mirror the arrangement the neighbouring tests in this file already use.)
});
```

Fill that second test in against the real shape of `targets.ts`'s exported function and its existing test helpers — read the file and its neighbouring tests first, then write real assertions. Do not leave the comment body in place.

- [ ] **Step 2: Run the tests and watch them fail**

Run: `npx vitest run src/workflow/stages/scope.test.ts src/workflow/gates/targets.test.ts`
Expected: FAIL — the base is the manifest default (`develop`), not `epic/checkout`.

- [ ] **Step 3: Change the five call sites**

`src/workflow/stages/scope.ts` — replace the `resolveBaselineBranch` import with `resolvePlannedBaseRef` from `../baseRef.js`, hoist the ticket read (the function already calls `getTicket` for `ticketWorktreeNames`), and change line 96:

```ts
const ticket = getTicket(store, ticketId);
const { slug, branch } = ticketWorktreeNames(ticket, manifest);
// ...
const baseRef = resolvePlannedBaseRef(ticket, manifest, name);
```

`src/runtime/spin.ts:188` — same substitution; `spinTicket` already has the ticket in scope for its slug/branch, so reuse that value rather than re-reading:

```ts
baseRef: resolvePlannedBaseRef(ticket, manifest, name),
```

`src/workflow/gates/targets.ts:197` — replace

```ts
const base = resolveBaselineBranchForPath(manifest, worktree.repo);
```

with

```ts
const base = resolveTicketBaseRef(store, ticketId, worktree.repo, manifest);
```

Thread `store` and `ticketId` in if the function does not already have them; both are already available to every caller of `targets.ts` (a gate always runs for one ticket). If threading them would change a public signature, add them as required fields on the existing options interface rather than inventing a second entry point.

`src/workflow/stages/ship.ts:818` and `:1078` — the same substitution, using the `store`/`ticketId` already in scope at both sites.

- [ ] **Step 4: Run the tests and watch them pass**

Run: `npx vitest run src/workflow/stages/scope.test.ts src/workflow/gates/targets.test.ts src/workflow/stages/ship.test.ts src/runtime/spin.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/workflow/stages/scope.ts src/runtime/spin.ts src/workflow/gates/targets.ts src/workflow/stages/ship.ts src/workflow/stages/scope.test.ts src/workflow/gates/targets.test.ts
git commit -m "feat(base-ref): resolve the base branch per ticket and repo, worktree row first"
```

---

### Task 4: List candidate base branches for a repo

**Files:**
- Create: `src/runtime/branchList.ts`
- Test: `src/runtime/branchList.test.ts`

**Interfaces:**
- Consumes: `GitRunner` (`src/integrations/git.js`).
- Produces: `listBaseBranchCandidates(git: GitRunner, repoPath: string, opts?: { signal?: AbortSignal }): Promise<string[]>` — plain branch names, deduped, `origin/` stripped, `HEAD` dropped, sorted alphabetically.

- [ ] **Step 1: Write the failing test**

```ts
// src/runtime/branchList.test.ts
import { describe, expect, it } from 'vitest';
import type { GitRunner } from '../integrations/git.js';
import { listBaseBranchCandidates } from './branchList.js';

const runner = (stdout: string, exitCode = 0): GitRunner => async () => ({
  stdout,
  stderr: '',
  exitCode,
});

describe('listBaseBranchCandidates', () => {
  it('strips the remote prefix and dedupes local against remote', async () => {
    const git = runner(
      ['develop', 'main', 'origin/develop', 'origin/epic/checkout', 'origin/HEAD'].join('\n'),
    );
    expect(await listBaseBranchCandidates(git, '/repo')).toEqual([
      'develop',
      'epic/checkout',
      'main',
    ]);
  });

  it('answers an empty list rather than throwing when git fails', async () => {
    expect(await listBaseBranchCandidates(runner('', 128), '/repo')).toEqual([]);
  });

  it('ignores blank lines and surrounding whitespace', async () => {
    expect(await listBaseBranchCandidates(runner('  main  \n\n develop \n'), '/repo')).toEqual([
      'develop',
      'main',
    ]);
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `npx vitest run src/runtime/branchList.test.ts`
Expected: FAIL — `Cannot find module './branchList.js'`.

- [ ] **Step 3: Implement**

```ts
// src/runtime/branchList.ts
import type { GitRunner, GitRunOptions } from '../integrations/git.js';

const REMOTE_PREFIX = 'origin/';

/**
 * The branches a ticket may be based on, for a picker. Local heads AND
 * `origin/*` — an epic branch usually exists only on the remote in a fresh
 * clone — reduced to PLAIN names, because that is what `worktrees.base_ref`
 * stores and what every consumer re-prefixes itself.
 *
 * Never throws: a picker that cannot list branches still has to render, and the
 * field stays free-text so an unlisted branch is always reachable.
 */
export async function listBaseBranchCandidates(
  git: GitRunner,
  repoPath: string,
  opts: GitRunOptions = {},
): Promise<string[]> {
  const result = await git(
    ['for-each-ref', '--format=%(refname:short)', 'refs/heads', 'refs/remotes/origin'],
    repoPath,
    opts,
  ).catch(() => null);
  if (!result || result.exitCode !== 0) return [];

  const names = new Set<string>();
  for (const line of result.stdout.split('\n')) {
    const raw = line.trim();
    if (raw === '') continue;
    const name = raw.startsWith(REMOTE_PREFIX) ? raw.slice(REMOTE_PREFIX.length) : raw;
    if (name === '' || name === 'HEAD') continue;
    names.add(name);
  }
  return [...names].sort((a, b) => a.localeCompare(b));
}
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `npx vitest run src/runtime/branchList.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/runtime/branchList.ts src/runtime/branchList.test.ts
git commit -m "feat(runtime): list local and origin branches as base-branch candidates"
```

---

### Task 5: Move an existing branch to a new base

**Files:**
- Create: `src/runtime/rebaseWorktree.ts`
- Test: `src/runtime/rebaseWorktree.test.ts`

**Interfaces:**
- Consumes: `GitRunner`.
- Produces:
```ts
export type RebaseOutcome = 'rebased' | 'already-based' | 'dirty' | 'fetch-failed' | 'conflict' | 'failed';
export interface RebaseResult {
  outcome: RebaseOutcome;
  /** Human-readable reason; '' on success. Git's own words when git refused. */
  reason: string;
}
export interface RebaseWorktreeOpts {
  git: GitRunner;
  /** The ticket's worktree path — the rebase runs THERE, never in the main checkout. */
  cwd: string;
  fromBase: string;
  toBase: string;
  debug?: (line: string) => void;
}
export function rebaseWorktreeOntoBase(opts: RebaseWorktreeOpts): Promise<RebaseResult>;
```

- [ ] **Step 1: Write the failing test**

```ts
// src/runtime/rebaseWorktree.test.ts
import { describe, expect, it } from 'vitest';
import type { GitResult, GitRunner } from '../integrations/git.js';
import { rebaseWorktreeOntoBase } from './rebaseWorktree.js';

const ok = (stdout = ''): GitResult => ({ stdout, stderr: '', exitCode: 0 });
const fail = (stderr: string, exitCode = 1): GitResult => ({ stdout: '', stderr, exitCode });

/** Scripts one reply per `git` sub-command, and records the call order. */
function scripted(replies: Record<string, GitResult>): { git: GitRunner; calls: string[][] } {
  const calls: string[][] = [];
  const git: GitRunner = async (args) => {
    calls.push(args);
    for (const [prefix, reply] of Object.entries(replies)) {
      if (args.join(' ').startsWith(prefix)) return reply;
    }
    return ok();
  };
  return { git, calls };
}

describe('rebaseWorktreeOntoBase', () => {
  it('is a no-op when the base has not changed', async () => {
    const { git, calls } = scripted({});
    const r = await rebaseWorktreeOntoBase({ git, cwd: '/wt', fromBase: 'develop', toBase: 'develop' });
    expect(r.outcome).toBe('already-based');
    expect(calls).toEqual([]);
  });

  it('refuses a dirty worktree before touching anything', async () => {
    const { git, calls } = scripted({ 'status --porcelain': ok(' M src/a.ts\n') });
    const r = await rebaseWorktreeOntoBase({ git, cwd: '/wt', fromBase: 'develop', toBase: 'epic/x' });
    expect(r.outcome).toBe('dirty');
    expect(calls.some((a) => a[0] === 'rebase')).toBe(false);
  });

  it('reports a fetch failure without rebasing', async () => {
    const { git, calls } = scripted({
      'status --porcelain': ok(''),
      fetch: fail('could not resolve host github.com'),
    });
    const r = await rebaseWorktreeOntoBase({ git, cwd: '/wt', fromBase: 'develop', toBase: 'epic/x' });
    expect(r.outcome).toBe('fetch-failed');
    expect(r.reason).toContain('could not resolve host');
    expect(calls.some((a) => a[0] === 'rebase')).toBe(false);
  });

  it('rebases --onto the new base from the old one', async () => {
    const { git, calls } = scripted({ 'status --porcelain': ok('') });
    const r = await rebaseWorktreeOntoBase({ git, cwd: '/wt', fromBase: 'develop', toBase: 'epic/x' });
    expect(r.outcome).toBe('rebased');
    expect(calls).toContainEqual([
      'rebase',
      '--onto',
      'origin/epic/x',
      'origin/develop',
    ]);
  });

  it('aborts and reports a conflict, leaving no rebase in progress', async () => {
    const { git, calls } = scripted({
      'status --porcelain': ok(''),
      rebase: fail('CONFLICT (content): Merge conflict in src/a.ts'),
    });
    const r = await rebaseWorktreeOntoBase({ git, cwd: '/wt', fromBase: 'develop', toBase: 'epic/x' });
    expect(r.outcome).toBe('conflict');
    expect(r.reason).toContain('CONFLICT');
    expect(calls).toContainEqual(['rebase', '--abort']);
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `npx vitest run src/runtime/rebaseWorktree.test.ts`
Expected: FAIL — `Cannot find module './rebaseWorktree.js'`.

- [ ] **Step 3: Implement**

```ts
// src/runtime/rebaseWorktree.ts
import type { GitResult, GitRunner } from '../integrations/git.js';

const REMOTE = 'origin';

export type RebaseOutcome =
  | 'rebased'
  | 'already-based'
  | 'dirty'
  | 'fetch-failed'
  | 'conflict'
  | 'failed';

export interface RebaseResult {
  outcome: RebaseOutcome;
  /** Git's own words when git refused; '' on success. */
  reason: string;
}

export interface RebaseWorktreeOpts {
  git: GitRunner;
  /** The TICKET's worktree — the rebase never runs in the main checkout. */
  cwd: string;
  fromBase: string;
  toBase: string;
  debug?: (line: string) => void;
}

const words = (r: GitResult): string => r.stderr.trim() || r.stdout.trim() || `git exit ${r.exitCode}`;

/**
 * Move a ticket's branch off `fromBase` and onto `toBase`.
 *
 * `--onto` is the whole point: a plain `git rebase origin/<new>` would replay
 * every commit the OLD base had that the new one lacks, so the ticket's PR would
 * grow the epic's history. `--onto origin/<new> origin/<old>` replays exactly the
 * commits this branch added.
 *
 * Refuses rather than risks: a dirty tree is a refusal (a rebase would stash or
 * fail halfway), and a conflict is ABORTED, so the caller never inherits a
 * worktree with a rebase in progress. Every outcome is reported; nothing here
 * throws.
 */
export async function rebaseWorktreeOntoBase(opts: RebaseWorktreeOpts): Promise<RebaseResult> {
  const { git, cwd, fromBase, toBase, debug } = opts;
  if (fromBase.trim() === toBase.trim()) {
    return { outcome: 'already-based', reason: '' };
  }
  debug?.(`[runtime] rebase ${cwd}: ${fromBase} -> ${toBase}`);

  const status = await git(['status', '--porcelain'], cwd);
  if (status.exitCode !== 0) {
    return { outcome: 'failed', reason: words(status) };
  }
  if (status.stdout.trim() !== '') {
    debug?.(`[runtime] rebase ${cwd}: refused — worktree dirty`);
    return {
      outcome: 'dirty',
      reason: 'the worktree has uncommitted changes — commit or discard them first',
    };
  }

  const fetched = await git(['fetch', REMOTE, toBase], cwd);
  if (fetched.exitCode !== 0) {
    debug?.(`[runtime] rebase ${cwd}: fetch failed`);
    return { outcome: 'fetch-failed', reason: words(fetched) };
  }

  const rebased = await git(
    ['rebase', '--onto', `${REMOTE}/${toBase}`, `${REMOTE}/${fromBase}`],
    cwd,
  );
  if (rebased.exitCode !== 0) {
    const reason = words(rebased);
    // Leave no rebase in progress: the next thing to touch this tree (a gate, the
    // agent, ship) would otherwise fail with a message about an unrelated state.
    await git(['rebase', '--abort'], cwd);
    const conflicted = /conflict/i.test(reason);
    debug?.(`[runtime] rebase ${cwd}: ${conflicted ? 'conflict' : 'failed'} — aborted`);
    return { outcome: conflicted ? 'conflict' : 'failed', reason };
  }

  debug?.(`[runtime] rebase ${cwd}: rebased onto ${toBase}`);
  return { outcome: 'rebased', reason: '' };
}
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `npx vitest run src/runtime/rebaseWorktree.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/runtime/rebaseWorktree.ts src/runtime/rebaseWorktree.test.ts
git commit -m "feat(runtime): rebase a ticket worktree from one base branch onto another"
```

---

### Task 6: Retarget an open PR

**Files:**
- Modify: `src/integrations/github.ts`
- Test: `src/integrations/github.test.ts`

**Interfaces:**
- Consumes: `GhRunner`, `PrEditAttempt` (both already in `github.ts`).
- Produces: `updatePrBase(gh: GhRunner, ref: string, cwd: string, base: string): Promise<PrEditAttempt>`.

- [ ] **Step 1: Write the failing test**

Append to `src/integrations/github.test.ts`:

```ts
describe('updatePrBase', () => {
  it('edits the PR base and reports success', async () => {
    const calls: string[][] = [];
    const gh: GhRunner = async (args) => {
      calls.push(args);
      return { stdout: '', stderr: '', exitCode: 0 };
    };
    expect(await updatePrBase(gh, '42', '/wt', 'epic/checkout')).toEqual({ ok: true, reason: '' });
    expect(calls).toEqual([['pr', 'edit', '42', '--base', 'epic/checkout']]);
  });

  it('reports gh’s refusal verbatim instead of throwing', async () => {
    const gh: GhRunner = async () => ({ stdout: '', stderr: 'no write access', exitCode: 1 });
    expect(await updatePrBase(gh, '42', '/wt', 'epic/checkout')).toEqual({
      ok: false,
      reason: 'no write access',
    });
  });

  it('turns a thrown runner into a reason', async () => {
    const gh: GhRunner = async () => {
      throw new Error('gh not installed');
    };
    expect((await updatePrBase(gh, '42', '/wt', 'main')).reason).toBe('gh not installed');
  });
});
```

Add `updatePrBase` to the existing import from `./github.js` at the top of that test file.

- [ ] **Step 2: Run the test and watch it fail**

Run: `npx vitest run src/integrations/github.test.ts -t updatePrBase`
Expected: FAIL — `updatePrBase is not a function`.

- [ ] **Step 3: Implement, directly beneath `updatePrBody`**

```ts
/**
 * Re-target an open PR at a different base branch via `gh pr edit --base`.
 *
 * Result, never a throw — for the same reason as `updatePrBody`: this runs
 * against a PR that is already open, so a refusal (no write permission, a dead
 * network) is a note on an otherwise-successful base change, not an exception
 * that parks the ticket.
 */
export async function updatePrBase(
  gh: GhRunner,
  ref: string,
  cwd: string,
  base: string,
): Promise<PrEditAttempt> {
  let r: GhResult;
  try {
    r = await gh(['pr', 'edit', ref, '--base', base], cwd);
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
  if (r.exitCode === 0) return { ok: true, reason: '' };
  return { ok: false, reason: r.stderr?.trim() || r.stdout.trim() || `gh exit ${r.exitCode}` };
}
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `npx vitest run src/integrations/github.test.ts -t updatePrBase`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/integrations/github.ts src/integrations/github.test.ts
git commit -m "feat(github): re-target an open PR at a new base branch"
```

---

### Task 7: Orchestrate the live change

**Files:**
- Create: `src/workflow/changeBaseRef.ts`
- Test: `src/workflow/changeBaseRef.test.ts`
- Modify: `src/store/mergeChecks.ts` (add `clearMergeCheck`)

**Interfaces:**
- Consumes: `resolveTicketBaseRef` (Task 1), `rebaseWorktreeOntoBase` (Task 5), `updatePrBase` (Task 6), `listPrsForTicket`-style reads already in `src/store/prs.ts` (read that file and use the existing accessor that yields `{ repo, number, status, cwd }`), `Store`.
- Produces:
```ts
export interface ChangeBaseRefOpts {
  store: Store;
  manifest: Manifest;
  ticketId: number;
  /** The worktree's repoPath — base refs are per WORKTREE, so per repoPath. */
  repoPath: string;
  toBase: string;
  /** Rebase the branch onto the new base. Default true. */
  rebase?: boolean;
  git: GitRunner;
  gh?: GhRunner;
  debug?: (line: string) => void;
}
export interface ChangeBaseRefResult {
  ok: boolean;
  fromBase: string;
  toBase: string;
  rebase: RebaseResult | null;
  /** null when the ticket has no open PR for this repo. */
  prRetarget: (PrEditAttempt & { number: number }) | null;
  reason: string;
}
export function changeBaseRef(opts: ChangeBaseRefOpts): Promise<ChangeBaseRefResult>;
```

**Ordering is the contract:** rebase FIRST, and only write `worktrees.base_ref` if the rebase succeeded (or was skipped). A stored base that git never moved to is the one state that silently corrupts every downstream diff, gate target and PR.

- [ ] **Step 1: Write the failing test**

```ts
// src/workflow/changeBaseRef.test.ts
import { describe, expect, it } from 'vitest';
import { openStore } from '../store/db.js';
import { createTicket } from '../store/tickets.js';
import { fixtureManifest } from '../manifest/fixtures.js';
import type { GitRunner } from '../integrations/git.js';
import { changeBaseRef } from './changeBaseRef.js';

function seed(baseRef = 'develop') {
  const store = openStore(':memory:');
  const manifest = fixtureManifest();
  const repoPath = manifest.repositories.api!.repoPath;
  const ticketId = createTicket(store, { key: 'C-1', title: 't' });
  store.db
    .prepare(
      `INSERT INTO worktrees (ticket_id, repo, path, branch, base_ref, deps_mode)
       VALUES (?, ?, '/wt', 'karst/feat/c-1', ?, 'inherited')`,
    )
    .run(ticketId, repoPath, baseRef);
  return { store, manifest, ticketId, repoPath };
}

const cleanGit: GitRunner = async () => ({ stdout: '', stderr: '', exitCode: 0 });

describe('changeBaseRef', () => {
  it('rebases, then stores the new base', async () => {
    const { store, manifest, ticketId, repoPath } = seed();
    const r = await changeBaseRef({
      store,
      manifest,
      ticketId,
      repoPath,
      toBase: 'epic/checkout',
      git: cleanGit,
    });
    expect(r.ok).toBe(true);
    expect(r.fromBase).toBe('develop');
    expect(r.rebase!.outcome).toBe('rebased');
    const row = store.db
      .prepare('SELECT base_ref FROM worktrees WHERE ticket_id = ? AND repo = ?')
      .get(ticketId, repoPath) as { base_ref: string };
    expect(row.base_ref).toBe('epic/checkout');
  });

  it('does NOT store the new base when the rebase conflicts', async () => {
    const { store, manifest, ticketId, repoPath } = seed();
    const git: GitRunner = async (args) =>
      args[0] === 'rebase' && args[1] !== '--abort'
        ? { stdout: '', stderr: 'CONFLICT (content): Merge conflict in a.ts', exitCode: 1 }
        : { stdout: '', stderr: '', exitCode: 0 };

    const r = await changeBaseRef({
      store,
      manifest,
      ticketId,
      repoPath,
      toBase: 'epic/checkout',
      git,
    });
    expect(r.ok).toBe(false);
    expect(r.rebase!.outcome).toBe('conflict');
    const row = store.db
      .prepare('SELECT base_ref FROM worktrees WHERE ticket_id = ? AND repo = ?')
      .get(ticketId, repoPath) as { base_ref: string };
    expect(row.base_ref).toBe('develop');
  });

  it('stores the new base without rebasing when rebase is off', async () => {
    const { store, manifest, ticketId, repoPath } = seed();
    const calls: string[][] = [];
    const git: GitRunner = async (args) => {
      calls.push(args);
      return { stdout: '', stderr: '', exitCode: 0 };
    };
    const r = await changeBaseRef({
      store,
      manifest,
      ticketId,
      repoPath,
      toBase: 'epic/checkout',
      rebase: false,
      git,
    });
    expect(r.ok).toBe(true);
    expect(r.rebase).toBeNull();
    expect(calls.some((a) => a[0] === 'rebase')).toBe(false);
  });

  it('re-targets an open PR and reports gh’s refusal without failing the change', async () => {
    const { store, manifest, ticketId, repoPath } = seed();
    store.db
      .prepare(
        `INSERT INTO prs (ticket_id, repo, number, url, status)
         VALUES (?, ?, 7, 'https://example/7', 'open')`,
      )
      .run(ticketId, repoPath);
    const gh = async () => ({ stdout: '', stderr: 'no write access', exitCode: 1 });
    const r = await changeBaseRef({
      store,
      manifest,
      ticketId,
      repoPath,
      toBase: 'epic/checkout',
      git: cleanGit,
      gh,
    });
    expect(r.ok).toBe(true);
    expect(r.prRetarget).toEqual({ ok: false, reason: 'no write access', number: 7 });
  });

  it('clears the now-stale merge check', async () => {
    const { store, manifest, ticketId, repoPath } = seed();
    // Insert a merge_checks row through the existing store helper, then assert it
    // is gone after the change. Read src/store/mergeChecks.ts for the writer name.
  });
});
```

Fill in the last test body against the real `mergeChecks.ts` writer, and match the `prs` INSERT to that table's actual NOT NULL columns — read `src/store/prs.ts` and `schema.sql` first. The repository fixture key (`api`) must match `src/manifest/fixtures.ts`.

- [ ] **Step 2: Run the test and watch it fail**

Run: `npx vitest run src/workflow/changeBaseRef.test.ts`
Expected: FAIL — `Cannot find module './changeBaseRef.js'`.

- [ ] **Step 3: Add `clearMergeCheck` to `src/store/mergeChecks.ts`**

```ts
/**
 * Drop a repository's merge check. A base branch change invalidates it
 * completely — the recorded `base_sha`, `files` and `state` all describe a merge
 * against a base this ticket no longer targets — and a stale CLEAN check is
 * worse than no check at all.
 */
export function clearMergeCheck(store: Store, ticketId: number, repo: string): void {
  store.db.prepare('DELETE FROM merge_checks WHERE ticket_id = ? AND repo = ?').run(ticketId, repo);
}
```

- [ ] **Step 4: Implement the orchestration**

```ts
// src/workflow/changeBaseRef.ts
import type { Store } from '../store/db.js';
import type { Manifest } from '../manifest/types.js';
import type { GitRunner } from '../integrations/git.js';
import type { GhRunner, PrEditAttempt } from '../integrations/github.js';
import { updatePrBase } from '../integrations/github.js';
import { rebaseWorktreeOntoBase, type RebaseResult } from '../runtime/rebaseWorktree.js';
import { clearMergeCheck } from '../store/mergeChecks.js';
import { resolveTicketBaseRef } from './baseRef.js';

export interface ChangeBaseRefOpts {
  store: Store;
  manifest: Manifest;
  ticketId: number;
  /** The WORKTREE's repoPath: base refs are per worktree, never per entry name. */
  repoPath: string;
  toBase: string;
  /** Rebase the branch onto the new base. Default true. */
  rebase?: boolean;
  git: GitRunner;
  gh?: GhRunner;
  debug?: (line: string) => void;
}

export interface ChangeBaseRefResult {
  ok: boolean;
  fromBase: string;
  toBase: string;
  rebase: RebaseResult | null;
  prRetarget: (PrEditAttempt & { number: number }) | null;
  reason: string;
}

/**
 * Change a spun ticket's base branch for one repository.
 *
 * Order is the contract: the branch MOVES first, and `worktrees.base_ref` is
 * written only once git agrees. A stored base git never reached would make every
 * later diff, gate target and PR describe a merge that was never attempted.
 * The PR re-target and the merge-check invalidation come after, and neither can
 * fail the change: a refused `gh pr edit` is reported, not thrown.
 */
export async function changeBaseRef(opts: ChangeBaseRefOpts): Promise<ChangeBaseRefResult> {
  const { store, manifest, ticketId, repoPath, git, debug } = opts;
  const toBase = opts.toBase.trim();
  const fromBase = resolveTicketBaseRef(store, ticketId, repoPath, manifest);

  const base = { fromBase, toBase, rebase: null, prRetarget: null } as const;
  if (toBase === '') {
    return { ...base, ok: false, reason: 'a base branch name is required' };
  }
  if (toBase === fromBase) {
    return { ...base, ok: true, reason: '' };
  }

  const row = store.db
    .prepare('SELECT path FROM worktrees WHERE ticket_id = ? AND repo = ? LIMIT 1')
    .get(ticketId, repoPath) as { path: string } | undefined;
  if (!row) {
    return { ...base, ok: false, reason: `no worktree for ${repoPath} on this ticket` };
  }

  debug?.(`[runtime] change base ${repoPath}: ${fromBase} -> ${toBase}`);

  let rebase: RebaseResult | null = null;
  if (opts.rebase !== false) {
    rebase = await rebaseWorktreeOntoBase({ git, cwd: row.path, fromBase, toBase, debug });
    if (rebase.outcome !== 'rebased' && rebase.outcome !== 'already-based') {
      debug?.(`[runtime] change base ${repoPath}: refused — ${rebase.outcome}`);
      return { fromBase, toBase, rebase, prRetarget: null, ok: false, reason: rebase.reason };
    }
  }

  store.db
    .prepare('UPDATE worktrees SET base_ref = ? WHERE ticket_id = ? AND repo = ?')
    .run(toBase, ticketId, repoPath);
  clearMergeCheck(store, ticketId, repoPath);

  let prRetarget: (PrEditAttempt & { number: number }) | null = null;
  const pr = store.db
    .prepare(
      `SELECT number FROM prs
        WHERE ticket_id = ? AND repo = ? AND status IN ('open', 'draft')
        LIMIT 1`,
    )
    .get(ticketId, repoPath) as { number: number } | undefined;
  if (pr && opts.gh) {
    const attempt = await updatePrBase(opts.gh, String(pr.number), row.path, toBase);
    prRetarget = { ...attempt, number: pr.number };
    debug?.(
      `[merge] change base ${repoPath}: PR #${pr.number} retarget ${attempt.ok ? 'ok' : 'refused'}`,
    );
  }

  return { fromBase, toBase, rebase, prRetarget, ok: true, reason: '' };
}
```

- [ ] **Step 5: Run the tests and watch them pass**

Run: `npx vitest run src/workflow/changeBaseRef.test.ts src/store/mergeChecks.test.ts`
Expected: PASS.

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/workflow/changeBaseRef.ts src/workflow/changeBaseRef.test.ts src/store/mergeChecks.ts
git commit -m "feat(base-ref): change a spun ticket's base branch, rebasing before storing it"
```

---

### Task 8: Creation-time picker in the ticket form

**Files:**
- Modify: `src/ui/ticketForm/messages.ts`
- Modify: `src/ui/ticketForm/state.ts`
- Modify: `src/ui/ticketForm/actions.ts`
- Modify: `src/ui/ticketForm/webview.html`
- Modify: `src/extension.ts` (bind `listBaseBranchCandidates`)
- Test: `src/ui/ticketForm/messages.test.ts`, `src/ui/ticketForm/actions.test.ts`, `src/ui/ticketForm/webview.test.ts`

**Interfaces:**
- Consumes: `listBaseBranchCandidates` (Task 4), `assertSharedRepoBaseOverrides` (Task 1), `updateTicketFields({ baseRefs })` (Task 2).
- Produces:
  - inbound message `{ type: 'set-base-ref'; repo: string; baseRef: string }` (empty string = "back to the default"),
  - `TicketFormActions.setBaseRef(repo: string, baseRef: string): void | Promise<void>`,
  - the state field `repoBases: Array<{ repo: string; value: string; default: string; candidates: string[] }>` on the ticket-form view state,
  - `submit`/`save` carry `baseRefs: Record<string, string>`.

**UX shape (read `docs/ui/UI-RULES.md` and `docs/ui/UI-INVARIANTS.md` before writing markup):** the base branch belongs ON the repo row that is already in the form's repo picker — not in a separate section, because the choice is per repo and only meaningful for a repo that is scoped. Each SELECTED repo row gains a secondary line: `Base <combobox>`. The combobox is an `<input list="…">` (free text + a `<datalist>` of `listBaseBranchCandidates`), because an epic branch may exist only on a remote this clone has not fetched, and the field must never be a dead end. Empty input renders the manifest default as its placeholder and stores nothing. A row whose value differs from the manifest default shows the "changed" affordance the design system already uses for an overridden default (find it in `docs/ui/DESIGN-SYSTEM.md` — do not invent a new one). Candidates load lazily per repo when the row is first selected, so opening the form never fans out a `for-each-ref` per manifest repository.

- [ ] **Step 1: Write the failing tests**

In `src/ui/ticketForm/messages.test.ts`:

```ts
it('parses set-base-ref', () => {
  expect(parseInbound({ type: 'set-base-ref', repo: 'api', baseRef: 'epic/x' })).toEqual({
    type: 'set-base-ref',
    repo: 'api',
    baseRef: 'epic/x',
  });
});

it('rejects set-base-ref without a repo', () => {
  expect(parseInbound({ type: 'set-base-ref', baseRef: 'epic/x' })).toBeNull();
});

it('treats a blank base ref as clearing the override', () => {
  expect(parseInbound({ type: 'set-base-ref', repo: 'api', baseRef: '  ' })).toEqual({
    type: 'set-base-ref',
    repo: 'api',
    baseRef: '',
  });
});

it('carries baseRefs through submit', () => {
  const parsed = parseInbound({
    type: 'submit',
    title: 't',
    repos: ['api'],
    baseRefs: { api: 'epic/x' },
  });
  expect(parsed).toMatchObject({ type: 'submit', baseRefs: { api: 'epic/x' } });
});
```

Use the file's real parser export name and its existing test helpers — read it first; `parseInbound` above is a placeholder for whatever it actually exports.

In `src/ui/ticketForm/actions.test.ts`:

```ts
it('stores a base ref override on the ticket', async () => {
  // Arrange the same way the neighbouring setRepos test does, call
  // actions.setBaseRef('api', 'epic/x'), and assert
  // getTicket(store, ticketId)!.baseRefs equals { api: 'epic/x' }.
});

it('drops an override that equals the manifest default', async () => {
  // setBaseRef('api', <the manifest default>) must store {} — an override that
  // says nothing is a default that cannot then follow the manifest.
});

it('refuses two different bases for entries sharing a repoPath', async () => {
  // assertSharedRepoBaseOverrides must reject it; the action reports the error
  // through the same channel the form's other validation errors use.
});
```

Fill all three in against the real `actions.ts` shape and the real error-reporting channel it already uses; do not leave comment bodies.

In `src/ui/ticketForm/webview.test.ts`, follow the file's existing differential-test style to pin: (a) a `set-base-ref` post exists in the HTML, (b) `submit` includes `baseRefs`.

- [ ] **Step 2: Run the tests and watch them fail**

Run: `npx vitest run src/ui/ticketForm`
Expected: FAIL — unknown message type / `setBaseRef is not a function`.

- [ ] **Step 3: Implement the host side**

In `messages.ts`: add `baseRefs?: Record<string, string>` to the draft fields, `{ type: 'set-base-ref'; repo: string; baseRef: string }` to the inbound union, a parse case (require a non-empty `repo` string, coerce a missing/blank `baseRef` to `''`), a `setBaseRef` entry on the actions interface, the dispatch case, and pass `baseRefs` through the `submit`/`save` construction alongside `repos`. Add a `parseBaseRefsMessage` guard that keeps only string values — never trust the webview payload.

In `actions.ts`: implement `setBaseRef` next to `setRepos`. It reads the current ticket's `baseRefs`, builds a NEW record (never mutate), drops the key when the value is blank or equals `resolvePlannedBaseRef` with the key removed (i.e. the manifest default), runs `assertSharedRepoBaseOverrides(manifest, next)` inside a try/catch that reports the error through the form's existing error channel, and calls `updateTicketFields(deps.store, ctx.ticketId, { baseRefs: next })`. In the create path (`actions.ts:257`, beside `selectedRepos: input.repos`), pass `baseRefs: input.baseRefs ?? {}`.

In `state.ts` (near line 325 where `selectedSet` is built): add `repoBases` to the rendered state — for every SELECTED repo, `{ repo, value: ticket.baseRefs[repo] ?? '', default: resolveBaselineBranch(manifest, repository), candidates: deps.branchCandidates?.[repoPath] ?? [] }`.

In `extension.ts`: add the deps binding that answers a `list-base-branches` request per repoPath with `listBaseBranchCandidates(defaultGitRunner, repoPath)`, mirroring how the panel already answers other async webview requests.

- [ ] **Step 4: Implement the webview**

In `src/ui/ticketForm/webview.html`, inside the repo-row template, add the secondary line (tokens only — no literal colors, no new spacing values):

```html
<label class="k-field k-field--inline" data-base-for="${repo}">
  <span class="k-field__label">Base</span>
  <input class="k-input k-input--sm" type="text" list="base-branches-${repo}"
         placeholder="${defaultBase}" value="${value}"
         aria-label="Base branch for ${repo}">
  <datalist id="base-branches-${repo}">${candidateOptions}</datalist>
</label>
```

and the handler, beside the existing repo-checkbox handler:

```js
function onBaseRefInput(repo, input) {
  post({ type: 'set-base-ref', repo, baseRef: input.value.trim() });
}
```

Include `baseRefs` in the `submit` payload at line ~1365 by collecting the inputs of the selected rows. Rebuild the row when selection changes so an unselected repo carries no base control.

- [ ] **Step 5: Run the tests and watch them pass**

Run: `npx vitest run src/ui/ticketForm`
Expected: PASS.

- [ ] **Step 6: Verify the whole flow still typechecks and builds**

Run: `npm run typecheck && npm run build`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/ui/ticketForm src/extension.ts
git commit -m "feat(ticket-form): pick a base branch per scoped repo before the ticket is spun"
```

---

### Task 9: Live-change action in the dashboard

**Files:**
- Modify: `src/ui/dashboard/messages.ts`
- Modify: `src/ui/dashboard/state.ts`
- Modify: `src/ui/dashboard/panel.ts`
- Modify: `src/ui/dashboard/webview.html`
- Modify: `src/extension.ts`
- Test: `src/ui/dashboard/messages.test.ts`, `src/ui/dashboard/panel.test.ts`, `src/ui/dashboard/webview.test.ts`

**Interfaces:**
- Consumes: `changeBaseRef` (Task 7), `listBaseBranchCandidates` (Task 4).
- Produces: inbound message `{ type: 'change-base-ref'; repo: string; baseRef: string; rebase: boolean }` (`repo` is the worktree's repoPath), and the dashboard state field `worktrees[].baseRef` surfaced on the scope card.

**UX shape:** each worktree row on the scope card shows `Base <branch>`. Its action opens a small confirm surface with the branch combobox (same `<input list>` + `<datalist>` control as Task 8, so the two surfaces read as one idea) and a switch, defaulted ON: **"Rebase the branch onto the new base"**. The copy under it states the two outcomes plainly, because this is the destructive half: rebasing rewrites the ticket branch's commits, and a branch already pushed will need a force-push at ship time. Switching the rebase OFF re-targets only — useful when the branch was cut from the right commit and only the PR target is wrong. A refusal (`dirty`, `conflict`, `fetch-failed`) renders as an inline error naming git's own words and changes nothing; the ticket keeps its old base. A successful change reports what it did: rebased or not, PR #N re-targeted or not, merge check cleared.

- [ ] **Step 1: Write the failing tests**

In `src/ui/dashboard/messages.test.ts`:

```ts
it('parses change-base-ref', () => {
  expect(parseInbound({ type: 'change-base-ref', repo: '/repo', baseRef: 'epic/x', rebase: true }))
    .toEqual({ type: 'change-base-ref', repo: '/repo', baseRef: 'epic/x', rebase: true });
});

it('defaults rebase ON when the flag is absent — the safe read of a missing switch', () => {
  expect(parseInbound({ type: 'change-base-ref', repo: '/repo', baseRef: 'epic/x' }))
    .toMatchObject({ rebase: true });
});

it('rejects change-base-ref with a blank base', () => {
  expect(parseInbound({ type: 'change-base-ref', repo: '/repo', baseRef: '  ' })).toBeNull();
});
```

In `src/ui/dashboard/panel.test.ts`:

```ts
it('calls changeBaseRef and reports a refusal without changing the stored base', async () => {
  // Arrange a panel with an injected changeBaseRef that answers
  // { ok: false, rebase: { outcome: 'dirty', reason: '…' }, … }; assert the
  // panel surfaces the reason through its existing notification channel and
  // does not repaint a new base.
});

it('repaints the scope card with the new base after a successful change', async () => {
  // Injected changeBaseRef answers ok:true; assert the state's worktree row
  // carries the new baseRef.
});
```

Fill both in against `panel.ts`'s real dependency-injection shape and the existing notification channel.

In `src/ui/dashboard/webview.test.ts`, pin (differential style, as that file already does) that the scope card renders a base-branch control and posts `change-base-ref`.

- [ ] **Step 2: Run the tests and watch them fail**

Run: `npx vitest run src/ui/dashboard`
Expected: FAIL — unknown message type.

- [ ] **Step 3: Implement**

- `messages.ts`: add the inbound variant, the parse case (non-empty `repo` and `baseRef` after trim, `rebase: m.rebase !== false`), the action entry `changeBaseRef(repo, baseRef, rebase)`, and the dispatch case.
- `state.ts` (near line 587, where the scope cell is built): carry each worktree's `baseRef` and the manifest default into the scope cell so the row can mark an overridden base.
- `panel.ts`: implement the handler — call the injected `changeBaseRef` with `{ store, manifest, ticketId, repoPath: repo, toBase: baseRef, rebase, git: defaultGitRunner, gh, debug }`, then refresh the dashboard state. On `ok: false`, surface `reason` through the panel's existing notification path and refresh nothing.
- `webview.html`: render `Base <branch>` on each worktree row of the scope card, plus the change surface described above. Reuse the existing switch component (`k-switch`, as used by `pullBase` in the ticket form) and the existing confirm/inline-error patterns — no new component.
- `extension.ts`: bind `changeBaseRef` and the branch-candidate lookup into the dashboard panel's deps, and bind `debug` to `logger.debug`.

- [ ] **Step 4: Run the tests and watch them pass**

Run: `npx vitest run src/ui/dashboard`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ui/dashboard src/extension.ts
git commit -m "feat(dashboard): change a spun ticket's base branch per repo, with rebase"
```

---

### Task 10: Document the invariant and verify the whole change

**Files:**
- Modify: `docs/arch/worktrees-and-servers.md`
- Modify: `docs/arch/store-and-schema.md`
- Modify: `CLAUDE.md` (the worktrees bullet, one clause)

- [ ] **Step 1: Write the doc changes**

In `docs/arch/worktrees-and-servers.md`, under "The base is pulled before a worktree is cut", add a new section:

```markdown
## The base branch is per TICKET and per REPOSITORY, and the worktree row is the authority

`workflow/baseRef.ts` is the only place a base branch is decided, and its order is load-bearing: `worktrees.base_ref` first (the branch was ALREADY cut from it, so it is the only answer matching what git did — a later manifest edit must not silently retarget an open PR), then the ticket's pre-spin override (`tickets.base_refs`, keyed by manifest repository NAME), then the manifest default. `confirmScope`/`spinTicket` read `resolvePlannedBaseRef` (no worktree exists yet); `gates/targets.ts` and `ship.ts` read `resolveTicketBaseRef`. Entries sharing a `repoPath` share ONE worktree and therefore one branch point, so a per-ticket override is validated by `assertSharedRepoBaseOverrides` exactly as the manifest's own defaults are by `assertSharedRepoBaselineBranches`. Changing the base of a SPUN ticket goes through `workflow/changeBaseRef.ts`, and its order is also the contract: the branch moves first (`runtime/rebaseWorktree.ts`, `git rebase --onto origin/<new> origin/<old>` — a plain rebase would replay the old base's history into the ticket's PR), and `base_ref` is written only once git agrees. A dirty tree and a conflict are REFUSALS that change nothing (the conflict is `--abort`ed, so no tree is left mid-rebase). After the write, the stale `merge_checks` row is deleted — it describes a merge against a base this ticket no longer targets — and an open PR is re-targeted with `gh pr edit --base`, whose refusal is reported, never thrown.
```

In `docs/arch/store-and-schema.md`, add `tickets.base_refs` to the schema notes with one line: *a JSON map of manifest repository NAME → plain branch name, the PRE-spin override; after spin, `worktrees.base_ref` is the authority.*

In `CLAUDE.md`, extend the worktrees bullet with: `the per-ticket per-repo base branch and its one resolver`.

- [ ] **Step 2: Run the full verification**

Run: `npm run typecheck && npm run test:unit && npm run build`
Expected: all pass. Paste the real output — do not claim a pass you have not seen.

- [ ] **Step 3: Commit**

```bash
git add docs/arch/worktrees-and-servers.md docs/arch/store-and-schema.md CLAUDE.md
git commit -m "docs: record the per-ticket per-repo base branch invariant"
```

---

## Self-Review Notes

- **Requirement 1 (pick at creation)** → Tasks 2 (storage), 4 (candidates), 8 (UI), and 3 (spin honors it).
- **Requirement 2 (live change on a spun ticket, handled properly)** → Tasks 5 (rebase), 6 (PR re-target), 7 (orchestration + merge-check invalidation), 9 (UI).
- **"Proper UI with best UX"** → the picker lives on the repo row that already exists in both surfaces, is a free-text combobox so an unfetched remote branch is never a dead end, defaults are shown as placeholders rather than pre-filled values (so "unset" and "same as default" stay distinguishable), and the destructive half (rebase) is an explicit switch with its consequence stated.
- **Not covered, deliberately:** changing the base of an ARCHIVED ticket, and a bulk "change base for every repo at once" action. Both are additive on top of `changeBaseRef` and neither is in the ticket. Flagged here rather than silently omitted.
- **Known risk to watch during execution:** Task 3 changes what `gates/targets.ts` and `ship.ts` consider the base. Existing tests in those files assert the manifest value; where they do, update the fixture to seed a matching `worktrees.base_ref` rather than weakening the assertion.
