# RESEARCH — Ship stage should track merge conflicts

**Ticket**: `869e7bwaf` · **Slug**: `869e7bwaf-ship-merge-conflicts`
**Component**: `src/workflow/stages/ship.ts`, `src/integrations/git.ts`, `src/store/*`
**Type**: Feature (observability on an existing stage)
**Complexity**: Medium
**Decision**: **GO** (confidence: High)

---

## Executive summary

Ship opens one PR per hot repo and advances to `done` on success. It never asks whether the branch can actually merge into its base, so a ticket reaches `done` with a PR nobody can merge, and karst shows nothing. The feature is a bounded addition: a non-blocking `git merge-tree --write-tree` probe per worktree, a new upsert-keyed `merge_checks` table, and an extra field on the three existing read paths that already surface PR/ship state. No stage-graph change, no change to any existing column, no new dependency. Everything the feature needs (injected `GitRunner`, `transition` premutate hook, additive-migration convention) already exists.

---

## Requirements summary

Functional:
- F1 Detect mergeability of each ticket worktree branch against its base ref during ship.
- F2 Persist result + conflicting file list.
- F3 Expose through existing ship-state read paths.
- F4 Refresh rather than serve stale results.
- F5 Three-valued outcome: `clean` | `conflicted` | `unknown` (with reason).

Non-functional:
- N1 Must not block the extension-host event loop (CLAUDE.md invariant).
- N2 Additive schema only; no breaking change to existing consumers.
- N3 Deterministic verdicts (exit codes), never agent self-report.
- N4 Testable under vitest with fakes — no real repo, no network.

---

## Product analysis

**User value: High.** The failure this closes is silent and expensive: ship passes, ticket goes `done`, and the conflict is discovered by a human at merge time — after the agent session that had all the context is gone. Karst's whole premise is that stage state is trustworthy; "shipped" currently means "a PR exists", not "this can land".

**Strategic alignment: High.** Fits the existing evidence model exactly (deterministic exit code → recorded state → surfaced on the board). It also extends the same read paths already used to show PRs, so consumers get it for free.

**Scope discipline:** this is *tracking*, not resolution. Auto-rebase/auto-merge is explicitly out of scope — it mutates the user's branch and belongs to a separate ticket.

---

## Technical discovery (code reality)

### Current ship stage — `src/workflow/stages/ship.ts:53`
```
setStage(ship, running) → for each worktree: commitAllIfDirty → pushBranch
  → findOpenPr ?? openPr → INSERT INTO prs → transition(ship, passed) → done
```
- Failure path sets `stages.status='failed'` + `verdict=<message>` and re-throws. **Ship has no `failed` edge** (`src/workflow/graph.ts:34` → `ship: { passed: 'done' }`), so a failed ship stays parked at `ship`. This matters: a *conflict* must NOT be modelled as a ship failure unless we want the ticket parked — see the open decision below.
- `GitRunner` / `GhRunner` are injected (defaults at `src/integrations/git.ts:21`, `github.ts:65`), so the merge check is unit-testable with a fake runner.

### Storage
- `stages` is keyed `(ticket_id, stage_key)` and **overwritten on retry** (`src/store/schema.sql`) — unsuitable for anything needing history, but conflict state is explicitly *current-state* (F4), so overwrite is the correct semantic here.
- Append-only evidence tables (`gate_runs`, `phase_marks`) exist for the history case; `merge_checks` is deliberately not one of them.
- Conflict is per-repo (each worktree targets its own `base_ref`, `worktrees.base_ref` already stored) → natural key `(ticket_id, repo)`.
- Migration convention (`src/store/migrations.ts`): guarded `CREATE TABLE IF NOT EXISTS` + bump `SCHEMA_VERSION` + `schema.sql` for fresh DBs + update `db.test.ts` version/table-count assertions. Current version is **8**; this feature is **v9**.

### Read paths that surface ship state (all three must carry the new field)
1. `src/store/dashboard.ts:108` `listPrsByTicket` → `src/ui/dashboard/state.ts:103` → webview.
2. `src/context/ticketContext.ts:114` `buildTicketContext` → `renderTicketContext` "## Pull requests" section (`:174`) — feeds both the launch seed and the `karst context` CLI.
3. The `karst context` CLI reads through (2), so it inherits the field with no separate work.

### Detection tooling
- `git merge-tree --write-tree --name-only <base> <head>` — verified available (git 2.50.1). Exit **0** = clean, exit **1** = conflict with conflicted paths on stdout, exit **>1** = real error. Does not touch the working tree or index — safe to run against a live agent worktree.
- Base must be refreshed first (`git fetch origin <base_ref>`) or "clean" is measured against a stale base — this is the concrete mechanism behind F4.

### Constraint found: `defaultGitRunner` uses `spawnSync`
`src/integrations/git.ts:22` blocks the extension host for the duration of every git call. `GitRunner`'s signature is already `Promise`-returning, so the implementation can be swapped to the async `spawn` pattern already proven in `src/workflow/gates/run.ts:24` (`runCommand`) with no call-site change. A `fetch` over the network is exactly the call that makes the existing `spawnSync` an event-loop hazard, so this feature should not add to it. **Recommend converting `defaultGitRunner` to async spawn as part of this work**, with a timeout — timeouts are also required by F5.

---

## Technical approach (recommended)

1. **`src/integrations/git.ts`** — convert `defaultGitRunner` to non-blocking `spawn` + timeout; keep `GitRunner` type unchanged.
2. **`src/workflow/mergeCheck.ts`** (new, pure over `GitRunner`) — `checkMergeable(git, cwd, baseRef): Promise<MergeCheck>` returning
   `{ state: 'clean'|'conflicted'|'unknown', files: string[], reason: string|null, headSha, baseSha }`.
   Exit 0 → clean; exit 1 → conflicted + parsed `--name-only` paths; anything else / fetch failure / timeout / missing ref → `unknown` with git's own stderr as the reason.
3. **`src/store/mergeChecks.ts`** (new) — `setMergeCheck` (INSERT … ON CONFLICT(ticket_id, repo) DO UPDATE) + `listMergeChecksByTicket`. Table `merge_checks(ticket_id, repo, state, files JSON, reason, head_sha, base_sha, base_ref, checked_at, PRIMARY KEY(ticket_id, repo))`, v9 migration.
4. **`ship.ts`** — run the check per worktree after `pushBranch`, before/alongside PR creation; write via the `transition` premutate hook so state and verdict commit together.
5. **Read paths** — add `mergeCheck` to `listPrsByTicket`'s projection (or join), to `TicketContextPr`, and to the rendered "## Pull requests" line; optional-nullable so existing consumers are unaffected (N2).
6. **Staleness (F4)** — record `head_sha`/`base_sha`; a stored check whose SHAs no longer match is presented as stale, and ship re-runs the check on every ship invocation (ship already re-runs idempotently).

**Alternatives rejected:**
- *Ask `gh pr view --json mergeable`* — GitHub computes it asynchronously and returns `UNKNOWN` on first read; requires polling, and dies for repos with no PR yet. Viable later as a *supplement*, not the primary signal.
- *Real merge into a temp worktree* — accurate but mutates state and is slow; `merge-tree` gives the same answer read-only.
- *Column on `stages`* — cannot hold per-repo results and gets clobbered by retry semantics.

---

## Risks

| # | Risk | Mitigation |
|---|------|------------|
| R1 | Conflict semantics vs. `ship` having no `failed` edge — reporting a conflict as a stage failure would park tickets that currently reach `done`. | Default: conflict is **recorded state, not a ship verdict** (satisfies "no breaking change"). Escalation to a blocking gate is a separate decision — flag for the user at plan time. |
| R2 | `git fetch` on the ship path adds network latency and a new failure mode inside the extension host. | Async runner (item 1) + explicit timeout → `unknown`, never a hang, never a false `clean`. |
| R3 | `git merge-tree --write-tree` needs git ≥ 2.38. | Detect non-zero-with-unrecognised-option and degrade to `unknown` with a clear reason rather than mis-reporting. |
| R4 | Test-count/version assertions in `db.test.ts` break on the new table. | Named in the plan's checklist; CLAUDE.md already documents it. |

---

## Recommendation

**GO.** Product viability High, technical feasibility High, complexity Medium. Bounded to ~4 new/modified source files plus migration, with every needed seam (injected runner, premutate hook, additive migration path) already in place.

**Condition to resolve during `/rpi:plan`**: does a detected conflict merely annotate ship state (recommended, non-breaking), or block the `ship → done` transition? The graph has no `failed` edge out of `ship`, so blocking means parking the ticket at `ship`.

**Next step**: `/rpi:plan "869e7bwaf-ship-merge-conflicts"`
