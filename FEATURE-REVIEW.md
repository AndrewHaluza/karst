# Dynamic Graph Approach — Feature Review

## Verdict

**Changes requested.** The feature is broadly well-tested and builds cleanly, but one P1 runtime defect blocks approval. One repository-hygiene issue should also be resolved before shipping.

## Findings

### [P1] Superseded workspaces are double-counted and retries can be permanently blocked

**Location:** `src/approaches/graph/workspace/provider.ts:205-208`

`currentBytes` already includes the existing workspace ledger, but the preliminary ceiling check adds the replacement estimate before removing or releasing that ledger. If the original workspace fills the limit, retrying the same node evaluates as approximately twice the limit and returns `budget-exhausted` before reaching superseded-workspace handling.

There is a second manifestation when the ceiling is permissive: the provider removes only the directory at line 236, while lines 283-299 append new ledger rows and increment `workspace_bytes` without releasing the old rows. Repeated recreation therefore inflates accounting until the graph eventually becomes budget-blocked.

The current recreation test at `src/approaches/graph/workspace/provider.test.ts:270` confirms filesystem replacement but never checks the ledger or byte counter. The budget test uses a different node, so the retry case remains uncovered.

**Required resolution:** After process attribution permits replacement, replace the old ledger and aggregate contribution atomically with recording the new workspace. Both the preliminary estimate and locked commit-time ceiling check must exclude the superseded contribution.

### [P2] Runtime SQLite artifacts are committed at repository root

**Locations:** `karst.db`, `karst.db-shm`, `karst.db-wal`

These are generated SQLite runtime files totaling about 336 KiB. The database currently contains no tickets or usage records, but it carries schema version 34 while this branch declares schema version 41. The `-shm` file is transient shared-memory state and should never be source-controlled.

Keeping these files creates noisy binary diffs, risks future accidental disclosure of ticket/session data, and leaves a stale database fixture with no documented test role. Remove them and ignore the root runtime database family unless they are intentionally converted into a named test fixture.

## Non-blocking quality notes

`git diff --check` reports:

- Trailing whitespace in `docs/design/artifacts/reference/karst-ticket-artifacts-implementation-spec.md`.
- An extra blank line at EOF in `src/ui/sidebar/state.test.ts`.
- An extra blank line at EOF in `src/workflow/graphMarkerGuard.ts`.

These are cleanup items, not functional defects.

## Verification

- `npm run typecheck` — passed.
- `npm test` — passed: 377 files, 6,632 tests.
- `npm run build` — passed.
- `git diff --check` — failed on the whitespace-only issues listed above.

## Scope and residual risk

The review covered the complete branch diff from merge base `5b09050a`: 278 files and approximately 53,941 additions. Review attention focused on graph compilation and execution, transactional coordination, workspace lifecycle, process attribution, capability-authenticated CLI paths, migrations, transports, packaging, and UI integration.

Given the feature's size and concurrency surface, passing tests materially lower risk but do not compensate for the confirmed accounting defect. Merge should be blocked on P1; P2 should also be cleaned before shipping.
