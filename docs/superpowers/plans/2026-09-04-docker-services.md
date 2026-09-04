# Docker services (spin docker images) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** A manifest repository may declare its service as a Docker image; `spin` runs it, health-gates it, logs it, and reaps it with the same no-leak guarantees native servers have.

**Architecture:** `ServiceDef` gains an optional `docker` block. It is NOT a second runtime: a pure renderer (`runtime/dockerCommand.ts`) turns the block plus the resolved env/port into the same `{command, args}` pair `startHot` already spawns, so port reclaim, health gating, log path, `servers` row, cwd attribution and `killTree` all keep working unchanged. The one thing a pid cannot express — a container outliving its client — is closed by a DETERMINISTIC container name recorded in `servers.container` (v54) and a fire-and-forget `docker rm -f <name>` on every stop/reap path. The container is a stronger handle than a pid (never reissued), so container removal happens even when pid attribution refuses to signal.

**Tech Stack:** TypeScript ESM, vitest, better-sqlite3, `docker` CLI (no SDK).

## Global Constraints

- `vscode` is never a runtime import; new logic is host-agnostic and takes injected callbacks (`debug`).
- `spawnSync` is banned; container removal uses `spawn` detached + unref, or the async `AsyncProcess` seam.
- Debug lines are `[runtime]`-prefixed and go through the INJECTED `debug` callback.
- Strict TDD: failing test first. Conventional commits. Files < 400 lines.
- `noUncheckedIndexedAccess` is on; imports carry `.js`.
- New `servers` column follows the store new-column checklist (`docs/arch/store-and-schema.md`): schema.sql column appended LAST + guarded `ALTER TABLE` migration, version bumped.

---

### Task 1: Manifest — the `docker` service block

**Files:** `src/manifest/types.ts`, `src/manifest/validate/repository.ts`, `src/manifest/load.test.ts`, `karst.example.yml`

Shape:

```yaml
service:
  docker:
    image: postgres:16
    containerPort: 5432          # required — the port INSIDE the container
    env: { POSTGRES_PASSWORD: dev }
    volumes: ['./data:/var/lib/postgresql/data']
    args: ['postgres', '-c', 'log_statement=all']   # optional command override
  ports: [{ name: http, env: PORT, default: 5432 }]
```

Rules (strict mode only, so a disabled draft can be half-filled):
- exactly one of `start` / `docker` — both is an error, neither is an error;
- `image` non-empty, `containerPort` a valid port;
- `env` a flat string→string map; `volumes` an array of `src:dst[:opts]` strings;
- `docker` at repository level is a stray runtime field (add to `RUNTIME_FIELDS`).

- [ ] Failing tests in `load.test.ts` for each rule → implement `validateDocker` → green → commit.

### Task 2: `runtime/dockerCommand.ts` — pure renderer

**Files:** create `src/runtime/dockerCommand.ts` + `dockerCommand.test.ts`

```ts
export function containerName(service: string, ticketId: number | null): string
export function renderDockerRun(input: {
  docker: DockerDef; container: string; hostPort: number; host: string;
  env: Record<string, string>; cwd: string;
}): { command: 'docker'; args: string[] }
```

- `docker run --rm --name <container> -p <host>:<hostPort>:<containerPort> -e K=V… -v <abs>:<dst> <image> [args…]`
- env is the RESOLVED spawn env (dep bind vars + PORT) merged with `docker.env` (block wins).
- relative volume sources resolve against `cwd` (the worktree); absolute pass through.
- `containerName` sanitizes to `[A-Za-z0-9_.-]`, shape `karst-<ticket|baseline>-<service>`.

### Task 3: `runtime/dockerContainer.ts` — removal seam

**Files:** create `src/runtime/dockerContainer.ts` + test

```ts
export function removeContainer(name: string, opts?: { spawnFn?: SpawnFn; debug?: Debug }): void
export function removeContainerAsync(name: string, opts?): Promise<void>
```

Sync form: `spawn('docker', ['rm','-f',name], { detached: true, stdio: 'ignore' }).unref()` — never blocks the host, never throws. Async form (awaitable, used pre-spawn to clear a stale name) with a bounded timeout.

### Task 4: store — `servers.container` (v54)

**Files:** `src/store/schema.sql`, `src/store/migrations.ts`, `src/store/runningServers.ts`, tests

Column appended last, PRESENCE-guarded ALTER, `SCHEMA_VERSION = 54`.

### Task 5: `startHot` records and pre-clears the container

**Files:** `src/runtime/supervisor.ts`, `supervisor.test.ts`

- `StartHotOpts.container?: string`; when set, `await removeContainerAsync(container)` BEFORE spawn (a stale same-named container would make `docker run` fail on a name clash), and the INSERT writes `container`.
- `stopServer` reads `container` and calls `removeContainer` after `killTree`.

### Task 6: reap paths

**Files:** `src/runtime/worktreeServers.ts`, tests

`ServerRow` gains `container`; `reap` calls `removeContainer` for a docker row on EVERY outcome including `row-cleared` (the name is a valid handle even when the pid is not), and `describeReap` says the container was removed.

### Task 7: spin wiring

**Files:** `src/runtime/spin.ts`, `src/runtime/baseline.ts`, tests

When `service.docker` is present, build the command from `renderDockerRun` instead of `splitCommand(service.start)` and pass `container`.

### Task 8: UI

**Files:** `src/ui/settings/webview.html`, `src/ui/settings/actions.ts`, dashboard/ticket-form service rows

- Settings repository card: a "Docker image" mode with image / container port / env / volumes inputs, mutually exclusive with the start command input.
- Every surface that names a service shows the canonical Docker mark + `docker` label per `docs/ui/UI-RULES.md` (icon-only status stays icon-only).
