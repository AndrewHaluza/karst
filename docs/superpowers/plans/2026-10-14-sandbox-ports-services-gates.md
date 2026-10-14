# Plan: sandbox ports, services and gates (Docker plan Increment 4)

Parent: T667. Builds on ST4 (sbx runner), ST5 (docker runner), ST6 (bridge). Spec base: `docs/superpowers/plans/2026-07-28-docker-sandbox-agent-sessions.md` §Increment 4. Evidence: ST2 exp 8 (`sbx ports`), ST2B exp 9 (port to host for UAT, child processes). Rules: `arch:AC-31`, `arch:AC-32`, `arch:ORPHANS` (server reaping), no `spawnSync`, verdicts by exit code.

## Goal

For a ticket whose session runs in sbx or docker: its declared services run inside the sandbox and are reachable from the host only on Karst-allocated ports; its test/build/UAT gates run inside the same sandbox against the agent's live edits.

## Decisions (fixed)

1. **Hot services run in the sandbox.** A repository's manifest `services` (the per-ticket "hot" ones) start inside the sandbox via the runner. Host keeps today's port allocator; the runner publishes ONLY the allocated port of each declared service (`sbx ports publish` / `docker run -p 127.0.0.1:<host>:<container>`). Undeclared ports are never published. Bind host side to `127.0.0.1` only.
2. **Baseline (shared) services stay on the host.** The sandbox reaches a baseline service only through an explicit per-port allow (`sbx policy` rule / allowlist proxy entry for `host.docker.internal:<port>`) generated from the manifest; nothing else on the host is reachable.
3. **Gates run in the sandbox** through a new async `runner.runGate(spec)` (sbx: `sbx exec`, docker: `docker exec`) that returns the command's exit code; the verdict rule is unchanged. Gate evidence files are written to the ST6 bridge dir, verified by the host verifier. Host runner: `runGate` is today's host gate path (zero behaviour change).
4. **Server row only after publish + health.** Health checks hit the published `127.0.0.1:<hostPort>`.
5. **Conflict:** if the allocated host port is taken at publish time, reallocate once via the existing allocator; second failure → explicit error, no server row.
6. **Restart:** on sandbox restart (reattach), re-verify every recorded mapping; republish missing ones; drop rows whose service is not healthy.
7. **UAT: one instance, agent first.** Agent UAT (the Tester gate, inside the sandbox, hitting the in-sandbox port) and user UAT (host browser on the published `127.0.0.1:<hostPort>`) use the SAME service instance — the user tests exactly what the agent tested. They never overlap: the user UAT link is shown only after the agent UAT gate finishes.
8. **Optional reset before user UAT:** if a service declares the new optional manifest field `reset` (a command; add it per `arch:FIELDCHK`), run it (inside the sandbox, via `runner.runGate`) between agent UAT and user UAT; otherwise state is left as the Tester left it. No new instance is started.

## Components

| File | Purpose |
|---|---|
| `src/agent/sessionRunner.ts` | add optional `publishPort?`, `unpublishPort?`, `runGate?` |
| `src/agent/sbx/sbxPorts.ts` | `sbx ports` argv + parse |
| `src/agent/docker/dockerPorts.ts` | `-p` mapping at create; port listing via `docker port` |
| `src/agent/sandboxServices.ts` | start/stop declared services inside the sandbox, publish, health, write server row |
| `src/agent/sandboxHostAllow.ts` | baseline-service allow rules per runner |
| gate runner wiring (find with `grep -rn 'GateRunner' src`) | route through `runner.runGate` when the ticket's backend is sandboxed |
| `src/extension/ops/serverOps.ts` | sandbox branch for start/stop/health (Notify seam) |
| `docs/arch/agent-cores.md` | extend `AC-32` |

## Task order (TDD)

1. Port argv per runner — one declared port publishes to allocated host port, bound to 127.0.0.1; undeclared never.
2. Conflict → one reallocation, then explicit failure; no server row on failure.
3. `sandboxServices` — row written only after publish + health; two repository entries sharing a `repoPath` keep distinct port identities.
4. Baseline allow rules — only declared baseline ports; other host ports blocked (integration test with the allowlist proxy for docker; argv test for sbx).
5. `runGate` per runner — exit code passthrough, abort kills, evidence lands in bridge dir; long gate keeps event loop responsive (fake timers + async proc).
6. Host runner `runGate` — byte-identical to today's gate path (existing gate tests unchanged).
7. Restart re-verification — missing mapping republished; unhealthy row removed.
8. UAT ordering — user UAT link withheld until agent UAT gate ends; same instance (one server row); declared reset runs between, absent reset is a no-op.
9. Cleanup — stopping one ticket's services removes only its mappings (bystander ticket survives).
10. Docs AC-32; `npm run -s docs:index`.

## Exit criteria

- Suites green; Stryker ≥ 85 on touched `src/extension/**`.
- Manual F5 (macOS): a Node service starts in an sbx Claude session and a docker opencode session, opens in the host browser on the allocated port, test + UAT gates run inside the sandbox and produce verdicts.
- Host backend: existing service and gate flow unchanged.

## Out of scope

Archive/recovery (ST8), settings UI (ST9), agy.
