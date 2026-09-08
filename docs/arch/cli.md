# The `karst` CLI (`src/cli/`)

The agent-facing surface. The invoking agent reads ticket content it did not author, so prompt injection reaches argv — every rule here exists because of that. Related: `docs/arch/stages-and-gates.md` (the marker the CLI fires), `docs/arch/store-and-schema.md` (the schema version it asserts).

## Contents

- The agent-facing CLI verbs are separate parse paths
- The CLI uses Node's built-in node:sqlite
- A bare ticket key is resolved via --manifest
- `stats` is a read the build proves is a read
- The CLI cannot migrate

## The agent-facing CLI verbs are separate parse paths, and that separation is the security property

The invoking agent reads ticket content it did not author, so prompt injection reaches argv. `parseStageArgs` narrows to `MARKER_STAGES × {pass}` — widening it would put other handling inside the one function whose job is refusing a forged `stage ship pass`. So `phase` parses elsewhere (`cli/phase.ts`), produces no `Verdict`, and never imports the machine: the worst a fully-injected call does is append a row. Phase names are a shell token interpolated into that command, so one charset (`approaches/phaseName.ts`) is enforced at install, at compose, and again on receipt — argv is never trusted because install-time validation ran. `attempt` and `markedAt` are server-side; trailing argv is rejected, not ignored.

## The `karst` CLI uses Node's built-in `node:sqlite`, NOT better-sqlite3

— it is invoked by the agent via plain `node`, so the Electron-ABI addon would crash. Verbs: `context` (read), `stats` (read), `stage` and `phase` (write), `test` (the agent test driver, including `test create-ticket --project <slug>` — scope created tickets to a project, `--manifest`'s id being the fallback, or the ticket never appears on a board), and `guide` (the agent manual — how Karst works, the flow, the verbs; static content, no DB). Aggregator/store helpers reached from here stay driver-agnostic (`store.db.prepare(sql).get/all/run`, positional `?` only — no named params, no `.pluck()`); `openReadonlyStore`/`openWritableStore` cast a `DatabaseSync` behind the `Store` type at that boundary, the writable one adding a hand-rolled `.transaction()` shim. Prints an `ExperimentalWarning` to stderr (harmless; stdout stays clean JSON). **The guide is the ONE agent-facing manual, and `cli/guide.test.ts` pins it to the real CLI**: a new verb, a changed marker set, or a changed stage flow fails `npm run test:unit` until the guide mentions it — an agent must never have to read the extension's source to learn what Karst can do.

## A bare ticket key is resolved via `--manifest`

The `karst` CLI takes a bare ticket key, so `--manifest` is what tells it which project's key that is (`cli/resolveTicket.ts`); both `context` and `stage` fall back to an unscoped lookup so an unadopted ticket still resolves. A purely numeric argument is tried as a `tickets.id` LAST — after both key lookups miss — because agent sessions are handed `KARST_TICKET_ID` (an id) while every verb takes a key; a ticket whose KEY is that number always wins, and the failure reads `no ticket found for key or id`.

## `stats` is a read the build proves is a read

`karst stats [--project <slug>] [--since <iso>] [--json]` reports orchestration effectiveness from what the store already records: first-pass rate (`stage_runs.outcome`), rework loops (`recovery_rounds`), gate kills (`gate_runs`, where a NULL `exit_code` is "no such script" and never a pass), cycle time, agent-active time, token spend by call site (reported and `estimated` kept apart), escaped defects, finding density, the agent-vs-human review-finding split, merge friction, ship failures, graph efficiency and interruption rate. The queries live in `src/store/metrics/` (one family per file, positional `?` only), the render in `src/cli/stats.ts`.

Two properties are enforced, not promised. **Read-only**: `cli/statsNonInterference.test.ts` walks the module graph reachable from `stats.ts` and `store/metrics/index.ts` and fails on write SQL, on `node:child_process`/socket modules, and on any workflow/runtime/agent import — which is why the project lookup is an inline SELECT rather than an import of `store/projects.ts` (that module owns an upsert). **Nothing is approximated**: four metrics the schema cannot answer (human intervention count, a ticket-level merge stamp, gate flake rate, waiting-on-human wall clock) are printed as unavailable with the missing column named, in `UNAVAILABLE_METRICS`.

## The CLI cannot migrate

(it opens with `node:sqlite`, read-only for `context`). Both CLI stores assert `user_version >= SCHEMA_VERSION` up front (`cli/assertMigrated.ts`) and fail naming the file and both versions — otherwise a stale registry surfaces as a raw `no such column: repo` that tells the invoking agent nothing.

`dist/cli/main.js` is a second, separately bundled esbuild entrypoint (`scripts/build-extension.mjs`, alongside `dist/extension.js`), and `scripts/verify-build.mjs` smoke-runs `guide` after every build to catch it going missing.