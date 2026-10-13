# Plan: sbx runner for Claude and Codex (Docker plan Increment 2)

Parent: T667 (SANDBOXED-AUTONOMOUS-AGENT). Rule: `arch:AC-31`. Spec base: `docs/superpowers/plans/2026-07-28-docker-sandbox-agent-sessions.md` §Increment 2. Evidence: `spikes/docker-sandbox/RESULTS.md` (ST2, CONDITIONAL GO).

## Goal

A ticket session for the `claude` or `codex` core can run inside a Docker `sbx` sandbox (microVM, private daemon, credential proxy). Opt-in. Host stays the default. Fail closed: if sbx cannot be used, the session runs on the host in today's prompted mode and diagnostics say why.

## Decisions (fixed — do not re-open)

1. **Backend setting:** manifest `agentBackend: 'host' | 'sbx' | 'docker'`, default `host`. `sbx` applies to claude/codex only; for any other core the resolver returns `host` with reason `"<core>: sbx backend unsupported"`. `docker` is reserved for the opencode plan; until that lands it resolves to `host` with reason `"docker backend not implemented"`. `agentSandbox` (ST1) is unchanged and independent.
2. **Workspace model: clone mode** (ST2 exp 10). `sbx create --clone`. Never direct-mount the worktree, never mount the shared `.git` (ST2 exp 12: hooks → host code execution).
3. **Edits are not live.** The agent commits inside the sandbox. The host gets them as remote `sandbox-<name>/<branch>`. A host-side `syncFromSandbox` fast-forwards the ticket branch in the host worktree. Non-fast-forward → refuse, report, never force.
4. **Never pass** `--mount-docker-socket`, and never compose a shell string: executable + argv array only.
5. Credentials: sbx proxy only (`sbx secret set` is a user step, documented, never run by karst).

## Components

| File | Purpose |
|---|---|
| `src/agent/sessionRunner.ts` | widen `kind` to `'host' \| 'sbx'`; add optional `sync?(ticket): Promise<SyncResult>` and `dispose?(ticket): Promise<void>` |
| `src/agent/sbx/sbxProcess.ts` | injectable async `SbxProcess` seam (`run(args, opts) → {code, stdout, stderr}`), real impl via async `spawn` — **no `spawnSync`** |
| `src/agent/sbx/sbxName.ts` | stable name: `karst-<projectHash8>-<ticketId>-<core>`; reject anything outside `[a-z0-9-]`, max 63 |
| `src/agent/sbx/sbxPreflight.ts` | checks in order: binary on PATH, `sbx version`, signed in (`sbx ls` exit 0, no `not signed in`), policy present; returns `{ok:true} \| {ok:false, reason}` |
| `src/agent/sbx/sbxRunner.ts` | `createSbxSessionRunner(proc, ...)`: `placeInteractive` → terminal running `sbx run --name <n> <core> -- <adapter args>` (creates with `--clone` on first use, reattaches by name after); `runHeadless` → `sbx exec`; `sync`; `dispose` → `sbx stop` + `sbx rm --force <exact name>` + remove host remote |
| `src/agent/backendResolver.ts` | `(manifest, core, preflight) → {runner, line}`; the only place that picks a runner |
| `src/manifest/{types,schema,write}.ts` | `agentBackend` field, validation, write overlay (follow `arch:FIELDCHK`) |
| `src/ui/session.ts` | take runner from the resolver per launch; log `[session] ticket <key> backend: sbx (<name>)` or `host (<reason>)` at INFO |
| `src/extension.ts` | binding only: pass manifest `agentBackend` |
| `src/extension/ops/sandboxSyncOps.ts` | command `karst.sandbox.sync` (manual pull of sandbox commits) with `Notify` seam |
| `docs/arch/agent-cores.md` | new block `AC-32` "Sandbox backends" (keyed format) |

## Task order (TDD, each RED → GREEN)

1. `sbxName` — tests: stable across calls; differs across projects with same ticket key; rejects `../`, spaces, upper case, >63.
2. `sbxProcess` fake + `sbxPreflight` — tests: each failure maps to one actionable reason; success path; never throws.
3. `backendResolver` — tests: default host; `sbx`+claude+preflight ok → sbx; `sbx`+opencode → host w/ reason; preflight fail → host w/ reason; `docker` → host w/ reason.
4. Manifest field — `load.test.ts` (valid values, bad value throws `ManifestError`), `writeManifest.test.ts` round-trip.
5. `sbxRunner.placeInteractive` — exact argv for fresh claude, fresh codex, reattach; path with spaces stays one element; adapter model/resume/effort args preserved after `--`.
6. `sbxRunner.runHeadless` — argv via `sbx exec`; exit code passthrough; abort signal kills.
7. `sync` — fake git: ff succeeds; non-ff refused with message; missing remote → reason.
8. `dispose` — targets exactly one name; leaves a bystander sandbox (ST2 exp 9 pattern).
9. `session.ts` wiring — runner chosen per launch; diagnostics line; creation failure does not set agent live; terminal close does NOT dispose.
10. AC-31 interplay — under `sbx`, claude/codex may receive relaxed permission args **only** because `runner.enforcesSandbox === true`; conformance test: host runner + bypass still refused.
11. Docs block AC-32; `docs/INDEX.md` regenerated (`npm run -s docs:index`).

## Exit criteria

- Unit suite + typecheck + lint:react green; Stryker ≥ 85 on touched `src/extension/**`.
- Manual F5 (macOS): fresh claude + codex session in sbx, type and follow up, commit inside, `karst.sandbox.sync` brings the commit to the host worktree, close/reopen reattaches by name, provider resume works.
- `agentBackend` absent → byte-identical host behaviour (existing session tests unchanged).

## Out of scope

opencode/opencode2 (next plan), agy (deferred, no spike), evidence bridge (Increment 3 plan), ports/services/gates (Increment 4+).
