# Plan: sandbox backend rollout and UI (Docker plan Increment 6)

Parent: T667. Depends on ST7 (ports/services/gates) and ST8 (archive/recovery) — the UI exposes their actions. Spec base: `docs/superpowers/plans/2026-07-28-docker-sandbox-agent-sessions.md` §Increment 6. Rules: `docs/ui/README.md` (read first), `arch:FIELDCHK`, `arch:SAVE`, `ui:APPX-V31` (Settings is the one React surface), `arch:AC-31`, `arch:AC-32`.

## Goal

A user can pick, understand, check and clean up the sandbox backend from the UI. It stays opt-in; host stays the default.

## Decisions (fixed)

1. **Settings:** `agentBackend` selector (host / sbx / docker) in the Agents section of the Settings webview, with a per-core "effective backend" line (e.g. "claude: sbx · opencode: docker · agy: host (no sandbox)").
2. **Per-ticket override:** ticket field `agentBackend` (host / project default), only to opt OUT of the project setting; never to opt into an unavailable backend. Follow `arch:SCHEMA-CHECK` for the column.
3. **Status:** Doctor checks for sbx (installed, signed in, policy), docker (reachable, image), each with a fix hint; the same status shows next to the selector.
4. **Session UI:** dashboard/ticket view shows backend + workspace mode (clone) + network profile, and actions Sync, Stop, Remove (ST8 guard applies to Remove).
5. **Fallback is visible and explicit:** when the chosen backend is unavailable, the session start shows "running prompted on host: <reason>" — the existing fail-closed behaviour, made visible, never silent.
6. **Disk:** show sandbox count + approximate disk use in Doctor; warn above 10 GB (constant, not config).
7. **Default stays `host`.** Changing the default is a later decision after Linux live + Windows coverage; not in this plan.

## Components

| File | Purpose |
|---|---|
| `src/ui/settings/app/sections/AgentsSection.tsx` (+ draft/save plumbing) | selector + effective backend + status |
| ticket form (`src/ui/ticketForm/**`) | per-ticket override |
| dashboard inside view (`src/ui/dashboard/insideActions.ts`) | backend line + Sync/Stop/Remove |
| `src/doctor/sandboxChecks.ts` | sbx/docker status + disk |
| `src/extension/ops/*` | bindings only in `extension.ts` (`ratchet.test.ts`) |
| docs | `docs/guides/adding-agent-core.md` (runner interaction), new guide `docs/guides/sandbox-backends.md` (prerequisites, sbx login/OAuth per core, clone-mode trust boundary, ports/network troubleshooting, disk cleanup), `AC-32` |

## Task order (TDD)

1. Manifest/Settings field round-trip per `arch:FIELDCHK` (`agentBackend` already parsed by ST4 — add UI draft/save).
2. Effective-backend derivation (pure) — each core × setting × preflight result.
3. AgentsSection render tests (`renderWebviewReady('settings')`).
4. Doctor checks + disk warning.
5. Ticket override column + form + resolver precedence (ticket opt-out beats project).
6. Dashboard backend line + actions wired to ST8 ops. Add a real diff view for ST8's "Open sync diff" choice (today it only re-runs sync): show `git diff <host branch>...sandbox-<name>/<branch>` in a VS Code diff/readonly editor before the user decides.
7. Visible fallback message at session start.
8. Docs + guide.
9. `npm run -s test:visual:docker` after webview changes; never edit baselines or the layout ledger to pass.

## Exit criteria

- Suites + visual advisory green; Stryker ≥ 85 on touched `src/extension/**`.
- Manual F5: pick sbx in Settings, status turns green, start a Claude ticket → sbx; pick docker for opencode ticket → docker; per-ticket opt-out → host; Remove from the dashboard cleans up.

## Out of scope

Default flip, agy, remote runners (E2B/Daytona — rejected).
