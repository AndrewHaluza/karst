# Plan: sandbox lifecycle and evidence bridge (Docker plan Increment 3)

Parent: T667. Depends on: sbx runner plan and docker runner plan (works for whichever has landed; the second runner adds its transport). Spec base: `docs/superpowers/plans/2026-07-28-docker-sandbox-agent-sessions.md` §Increment 3. Evidence: ST2 exp 6 (file bridge), exp 7 (verifier rejects foreign markers).

## Goal

Karst features that today read host-side signals from the agent — hook events (needs-you, launch intent), stage markers / done markers, gate evidence — work unchanged when the session runs in an sbx or docker sandbox, and a sandbox can never forge another ticket's or stage's evidence.

## Decisions (fixed)

1. **Transport: path-bound file bridge** (ST2 exp 6). Inside the sandbox the agent writes NDJSON to `/karst-bridge/<ticketId>/events.ndjson`; that dir is the ONLY rw host mount (a per-ticket host dir under globalStorage, never the worktree). Host polls it (async, interval from config, no `spawnSync`). No loopback network relay (blocked by sbx policy by default; not pursued).
2. **Host verifier is the authority:** every event is checked against the session's own ticket id, stage, and agent session id; anything else is dropped and debug-logged (`[bridge]`). Verdicts stay exit-code based (CLAUDE.md invariant) — the bridge never carries a verdict.
3. Hook bridge (`HOOK-CONTRACT.md`) gets a sandbox channel: the in-sandbox hook writes to the bridge file instead of the HTTP endpoint. `HOOK-04` rules apply.

## Components

| File | Purpose |
|---|---|
| `src/agent/bridge/bridgeDir.ts` | per-ticket host dir path, create/remove |
| `src/agent/bridge/bridgePoller.ts` | async tail of `events.ndjson`, offset persisted, handles truncation |
| `src/agent/bridge/bridgeVerifier.ts` | port of `spikes/docker-sandbox/06-bridge/verify-events.mjs`; pure function |
| `src/agent/sbx/sbxRunner.ts`, `src/agent/docker/dockerRunner.ts` | mount the bridge dir; pass hook channel config pointing to it |
| `src/agent/claude.ts`, `codex.ts`, `opencode*.ts` | hook writer selects file channel when the runner says so (AC-08: all adapters or declared) |
| `docs/agent-cores/HOOK-CONTRACT.md`, `docs/arch/agent-cores.md` | sandbox channel; AC-32 update |

## Task order (TDD)

1. `bridgeVerifier` — accept own ticket/stage; reject other ticket, other stage, malformed line, oversized line.
2. `bridgePoller` — partial lines, truncation, restart from persisted offset.
3. Runner mounts — exact argv adds only the bridge dir rw.
4. Hook channel selection per adapter + conformance test.
5. End-to-end (`*.e2e.test.ts`, fake runner): event written in "sandbox" dir reaches the needs-you signal; forged marker for another ticket is dropped.
6. Lifecycle: dispose removes the bridge dir; reconcileOnStart re-attaches pollers for live sandboxes.

## Exit criteria

- Suites green; Stryker ≥ 85 on touched `src/extension/**`.
- Manual F5: needs-you and done marker work from an sbx claude session and a docker opencode session.

## Out of scope

Ports/services/gates inside the sandbox (Increment 4), archive/recovery/provider switch (5), rollout/default flip (6), agy.
