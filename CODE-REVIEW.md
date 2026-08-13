# Code Review — Dynamic Graph Approach branch

**Date:** 2026-08-13
**Branch:** `karst/feat/feat-dynamic-graph-approach-fu1-follow-up-feat-dynamic-graph`
**HEAD:** `6b57ddc`
**Base:** `main` (merge base `d151b93`)

## Scope

Local worktree review — no PR open for this branch. Covered:

- The two open findings in `FEATURE-REVIEW.md` (re-verified against current HEAD).
- The last 10 commits: Slice-5 T6/T7 and Slice-6 T1–T4 (ACP transport, structured
  diagnostics, per-invocation usage rollup, graph node-list projection), plus the
  hooks injected-clock fix.

**Not covered:** the full branch diff (297 commits, ~187k src insertions across
761 files vs `main`). The earlier `FEATURE-REVIEW.md` pass used merge base
`5b09050a`, which is no longer an ancestor of HEAD, so its scope could not be
cleanly differenced.

## Verdict

**Changes requested.** Two blocking issues, both carried over unfixed from the
previous review.

## Blocking

### [P1] Superseded workspaces are double-counted; retries can be permanently budget-blocked

**Location:** `src/approaches/graph/workspace/provider.ts:205-236`

The supersede path removes the directory (`rmSync(nodeDir)` at line 236) but never
releases the ledger. `removeWorkspacesForNode`
(`src/store/graph/nodeRuns.ts:283`) and `releaseWorkspaceBytes`
(`src/store/graph/nodeRuns.ts:248`) both exist, but are wired only from
`src/approaches/graph/workspace/cleanup.ts:62`.

`approach_graph_workspaces` (`src/store/schema.sql:993`) has no unique key on
`(node_run_id, repo_name)`, so recreating a node's workspace appends duplicate
rows while `addWorkspaceBytes` (`provider.ts:296`) only ever increments
`workspace_bytes`. Accounting inflates monotonically until the graph becomes
budget-blocked.

Second, earlier manifestation: the step-1 gate at `provider.ts:207` computes
`currentBytes + estimatedBytes` where `currentBytes` still includes the
superseded workspace's ledger. Retrying a node that filled the ceiling therefore
evaluates at roughly twice the limit and returns `budget-exhausted` at line 211 —
before the supersede handling at line 220 is ever reached.

Existing coverage does not catch this: the recreation test
(`src/approaches/graph/workspace/provider.test.ts:270`) asserts filesystem
replacement only, never the ledger or the byte counter; the budget test uses a
different node, so the retry case is uncovered.

**Required resolution:** after process attribution permits replacement, delete the
old ledger rows and release their bytes atomically with recording the new
workspace, inside the same transaction. Both the preliminary estimate and the
locked commit-time re-check must exclude the superseded contribution.

### [P2] Runtime SQLite artifacts committed at repository root

**Locations:** `karst.db` (304K), `karst.db-shm` (32K), `karst.db-wal` (0B)

All three are tracked. `-shm` and `-wal` are transient; the `.db` carries
`user_version` 34 while this branch declares schema version 41, so it is a stale
fixture with no documented test role. Remove them and gitignore the root runtime
database family unless they are deliberately converted into a named fixture.

## Non-blocking

- **Stale aggregate-count claim.** `src/store/tokenUsage.ts:11` states aggregation
  is "FOUR aggregate queries"; the new `byProfile` rollup (`:305-329`) makes five.
  It also joins `approach_node_runs`/`approach_planner_runs` by primary key rather
  than riding the range indexes the header credits. `CLAUDE.md` repeats the "four
  SQL GROUP BYs" wording — update both.

- **Identity lookup inside the sweep transaction.** `emitGraphDiagnostic` issues a
  fresh three-way-JOIN identity resolve per event, called up to
  `MAX_SWEEP_TRANSITIONS` (100) times inside the `BEGIN IMMEDIATE` transaction at
  `src/approaches/graph/coordinator/sweep.ts:262`. Correct, but it lengthens lock
  hold time where logging previously cost zero reads. Resolve the identity once
  per sweep and reuse it.

- **Transport diagnostics asymmetry.** `src/approaches/graph/transport/acpTransport.ts:1610-1667`
  still emits ad-hoc `[graph] …` debug strings with an unbounded `String(error)`,
  while its sibling `supervisedCliTransport.ts:1774` was converted to the bounded,
  redacted structured emitter in the same commit. Same leftover at
  `src/approaches/graph/integration/pipeline.ts:850`.

## Corrections to the previous review

The `git diff --check` "trailing whitespace" hits in the design docs are
intentional Markdown hard line breaks (two trailing spaces), not defects.

## Compliance and bug-scan results

- **CLAUDE.md adherence:** no violations in the reviewed slice. Debug stays an
  injected callback throughout, `diagnostics.ts` never imports the logger (pinned
  by `graphLoggerImport.test.ts`), every emitted line passes `sanitizeText` and is
  capped at `GRAPH_DIAGNOSTIC_DETAIL_MAX`, the `spawnSync` ban is untouched, and
  the UI additions reuse existing primitives with host-ordered closed vocabularies.
- **Bug scan:** no escaping, aggregation, or newly introduced resource-leak defects.
  Graph-derived strings funnel through `sanitizeGraphText`/`esc()`; the `byProfile`
  rollup reuses the verified `aggregates()`/`filter()` helpers. The unpruned
  `sessions` map in `acpTransport.ts` matches the existing pattern in
  `supervisedCliTransport.ts` and is pre-existing, not introduced here.
- **Comment guidance:** one contradiction, the `tokenUsage.ts` header noted above.

## Residual risk

The reviewed slice is disciplined and well covered. Risk concentrates in the
unreviewed remainder of the branch — the concurrency and workspace-lifecycle
surface is large, and P1 is a confirmed accounting defect in exactly that area,
which suggests the retry/supersede paths deserve targeted attention beyond the
happy-path tests that currently pass.
