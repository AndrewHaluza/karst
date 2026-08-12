# Slice 5 Sign-off — Safe Parallel Execution

Date: 2026-08-12

Commit range: `b12286f` (T1) … `b6312be` (T7), seven commits (plus the T7 pin
fix commit `b6312be`).

## Entry gate

Slice 4 exit gate holds (sign-off recorded `3fd51ac`).

## Exit gate

- `npm run typecheck` ✓ (clean)
- `npm test` ✓ — 374 test files, 6579 tests
- `npm run build` ✓
- `npx vitest run src/approaches/graph src/store/graph` ✓

## The maxParallel gating rule (T7)

The packaged default moved 1 → 4 **only after** workspaces (T1), durable
leases (T2), conflict rules (T3), lineage (T4) and per-domain integration (T5)
all landed, in commit order (`b12286f` … `99fb3f9`). The hard ceiling stays 8;
a project configuring 9 is still refused at manifest validation. Every
mechanism was written and tested at `maxParallel: 1` first and is exercised at
4 by the same suites.

## Invariant checklist rows gated at Slice 5, with their proving tests

| # | Invariant | Proving test (file — title) |
|---|---|---|
| B8 | Leases are durable DB rows with `UNIQUE(owner, domain)`, never an in-memory mutex | `src/approaches/graph/coordinator/leases.test.ts` — "a lease survives a host restart: a fresh store connection sees the held row"; "the unique (owner_node_run_id, physical_domain) index rejects a duplicate insert"; "inserts one held lease row per physical domain, in the claim transaction" |
| D9 | Every graph process registers in the `servers` registry (re-verified green) | `src/approaches/graph/transport/supervisedCliTransport.test.ts` — "a graph session appears in the servers registry and is reaped by BOTH paths"; T1 workspaces register by cwd |
| J1 | Writers never share a mutable workspace or writable Git metadata | `src/approaches/graph/workspace/provider.test.ts` — "two workspaces from the same base have independent refs and indexes; commits never leak across"; "git status in the canonical worktrees stays clean throughout" |
| J2 | Physical domains keyed by canonical realpath + Git common dir, never repository name | `coordinator/leases.test.ts` — "deduplicates repeated domain keys (aliased repository entries share one domain)"; `coordinator/conflicts.test.ts` — "aliased repository entries sharing a worktree resolve to ONE domain"; "repository aliases sharing a repoPath conflict correctly (one domain)" |
| J3 | Actual diffs are validated against declared writes before integration | `integration/pipeline.test.ts` — "an out-of-claim file blocks with resource-claim-violated BEFORE integration" (kept); T5 workspace diffs validated by `validateChangeSet` before landing |
| J4 | An integration conflict preserves both trees, blocks, and never routes `complete` | `integration/pipeline.test.ts` — "an integration conflict preserves both the isolated workspace and the canonical worktree and blocks"; "a git refusal to land the change set preserves both trees and blocks with integration-conflict" |
| J5 | Deferral reasons are persisted and shown | `coordinator/sweep.test.ts` — "persists a deferral with its reason and wait_since when a lease conflict refuses the claim, and clears it on success"; `src/model/inside/graph.test.ts` — "renders one row per deferred node with its persisted reason and wait duration"; "a deferral reason is rendered as inert text — never markup" |
| J6 | Bounded aging prevents starvation of wide-claim nodes | `coordinator/conflicts.test.ts` — "past the threshold an aged group is preferred over newer narrow work"; `sweep.test.ts` — "aging prevents starvation: a wide node that has waited past the threshold is preferred over older narrow work"; "wait_since is stamped on the FIRST deferral and survives later refusals (bounded aging clock)"; "a group with no deferral is never aged" |
| J7 | A dependency-waiting node is never reported as resource-blocked | `coordinator/conflicts.test.ts` — "a dependency-waiting node is NOT ready and never labeled resource-blocked"; `sweep.test.ts` — "a dependency-waiting join is never reported as resource-blocked — a stale deferral is cleared instead" |
| J8 | `maxParallel > 1` only after workspaces, leases, and lineage exist | commit order (T1→T7); the packaged pin flip is the LAST Slice-5 commit (`99fb3f9` + `b6312be`); hard ceiling 8 + refusal of 9 pinned in `manifest/load.test.ts` and `graphConfig.test.ts` |
| J9 | Join correlation matches full lineage stack **and** fork visit number | `coordinator/lineage.test.ts` — "correlates on the full stack AND the fork visit number"; "two loop iterations of one fork produce two independent join firings"; "two forks that share a destination and visit number never cross-correlate"; "a partial arrival set never fires — and a stray iteration arrival cannot complete another"; `coordinator/claim.test.ts` join one-winner firing (all-or-nothing) |

## Cross-slice invariants re-verified green by the full suite

1. B1–B12 durability/transactions — claim/completion/discard/replan/recovery/lease transactions all single `BEGIN IMMEDIATE` with affected-row checks.
2. C1–C10 untrusted input — no new argv surface; the command allowlist breadth comes from the pinned `graph.commands`, never planner prose (T3).
3. D1–D13 process lifecycle — attribution-first cleanup (T1), leases (T2), per-domain integration (T5), fault projection (T6).
4. E artifact/path safety — workspaces live outside every worktree (`<globalStorage>/graph/...`), so `ship`'s `git add -A` cannot see them and no exclude rule is needed (T1).
5. F UI — the deferral rows render as inert text; discard keeps its danger variant (T6 re-verified).
6. G stage boundary — `graphMarkerGuard` still the only stage integration; the earliest-fault reason routes through `recoveryCategoryFor`'s closed set (T6).
7. H accounting — workspace bytes + active-processes ceilings are durable, never-negative counters (T1, T3).
8. J1–J9 above.
9. K — no new observability surface; deferral reasons are bounded stored facts, redaction-pipeline-clean.

## Non-graph test modifications

No pre-existing non-graph test was modified except where a task's behavior
change REQUIRED it:

- `src/approaches/builtIn.test.ts`, `src/manifest/graphConfig.test.ts`,
  `src/manifest/load.test.ts`, `src/ui/settings/webview.test.ts` — the
  packaged `maxParallel` default pins follow the T7 flip 1 → 4 (the fixtures
  that explicitly configure `maxParallel: 1` keep their round-trip).
- `src/store/db.test.ts` — SCHEMA_VERSION bumps 39 → 40 → 41 (workspace
  accounting, deferral ledger, fork_instance_id) with migration tests.
- `src/approaches/graph/integration/pipeline.test.ts` — the graph-global
  integrating slot was replaced by per-domain serialization (T5): the
  "deferred while another node…" case now defers on a held same-domain lease.

## Notes

- The single global integrating slot was retired by T5; serialization is now
  per physical domain via the claim-time durable lease, so disjoint writers
  integrate in parallel while same-domain pairs serialize in node-run order.
- The workspace byte ceiling (`maxAggregateWorkspaceBytes`, packaged 20 GiB)
  was already in the limits plumbing; T1 wired the durable per-graph-run
  accounting and the pre-clone enforcement.
- Slice 5 ships the full parallel-safety stack; Slice 6 (transport and
  observability) is next.
