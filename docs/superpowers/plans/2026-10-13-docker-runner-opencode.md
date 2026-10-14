# Plan: plain-Docker runner for opencode and opencode2

Parent: T667. Depends on: the sbx runner plan (`2026-10-13-sbx-runner-claude-codex.md`) — reuses its `SessionRunner` widening, `backendResolver`, `agentBackend` setting, sync command and diagnostics line. Rule: `arch:AC-31`. Evidence: `spikes/docker-sandbox/opencode/RESULTS.md` (ST2B, CONDITIONAL GO macOS; Linux unverified; Windows desk-check).

## Goal

With `agentBackend: docker`, an `opencode` or `opencode2` ticket session runs in a plain `docker run` container with an enforced domain allowlist. Fail closed to host prompted mode with a reason. agy stays on host (deferred).

## Decisions (fixed)

1. **Clone mode, same as sbx.** The container gets a fresh clone of the ticket branch on a named volume; the host worktree is never mounted rw, the shared `.git` is never mounted. Commits leave via a host-side fetch from the volume clone (read-only mount of the volume's repo into a short-lived helper, or `git fetch` from a `git daemon` bound to the internal network — pick in task 6, record why). This removes ST2B blocker 1 (hook planting).
2. **Image:** `karst/opencode-sandbox:<opencodeVersion>` built from a checked-in `Dockerfile` (`node` base, git, pinned opencode). Data dirs pre-created and owned by `node` (ST2B blocker 3). Built locally on first use; never pulled from an unpinned tag.
3. **Network:** per-ticket `--internal` network + CONNECT-proxy sidecar enforcing `SANDBOX_NETWORK_ALLOWLIST` (ST2B blocker 4, exp 8). No route out except the proxy.
4. **Credentials:** opencode v1 — read-only mount of the opencode `auth.json` into the data volume. opencode2 — `opencode auth export` piped to `opencode auth import` inside the container on first create; the stream is never logged or written to disk (ST2B blocker 2). Doc note: an env key is visible to the agent — prefer a scoped key (blocker 7).
5. **Linux:** `--user <uid>:<gid>` (resolved with `process.getuid()`/`process.getgid()`, never shell expansion) with a writable `HOME` tmpfs (blocker 5).
6. **Never** `--privileged`, never mount `/var/run/docker.sock`, argv arrays only.

## Components

| File | Purpose |
|---|---|
| `sandbox/opencode/Dockerfile` | pinned image; copied to `dist/` by `scripts/copy-assets.mjs` |
| `src/agent/docker/dockerProcess.ts` | async `DockerProcess` seam (no `spawnSync`) |
| `src/agent/docker/dockerPreflight.ts` | docker reachable, image present or buildable, network create permitted |
| `src/agent/docker/proxySidecar.ts` | start/stop allowlist proxy on the ticket network (port of `spikes/docker-sandbox/opencode/allowlist-proxy.mjs`) |
| `src/agent/docker/dockerRunner.ts` | `createDockerSessionRunner`: create volume + clone, network, sidecar, `docker run -it` for interactive, `docker exec` for headless, `sync`, `dispose` |
| `src/agent/backendResolver.ts` | `docker` + opencode/opencode2 → docker runner; other cores → host with reason |
| `src/agent/opencode.ts`, `opencode2.ts` | declare `sandboxInteractive` supported **only via runner** (surface reason updated); XDG isolation env passed through unchanged |
| `.github/workflows/ci.yml` | non-blocking `docker-sandbox-linux` job running `spikes/docker-sandbox/opencode/linux-ci.sh` |
| `docs/arch/agent-cores.md` | extend `AC-32` with the docker backend; Windows section marked UNVERIFIED |

## Task order (TDD)

1. Dockerfile + image tag function — test: tag derives from pinned version; build argv exact.
2. `dockerPreflight` — each failure → one reason; never throws.
3. `proxySidecar` — unit: allowlist parsing, CONNECT allow/deny; integration (`*.integration.test.ts`): real proxy on loopback.
4. Resolver cases for docker × each core.
5. `dockerRunner.placeInteractive` — exact `docker run` argv (network, volume, user on linux, no socket, no privileged); paths with spaces.
6. Clone-out/sync mechanism — ff ok, non-ff refused; record chosen transport in AC-32.
7. opencode2 credential seeding — test that the secret never reaches a debug/log callback (spy all `debug` calls).
8. `runHeadless` via `docker exec`; abort kills.
9. `dispose` — removes exactly this ticket's container, sidecar, network, volume; bystander survives.
10. Session wiring + diagnostics line `backend: docker (<container>)`.
11. Conformance: under docker runner `enforcesSandbox === true`; host + bypass still refused for opencode/opencode2.
12. CI job + docs.

## Exit criteria

- Unit + integration + typecheck green; Stryker ≥ 85 on touched `src/extension/**`.
- Manual F5 macOS: opencode and opencode2 sessions in the container, TUI usable in the VS Code terminal (ST2B exp 3 manual item), commit synced to host, allowlisted domain reachable, other domain blocked, restart keeps session (data volume).
- Linux CI job green (records ST2B Linux verdict live).
- Windows: documented UNVERIFIED (Docker Desktop + WSL2, `C:\` → `/mnt/c`, bind-mount speed).

## Out of scope

agy (deferred), Claude/Codex (sbx plan), evidence bridge (next plan).
