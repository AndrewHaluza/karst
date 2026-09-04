# The store: SQLite, projects, and schema changes

The registry is shared by every IDE window, so every rule here is about scoping and about changing the schema without stranding a row. Related: `docs/arch/cli.md` (the CLI asserts the version but cannot migrate), `docs/arch/stages-and-gates.md` (the evidence tables).

## Contents

- SQLite is source of truth
- Projects scope the board across IDE windows
- Global storage is shared by every window
- The artifact shelf is a READ over existing evidence
- The per-ticket base-branch columns
- The per-ticket env overrides column
- New schema column checklist

## SQLite is source of truth

SQLite is source of truth; `reconcileOnStart`/`deriveStageCurrent` re-derive on boot.

## Projects scope the board across IDE windows

The DB lives in *global* storage — every window shares it — so every ticket query MUST be scoped or window A lists/drives window B's tickets. Identity is `projects.slug`, from manifest `id:` else a path-derived fallback (`project/slug.ts`); `bindProject` (`project/bind.ts`) registers it at activation. Pass `{ projectId }` to `listTickets`/`listArchivedTickets`/`getTicketByKey`/`createTicket`; unscoped is the deliberate all-projects view (recovery only). Ticket `key` is unique **per project**, not globally. Legacy `project_id IS NULL` rows are adopted once per install, guarded by a globalState flag AND "only one project exists".

## Global storage is shared by every window

Global storage is shared by every window: anything written there needs a per-window key. `writeHookSettings` names its file by the window's ephemeral hook port for exactly this reason (`agent/settingsSweep.ts` reaps old ones). Same trap in `globalState`: the remembered hook port lives in **`workspaceState`** — each window binds its own port, and a global key let the second window's EADDRINUSE fallback overwrite the first's, so the first could never reclaim the port its live sessions still post to.

## The artifact shelf is a READ over existing evidence, never a new write surface

`model/artifacts.ts` derives semantic artifacts (uat-report, review, ship-summary) from `stages`, `gate_runs`, `review_findings`, `uat_findings`, `process_runs`, `ship_runs`, and `prs` — the same evidence rows the inside views already render. Origin `core` is resolved from the immutable identity snapshot `process_runs.provider` (captured at launch, never rewritten), falling back to `tickets.session_provider` then `tickets.agent_provider` — never invented. The detail payload rides the same snapshot (no async `artifact.get` round trip); the only failure mode is a missing resource file, reported by the host opener exactly like `openStageLog` (extension.ts:4599). Staleness is whether impl/fix re-ran after the artifact — a stale artifact still renders its content, it just warns it no longer validates current code. `DashboardState.artifacts` is the single host-side derivation (state.ts); the webview's index/detail are local renders. `artifact-open-resource` carries artifact id + resource index — never a path — and the host re-derives before opening.

## The per-ticket base-branch columns

`tickets.base_refs` (schema v48) is a JSON map of manifest repository NAME → plain branch name, the PRE-spin override; after spin, `worktrees.base_ref` is the authority (`docs/arch/worktrees-and-servers.md`'s base-branch section). `worktrees.needs_force_push` (schema v49) is armed only when `changeBaseRef`'s rebase actually rewrote the branch, and is read and cleared by the same statement (`takeForcePushLease`) so one rewrite arms exactly one force push.

## The per-ticket env overrides column

`tickets.env_overrides` (schema v55) is a JSON map of scope → `{KEY: value}`, where a scope is a manifest repository NAME or `*` (every service). It is merged into a hot service's spawn env between the repository's `.env` and karst's resolved vars — see `docs/arch/worktrees-and-servers.md`'s spawn-env section for the layering and why the resolved vars still win. NULL is the canonical "nothing overridden"; writes are per SCOPE (`setServiceEnvOverrides`), scoped like `setDisabledGates` so an editor that loaded before another service was touched cannot revert it.

## New schema column checklist

New schema column checklist: `schema.sql` (fresh DBs) + a guarded ALTER in `migrations.ts` + bump `SCHEMA_VERSION` + update db.test.ts's version/table-count assertions. Migrations never backfill data they can't derive — defer that to the host (see project adoption). Guards read the CURRENT columns (`tableColumns`), so a fresh DB skips the step and a re-open is a no-op — that is what keeps v10's `service`→`repo` RENAME (the one non-additive step) idempotent.