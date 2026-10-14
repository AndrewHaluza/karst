# Plan: sandbox archive, recovery and provider switch (Docker plan Increment 5)

Parent: T667. Builds on ST4/ST5/ST6; independent of ST7 except that cleanup must also remove ST7 port mappings when ST7 has landed. Spec base: `docs/superpowers/plans/2026-07-28-docker-sandbox-agent-sessions.md` §Increment 5. Rules: `arch:AC-31`, `arch:AC-32`, `arch:GLOBAL` (per-window keys), `arch:ORPHANS`, no `spawnSync`.

## Today (facts)

- `runner.dispose` exists and is called only from `sandboxSyncOps.ts` (manual).
- `archiveOps.ts` does not touch sandboxes.
- `bootSweeps.ts` re-attaches ST6 evidence bridges on activation but does not reconcile sandboxes themselves.

## Goal

Sandboxes follow the ticket lifecycle: found again after reload, stopped when idle, removed on archive, never lost with unsynced commits, never leaked, never controlled by the wrong window.

## Decisions (fixed)

1. **Identity is derived, not stored:** the sandbox name already encodes project hash + ticket id + core (`sbxName.ts`, `dockerNames.ts`). Reconcile lists sandboxes by this project's prefix; no new table. If a column is unavoidable, follow `arch:SCHEMA-CHECK`.
2. **Stop vs remove:** terminal close → nothing (ST4 rule). Ticket reaches `done` or the session is idle past the existing idle threshold → `stop`. Archive → `remove`. Never remove outside archive or explicit user action.
3. **Unsynced work guard:** before remove (archive or switch), run `sync`; if the sandbox has commits not on the host branch and sync is refused (non-ff), block the remove and ask the user (Notify with choices: open sync diff / remove anyway / cancel). Default = cancel.
4. **Recovery on activation:** for each live ticket of THIS window with a sandboxed backend: sandbox running → adopt (reattach terminal by name, no duplicate); stopped → leave stopped, restart on next open; missing → next open creates a fresh sandbox AND a fresh provider session (never another ticket's session id).
5. **Orphans:** sandboxes with this project's prefix and no live/archived-pending ticket are reported in Doctor and the output log, removed only on user confirmation. Other projects' sandboxes are never touched.
6. **Provider switch:** if a ticket's core changes so the backend kind changes (sbx ↔ docker ↔ host), require sync, dispose the old sandbox (guard 3), and drop the stored provider session id. A foreign session id is never passed to a different core.
7. **Multi-window:** only the window that owns the ticket (existing ownership rule) may stop/remove/adopt its sandbox.

## Components

| File | Purpose |
|---|---|
| `src/agent/sandboxInventory.ts` | list this project's sandboxes for both runners (async), parse names back to ticket/core |
| `src/agent/sessionRunner.ts` | optional `stop?`, `status?` (running/stopped/missing) |
| `src/extension/ops/archiveOps.ts` | call sync-guard + `dispose` (and ST7 unpublish) before worktree archive |
| `src/extension/ops/bootSweeps.ts` | sandbox reconcile (adopt / leave stopped / note missing) next to the bridge sweep |
| `src/extension/ops/sandboxLifecycleOps.ts` | stop-on-done/idle, provider-switch handling, orphan cleanup command (Notify seam) |
| `src/doctor/sandboxOrphanCheck.ts` | orphan report |
| `docs/arch/agent-cores.md` | `AC-32` lifecycle section |

## Task order (TDD)

1. `sandboxInventory` — parses own names, ignores other projects, both runners.
2. Reattach — running sandbox + restored terminal → no duplicate create.
3. Missing sandbox → fresh provider session, never another ticket's id.
4. Stopped sandbox restarts on open.
5. Stop on done/idle; terminal close does nothing.
6. Archive — sync ok → dispose exact sandbox, worktree archive unchanged; unsynced + refused → blocked, user choice honoured.
7. Remove clears only that ticket's association/mappings; bystander survives.
8. Provider switch — sync + dispose old, session id dropped, conformance: no foreign id reaches a different core.
9. Multi-window — non-owner window cannot stop/remove/adopt.
10. Orphan check in Doctor + confirmed cleanup command.
11. Docs.

## Exit criteria

- Suites green; Stryker ≥ 85 on touched `src/extension/**` (archiveOps, bootSweeps, new ops).
- Manual F5: reload window → sandboxed session reattaches; archive removes the sandbox (sbx and docker) and `sbx ls` / `docker ps -a` show nothing for the ticket; unsynced commit blocks archive until confirmed.

## Out of scope

Settings UI (ST9), agy.
