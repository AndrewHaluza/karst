# Slice 2 Sign-off — Durable planning and compilation

Date: 2026-08-12

Commit range: `db33196` (T1) … `3f14617` (T10), ten commits.

## Exit gate

- `npm run typecheck` ✓ (clean)
- `npm test` ✓ — 344 test files, 6203 tests
- `npm run build` ✓
- `npx vitest run src/store src/approaches/graph src/cli` ✓ — 49 files, 911 tests

## Invariant checklist rows gated at Slice 2, with their proving tests

| # | Invariant | Proving test (file — title) |
|---|---|---|
| B1 | Graph migration is one `BEGIN IMMEDIATE` opened before reading `user_version` | `src/store/db.test.ts` — "an interrupted v35 step leaves user_version at 34 and the next open completes"; "two live opens of one file migrate without corruption" |
| B2 | `SCHEMA_VERSION` 34 → 35 and every hardcoded `user_version` assertion updated | `src/store/db.test.ts` — "reports the current schema user_version"; "fresh DB carries the eight graph tables and the token_usage graph FKs (v35)"; "migrates a database at v34 to v35 with all eight graph tables" |
| B7 | Exactly four token transitions; no `claimed → pending` | `src/store/graph/transitions.test.ts` — "admits exactly the four documented transitions"; "claimed → pending is rejected" |
| B9 | The active revision is derived, never stored | `src/store/graph/revisions.test.ts` — "returns at most one row — the partial unique index is structural" |
| B10 | Canonical bytes authoritative on reload; fingerprint mismatch blocks | `src/approaches/graph/compile.test.ts` — "compiles the reference document with a pinned canonical fingerprint" (pinned bytes + SHA-256 must not drift) |
| C1 | Parser rejects unknown fields, never ignores them | `src/approaches/graph/parse.test.ts` — "unknown fields are rejected, never ignored" (every nesting level) |
| C2 | Generated nodes cannot carry provider/model/effort | `src/approaches/graph/parse.test.ts` — "generated-config-forbidden" block (agent model/effort, command provider) |
| C3 | `karst graph submit` is a parse path separate from `stage` | `src/cli/graph.test.ts` — "parseGraphArgs" block ("rejects a foreign command"); `src/cli/main.test.ts` — "submits through runCli using the host-owned environment" |
| C4 | No ticket/graph/node/destination/provider/capability/generation in argv; trailing argv rejected | `src/cli/graph.test.ts` — "rejects trailing argv"; "rejects every forbidden argv field" |
| C5 | Capability hash is the sole authenticator | `src/cli/graph.test.ts` — "rejects a forged capability idempotently" (state unchanged) |
| C6 | Capability ≥256 bits, hash-only at rest, one-shot on the first mutating verb | `src/cli/graph.test.ts` — "submits the fixed planner artifact and marks the run submitted" (hash recorded, not plaintext); "rejects a duplicate submission idempotently" (one-shot consumption) |
| C7 | No capability in argv/URLs/logs/diagnostics/artifacts/UI/reports | `src/cli/graph.ts` — the parser accepts no capability argument (`parseGraphArgs`); `src/cli/graph.test.ts` — "rejects every forbidden argv field" includes `--capability` |
| E1 | Validate-and-copy one operation per file on one descriptor (`O_NOFOLLOW\|O_NONBLOCK`, fstat the fd, read the fd, never re-resolve) | `src/approaches/graph/artifacts/snapshot.test.ts` — "rejects a symlink at open (O_NOFOLLOW)"; "rejects a FIFO (O_NONBLOCK open, fstat not regular)"; "snapshots the validated bytes even when the path is swapped after open" |
| E2 | Reject non-regular files, link count > 1, oversize, media-type mismatch | `src/approaches/graph/artifacts/snapshot.test.ts` — "rejects a directory"; "rejects a hardlinked file"; "rejects an oversize file"; "rejects a media-type mismatch"; "rejects declared application/json bytes that do not parse" |
| E3 | Planner process terminated and proven dead before its submission snapshot | Protocol side proven: `snapshot.test.ts` — "snapshots the validated bytes even when the path is swapped after open" (a post-validation rewrite cannot change the snapshot; the descriptor is opened on the validated object). The termination-sequencing half rides the supervised transport and ships at Slice 3 T3 — Slice 2 launches no processes, so there is no planner process to terminate yet. |
| E4 | Artifact roots and workspaces under global storage, outside every worktree | `snapshot.test.ts` — "git status stays clean in the worktree while artifacts exist"; "resolves artifacts and workspaces under global storage, per graph run" |
| E5 | Prompt bytes snapshotted at run creation; edits take effect on the next run | `src/approaches/graph/coordinator/plannerRun.test.ts` — "snapshots the prompt bytes at run creation; a mid-run edit does not affect the run"; "blocks with instructions-missing on an unreadable override and spends nothing" |
| E6 | Paths reject absolute, `..`, dot segments, Windows alias set (pure-string tests) | `src/approaches/graph/paths.test.ts` — full table of rejections; `src/approaches/graph/parse.test.ts` — "path rules" block |
| E7 | Required output staging destinations absent at launch | `snapshot.test.ts` — "refuses a launch when a required output staging destination already exists" |
| E8 | Consumers read only the recorded snapshot hash; the mutable path is never authoritative | `snapshot.test.ts` — "snapshots a regular file into content-addressed storage" (stored under the SHA-256; the swap test proves the recorded hash names the validated bytes) |
| E9 | `deleteTicket` removes graph rows and bytes; archive removes neither | `src/store/tickets.test.ts` — "hard delete removes every graph row and the byte subtree"; "archive removes neither rows nor bytes" |
| F9 | Every graph-derived string escaped; ANSI/unsafe schemes stripped; CSP authoritative | `src/model/inside/graph.test.ts` — "removes ANSI/control sequences and unsafe link schemes"; "renders every graph-derived string with ANSI/controls and unsafe schemes removed, bounded" |
| H6 | `token_usage` graph FKs are `ON DELETE SET NULL` | `src/store/tickets.test.ts` — "token_usage rows survive with their graph FKs set to NULL"; schema pinned by `src/store/graph/schema.test.ts` |
| I5 | `graph-topology-deadlock` is statically computable and rejected at compile | `src/approaches/graph/compile.test.ts` — "rejects a join budgeted below its fork multiplicity" (runtime side, leads-to-replan, is Slice 4) |
| I7 | Node-run rest states have exactly the two exits; only completed/cancelled terminal | `src/store/graph/transitions.test.ts` — "the rest states each carry exactly the two exits: recovery launch and drain cancel"; "completed and cancelled are the only terminal statuses" |
| I8 | `completed-awaiting-impl-marker → cancelled` exists | `src/store/graph/transitions.test.ts` — "admits exactly the documented pairs" (graph-run map) |

## Non-graph test modifications

No pre-existing non-graph test was modified except where a task explicitly
extended it:

- `src/cli/assertMigrated.test.ts`, `src/cli/guide.test.ts`, `src/cli/main.test.ts` — Slice 2 T6 (graph store opener schema guard, guide verb, CLI routing).
- `src/store/tickets.test.ts` — Slice 2 T8 (graph evidence delete policy).
- `src/ui/dashboard/state.test.ts` — Slice 2 T10 (graph inside wiring).

All other Slice 2 test files are new graph tests.

## Cross-slice invariants

1. Graph exists only inside `impl` — no graph module imports `machine.ts`/`graph.ts`; the graph CLI (`src/cli/graph.ts`) never imports the workflow machine and produces no `Verdict` (C3/C4 tests).
2. Karst owns routing — no agent-authored string names a node/edge/destination/provider in argv; the closed parser accepts none (C4).
3. Every double-spend-capable mutation is a single `BEGIN IMMEDIATE` transaction with an affected-row check — the submit conditional UPDATE is the T6 contract (B-rows, C5/C6).
4. Nothing blocks the extension-host event loop — no `spawnSync` on any graph path; the CLI graph store uses `BEGIN IMMEDIATE` + bounded busy timeout (T6).
5. Untrusted input parsed by a closed parser at every boundary — parser (T3), compiler (T4), CLI argv (T6), artifact bytes (T7).
6. Capability hash is the sole authenticator (T6).
7. Evidence written when it happens — planner-run rows and prompt snapshots commit before any wake-up (T5/T6).
8. Nothing karst generates lands inside a worktree — snapshot locations under global storage, no `KARST_EXCLUDE_RULES` entry (T7, E4).
9. Non-graph behavior untouched — full suite green; only explicitly-extended non-graph tests changed (above).
10. Token accounting stays at one seam per mode — T5/T6 add no second ledger; `token_usage` graph FKs are the only new columns (H6).

## Notes

- E3's termination-sequencing half is deferred to Slice 3 T3 by construction:
  Slice 2 executes no planner process, so the "terminated and proven dead
  before its submission snapshot" flow has no process to supervise yet; the
  snapshot protocol side (never re-resolve, descriptor on the validated
  object) is proven by the swap test.
- Slice 2 ships nothing executable: `karst graph submit` is inert until a
  host wires a running planner (Slice 3), and the Inside projection is behind
  its feature flag (T10).
