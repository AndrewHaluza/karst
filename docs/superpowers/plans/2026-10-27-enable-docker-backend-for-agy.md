# Enable Docker Backend for Agy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable `docker` backend support for `agy` (antigravity) across manifest validation, backend choices, placement/container naming, `bridgeDir` wiring, Settings UI, and sandboxed conversation/usage watch in `agyWatchLoop`.

**Architecture:** Reconcile `'agy'` (used in `karst.yml` and Settings UI) with `'antigravity'` (used in `AgentProvider` and session providers) by adding both to `DOCKER_CORES`, canonicalizing container/sandbox names to `karst-<hash8>-<id>-antigravity*` via `sbxName`, and supporting dual-key lookups in `backendForCore`. Thread `bridgeDir` into `resolveDocker` so credentials and gemini configs mount properly. Extend `agyWatchLoop` to read from the ticket's sandbox app data directory (`<bridgeDir>/antigravity/gemini/antigravity-cli`) and match either host or container repo paths (`CONTAINER_REPO = '/work/repo'`), while preserving the host worktree path in hook payloads. Update manifest parsing, Settings UI tests, visual test focus count ratchet, and architecture documentation (`@arch:AC-26`, `@arch:AC-31`, `@arch:AC-32`, `@arch:AC-33`).

**Tech Stack:** TypeScript, React, Docker, Vitest, Playwright, SQLite (`better-sqlite3`).

**Spec:** Ticket ENABLE-DOCKER-BACKEND-FOR-AGY (T815, P29 / D250); design constraints `@arch:AC-26`, `@arch:AC-31`, `@arch:AC-32`, `@arch:AC-33`, `@ui:REACT-VIEWS`, `@ui:UPDATE-BASELINE`, commits `70f408d4df6`, `6882bd2209b`, D249 (PR #776), T772.

## Global Constraints

- Backend choice is plain `docker`, not `sbx` (`sbx` v0.48.0 has no `agy` microVM template or credential proxy).
- Core ID reconciliation: `BACKEND_CORES` uses `'agy'` (`@arch:AC-32`), while `AgentProvider` is `'antigravity'`. Both are added to `DOCKER_CORES`.
- Container and resource naming: `sbxName` (used by `dockerNames`) canonicalizes `'agy' -> 'antigravity'` so Docker container, network, volume, and proxy names are always `karst-<hash8>-<id>-antigravity*`, matching `parseSandboxInventory` and `t.sessionProvider === 'antigravity'`.
- Exact key precedence: `backendForCore(backends, core)` checks `map?.[core] ?? map?.[backendCoreKey(core)] ?? 'host'` so per-ticket `'host'` overrides in `backendSessionOptions` are never shadowed by `backends.agy`.
- Per-ticket override safety: `backendSessionOptions` sets both `[backendCoreKey(input.core)]: backend` and `[input.core]: backend`.
- Thread `bridgeDir` through `ResolveBackendInput` (`backendResolver.ts`) and `backendSessionOptions` into `resolveDocker`.
- Container watch boundary (`@arch:AC-26`): `agyWatchLoop` resolves `ticketAppDataDir` per ticket (`<bridgeDir>/antigravity/gemini/antigravity-cli` when present, else host `appDataDir`) and passes it to both `findConversationForWorktree(ticketAppDataDir, [worktree.path, CONTAINER_REPO])` and `readAgyConversationIdle(ticketAppDataDir, found.conversationId)`.
- Hook payload safety: `HookPayload.cwd` remains equal to host `worktree.path` (never `/work/repo`) so `dispatchHook` matches the ticket in SQLite.
- Resilience: Wrap `db.workspaceBlob()` in `findConversationForWorktree` and `db.pendingApprovalCount()` / `db.usage()` in `agyWatchLoop` inside `try/catch` to handle transient `SQLITE_BUSY` locks during container writes without dropping the sweep.
- Visual ratchet: Update `FOCUS_COUNT_RATCHET.settings` from `193` to `195` with fifteenth note justification in `tests/visual/focus.visual.ts`, and re-record affected Settings visual baselines via `npm run -s test:visual:docker:update`.
- Architecture docs: Update `@arch:AC-26`, `@arch:AC-31`, `@arch:AC-32`, and `@arch:AC-33` in `docs/arch/agent-cores.md`.

---

### Task 1: Add 'antigravity' and 'agy' to `DOCKER_CORES` in `sandboxCores.ts` and Collapse `DockerRunnerCore` in `dockerImage.ts`

**Files:**
- Modify: `src/agent/sandboxCores.ts:5-6`
- Modify: `src/agent/docker/dockerImage.ts:33-40`
- Modify: `src/agent/docker/dockerImage.test.ts:30-40`

**Interfaces:**
- Consumes: None
- Produces: `DockerCore = 'opencode' | 'opencode2' | 'antigravity' | 'agy'`, `DOCKER_CORES = ['opencode', 'opencode2', 'antigravity', 'agy'] as const`, `DockerRunnerCore = DockerCore`

- [ ] **Step 1: Write the failing test**

In `src/agent/docker/dockerImage.test.ts`, update the `DOCKER_CORES` and `containerBinary` tests:

```typescript
  it('lists the supported docker cores including antigravity and agy', () => {
    expect(DOCKER_CORES).toEqual(['opencode', 'opencode2', 'antigravity', 'agy']);
  });

  it('maps both antigravity and agy to agy binary', () => {
    expect(containerBinary('antigravity')).toBe('agy');
    expect(containerBinary('agy')).toBe('agy');
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:unit -- src/agent/docker/dockerImage.test.ts`
Expected: FAIL with `DOCKER_CORES` mismatch (missing `'antigravity'` and `'agy'`).

- [ ] **Step 3: Write minimal implementation**

In `src/agent/sandboxCores.ts`:
```typescript
/** Which cores each sandbox backend can host (arch:AC-32). Dependency-free: the Settings webview imports it. */
export type SbxCore = 'claude' | 'codex';
export const SBX_CORES: readonly SbxCore[] = ['claude', 'codex'];

export type DockerCore = 'opencode' | 'opencode2' | 'antigravity' | 'agy';
export const DOCKER_CORES: readonly DockerCore[] = ['opencode', 'opencode2', 'antigravity', 'agy'] as const;
```

In `src/agent/docker/dockerImage.ts`, collapse `DockerRunnerCore` to `DockerCore`:
```typescript
import { DOCKER_CORES, type DockerCore } from '../sandboxCores.js';

/** The cores the docker backend can host. */
export { DOCKER_CORES, type DockerCore };

/** Cores accepted by the Docker runner (arch:AC-33). */
export type DockerRunnerCore = DockerCore;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:unit -- src/agent/docker/dockerImage.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/agent/sandboxCores.ts src/agent/docker/dockerImage.ts src/agent/docker/dockerImage.test.ts
git commit -m "feat(docker): add antigravity and agy to DOCKER_CORES and collapse DockerRunnerCore"
```

---

### Task 2: Canonicalize Container and Sandbox Names to `antigravity` in `sbxName.ts`

**Files:**
- Modify: `src/agent/sbx/sbxName.ts:20-33`
- Modify: `src/agent/sbx/sbxName.test.ts:26-38`

**Interfaces:**
- Consumes: `DOCKER_CORES`, `SBX_CORES` from `src/agent/sandboxCores.js`
- Produces: `sbxName(input: SbxNameInput): string`

- [ ] **Step 1: Write the failing test**

In `src/agent/sbx/sbxName.test.ts`, update lines 26-28 and add canonicalization test:

```typescript
  it.each(['null', '', 'gemini', 'unknown'])('rejects the non-sandbox core %j', (core) => {
    expect(() => sbxName({ projectRoot: '/p', ticketId: 7, core })).toThrow(/not a sandbox core/);
  });

  it('canonicalizes agy to antigravity for container and sandbox naming', () => {
    const agyName = sbxName({ projectRoot: '/p/one', ticketId: 7, core: 'agy' });
    const antiName = sbxName({ projectRoot: '/p/one', ticketId: 7, core: 'antigravity' });
    expect(agyName).toBe(antiName);
    expect(agyName).toMatch(/^karst-[0-9a-f]{8}-7-antigravity$/);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:unit -- src/agent/sbx/sbxName.test.ts`
Expected: FAIL because `sbxName` currently constructs `name = ...-${input.core}` yielding `karst-...-7-agy` instead of `karst-...-7-antigravity`.

- [ ] **Step 3: Write minimal implementation**

In `src/agent/sbx/sbxName.ts`:

```typescript
export function sbxName(input: SbxNameInput): string {
  if (!Number.isInteger(input.ticketId) || input.ticketId <= 0) {
    throw new Error(`sbx name: invalid ticket id ${String(input.ticketId)}`);
  }
  if (!(ALLOWED_CORES as readonly string[]).includes(input.core)) {
    throw new Error(`sbx name: core ${JSON.stringify(input.core)} is not a sandbox core`);
  }
  const core = input.core === 'agy' ? 'antigravity' : input.core;
  const hash = createHash('sha256').update(input.projectRoot).digest('hex').slice(0, 8);
  const name = `karst-${hash}-${input.ticketId}-${core}`;
  if (!SAFE.test(core) || name.length > MAX_LEN) {
    throw new Error(`sbx name: unsafe name ${JSON.stringify(name)}`);
  }
  return name;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:unit -- src/agent/sbx/sbxName.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/agent/sbx/sbxName.ts src/agent/sbx/sbxName.test.ts
git commit -m "feat(sandbox): canonicalize agy core to antigravity in sbxName"
```

---

### Task 3: Core Reconciliation in `backendChoices.ts` and Dual-Key Setting in `sandboxSyncOps.ts`

**Files:**
- Modify: `src/agent/backendChoices.ts:16-27`
- Create: `src/agent/backendChoices.test.ts`
- Modify: `src/extension/ops/sandboxSyncOps.ts:74-76`
- Modify: `src/extension/ops/sandboxSyncOps.test.ts`

**Interfaces:**
- Consumes: `DOCKER_CORES`, `SBX_CORES` from `src/agent/sandboxCores.js`
- Produces: `backendCoreKey(core: string): string`, `allowedBackends(core: string): readonly CoreBackend[]`, `backendForCore(backends: AgentBackends | undefined, core: string): CoreBackend`

- [ ] **Step 1: Write the failing test**

Create `src/agent/backendChoices.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { allowedBackends, backendCoreKey, backendForCore, type AgentBackends } from './backendChoices.js';

describe('backendChoices', () => {
  it('maps antigravity to agy in backendCoreKey and leaves other cores unchanged', () => {
    expect(backendCoreKey('antigravity')).toBe('agy');
    expect(backendCoreKey('agy')).toBe('agy');
    expect(backendCoreKey('claude')).toBe('claude');
    expect(backendCoreKey('opencode')).toBe('opencode');
  });

  it('returns host and docker for both agy and antigravity', () => {
    expect(allowedBackends('agy')).toEqual(['host', 'docker']);
    expect(allowedBackends('antigravity')).toEqual(['host', 'docker']);
  });

  it('checks exact key first, then mapped key, defaulting to host', () => {
    const backends: AgentBackends = { agy: 'docker' };
    expect(backendForCore(backends, 'agy')).toBe('docker');
    expect(backendForCore(backends, 'antigravity')).toBe('docker');

    // Per-ticket override with exact 'antigravity' key takes precedence over 'agy'
    const overridden: AgentBackends = { agy: 'docker', antigravity: 'host' as any };
    expect(backendForCore(overridden, 'antigravity')).toBe('host');
    expect(backendForCore(overridden, 'agy')).toBe('docker');

    expect(backendForCore(undefined, 'antigravity')).toBe('host');
    expect(backendForCore({}, 'unknown')).toBe('host');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:unit -- src/agent/backendChoices.test.ts`
Expected: FAIL (`backendCoreKey is not a function` or `allowedBackends('agy')` does not include `docker`).

- [ ] **Step 3: Write minimal implementation**

In `src/agent/backendChoices.ts`:

```typescript
/**
 * Canonical key for looking up a core in `AgentBackends` maps.
 * Manifest keys and Settings use 'agy', while session providers use 'antigravity'.
 */
export function backendCoreKey(core: string): string {
  return core === 'antigravity' ? 'agy' : core;
}

/** The values a core can be set to; host is always first. */
export function allowedBackends(core: string): readonly CoreBackend[] {
  const key = backendCoreKey(core);
  if ((SBX_CORES as readonly string[]).includes(key)) return ['host', 'sbx'];
  if ((DOCKER_CORES as readonly string[]).includes(key) || (DOCKER_CORES as readonly string[]).includes(core)) return ['host', 'docker'];
  return ['host'];
}

/** The backend one core is set to (absent → host). Exact key wins, then mapped key. */
export function backendForCore(backends: AgentBackends | undefined, core: string): CoreBackend {
  const map = backends as Readonly<Record<string, CoreBackend | undefined>> | undefined;
  return map?.[core] ?? map?.[backendCoreKey(core)] ?? 'host';
}
```

In `src/extension/ops/sandboxSyncOps.ts`, update `backendSessionOptions`:
Import `backendCoreKey` from `../../agent/backendChoices.js`.
In line 75:
```typescript
    const out = await resolve({
      backends: { ...input.backends, [backendCoreKey(input.core)]: backend, [input.core]: backend },
      core: input.core,
      projectRoot: input.projectRoot,
      ticketId: input.ticketId,
      ...(input.worktree?.branch ? { worktree: { hostWorktreePath: input.worktree.path, branch: input.worktree.branch } } : {}),
      ...(input.debug || input.hostPorts || input.sandboxMemory ? {
        docker: { ...(input.debug ? { debug: input.debug } : {}), ...(input.hostPorts ? { hostPorts: input.hostPorts } : {}), ...(input.sandboxMemory ? { sandboxMemory: input.sandboxMemory } : {}) },
      } : {}),
    });
```

In `src/extension/ops/sandboxSyncOps.test.ts`, add a test verifying that per-ticket `'host'` opt-out on `'antigravity'` tickets passes both keys to `resolve`:
```typescript
  it('sets both backendCoreKey and core in backends for resolveRunner', async () => {
    let capturedBackends: Record<string, unknown> | undefined;
    const resolve = vi.fn(async (inp: any) => {
      capturedBackends = inp.backends;
      return { runner: HOST_SESSION_RUNNER, line: 'host (opt-out)' };
    });
    const opts = backendSessionOptions({
      backends: { agy: 'docker' },
      ticketOverride: 'host',
      core: 'antigravity',
      projectRoot: '/p',
      ticketId: 7,
      ticketLabel: 'T-7',
      info: () => undefined,
      resolve: resolve as any,
    });
    await opts.resolveRunner!();
    expect(capturedBackends).toMatchObject({ agy: 'host', antigravity: 'host' });
  });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test:unit -- src/agent/backendChoices.test.ts src/extension/ops/sandboxSyncOps.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/agent/backendChoices.ts src/agent/backendChoices.test.ts src/extension/ops/sandboxSyncOps.ts src/extension/ops/sandboxSyncOps.test.ts
git commit -m "feat(backend): add backendCoreKey, dual-key resolution, and per-ticket override propagation"
```

---

### Task 4: Plumb `bridgeDir` through `ResolveBackendInput` and `backendSessionOptions` into `resolveDocker`

**Files:**
- Modify: `src/agent/backendResolver.ts:11-47`
- Modify: `src/agent/backendResolver.test.ts`
- Modify: `src/extension/ops/sandboxSyncOps.ts:43-85`
- Modify: `src/extension/ops/sandboxSyncOps.test.ts`

**Interfaces:**
- Consumes: `bridgeFor?: (ticketId: number) => Promise<BridgePaths>` from `BackendSessionInput`
- Produces: `ResolveBackendInput.bridgeDir?: string` passed into `resolveDocker({ ..., bridgeDir: input.bridgeDir })`

- [ ] **Step 1: Write the failing test**

In `src/agent/backendResolver.test.ts`, add a test verifying `bridgeDir` is threaded to `resolveDocker`:

```typescript
  it('forwards bridgeDir to resolveDocker when backend is docker', async () => {
    let capturedBridgeDir: string | undefined;
    const res = await resolveBackend({
      backends: { agy: 'docker' },
      core: 'agy',
      projectRoot: '/proj',
      ticketId: 42,
      bridgeDir: '/bridge/events/42',
      docker: {
        preflight: async () => ({ ok: false, reason: 'test-stop' }),
      },
    });
    expect(res.line).toBe('host (test-stop)');
  });
```

And in `src/extension/ops/sandboxSyncOps.test.ts`, test that `backendSessionOptions` awaits `bridgeFor` and passes `paths.dir` as `bridgeDir` to `resolve`:

```typescript
  it('resolves bridgeFor and passes bridgeDir to resolveBackend', async () => {
    let capturedBridgeDir: string | undefined;
    const resolve = vi.fn(async (inp: any) => {
      capturedBridgeDir = inp.bridgeDir;
      return { runner: HOST_SESSION_RUNNER, line: 'host (done)' };
    });
    const opts = backendSessionOptions({
      backends: { agy: 'docker' },
      core: 'antigravity',
      projectRoot: '/p',
      ticketId: 10,
      ticketLabel: 'T-10',
      info: () => undefined,
      bridgeFor: async (id) => ({ dir: `/test/bridge/${id}` } as any),
      resolve: resolve as any,
    });
    await opts.resolveRunner!();
    expect(capturedBridgeDir).toBe('/test/bridge/10');
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test:unit -- src/agent/backendResolver.test.ts src/extension/ops/sandboxSyncOps.test.ts`
Expected: FAIL (`bridgeDir` is not passed to `resolve`).

- [ ] **Step 3: Write minimal implementation**

In `src/agent/backendResolver.ts`:
Add `readonly bridgeDir?: string;` to `ResolveBackendInput`:
```typescript
export interface ResolveBackendInput {
  /** The per-core map; the session core's entry decides (absent → host). */
  readonly backends: AgentBackends | undefined;
  readonly core: string;
  readonly projectRoot: string;
  readonly ticketId: number;
  readonly proc?: SbxProcess;
  readonly preflight?: (proc: SbxProcess) => Promise<SbxPreflight>;
  readonly host?: SessionRunner;
  /** The ticket worktree and branch; the docker backend clones it. */
  readonly worktree?: SandboxTicketRef;
  readonly bridgeDir?: string;
  readonly docker?: DockerResolveDeps;
}
```
And in line 42 (`backend === 'docker'`):
```typescript
  if (backend === 'docker') {
    const docker = await resolveDocker({
      core: input.core,
      projectRoot: input.projectRoot,
      ticketId: input.ticketId,
      worktree: input.worktree,
      bridgeDir: input.bridgeDir,
      ...(input.docker ? { deps: input.docker } : {}),
    });
    return docker.ok ? { runner: docker.runner, line: `docker (${docker.names.container})` } : onHost(docker.reason);
  }
```

In `src/extension/ops/sandboxSyncOps.ts`, in `backendSessionOptions`:
```typescript
  const resolveRunner = async (): Promise<ResolvedBackend> => {
    const bridgePaths = input.bridgeFor ? await input.bridgeFor(input.ticketId).catch(() => undefined) : undefined;
    const out = await resolve({
      backends: { ...input.backends, [backendCoreKey(input.core)]: backend, [input.core]: backend },
      core: input.core,
      projectRoot: input.projectRoot,
      ticketId: input.ticketId,
      ...(bridgePaths?.dir ? { bridgeDir: bridgePaths.dir } : {}),
      ...(input.worktree?.branch ? { worktree: { hostWorktreePath: input.worktree.path, branch: input.worktree.branch } } : {}),
      ...(input.debug || input.hostPorts || input.sandboxMemory ? {
        docker: { ...(input.debug ? { debug: input.debug } : {}), ...(input.hostPorts ? { hostPorts: input.hostPorts } : {}), ...(input.sandboxMemory ? { sandboxMemory: input.sandboxMemory } : {}) },
      } : {}),
    });
    // The fail-closed fallback is never silent (arch:AC-31): say why it runs prompted.
    if (backend !== 'host' && out.runner.kind === 'host') input.warn?.(`Karst: ${input.ticketLabel} running prompted on host: ${fallbackReason(out.line)}`);
    return out;
  };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test:unit -- src/agent/backendResolver.test.ts src/extension/ops/sandboxSyncOps.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/agent/backendResolver.ts src/agent/backendResolver.test.ts src/extension/ops/sandboxSyncOps.ts src/extension/ops/sandboxSyncOps.test.ts
git commit -m "feat(docker): plumb bridgeDir through resolveBackend and backendSessionOptions into resolveDocker"
```

---

### Task 5: Sandboxed Conversation and Usage Watch in `findConversationForWorktree` and `agyWatchLoop`

**Files:**
- Modify: `src/agent/agyConversationWatch.ts:151-207`
- Modify: `src/agent/agyConversationWatch.test.ts`
- Modify: `src/extension/ops/agyWatchLoop.ts:1-165`
- Modify: `src/extension/ops/agyWatchLoop.test.ts`
- Modify: `src/extension.ts:5971-5986`

**Interfaces:**
- Consumes: `CONTAINER_REPO` from `src/agent/docker/dockerRunArgs.js`, `bridgePaths` from `src/agent/bridge/bridgeDir.js`
- Produces: `findConversationForWorktree(appDataDir: string, worktreePath: string | readonly string[], ...)` supporting multiple worktree paths, `AgyWatchLoopDeps.sandboxAppDataDir?: (ticketId: number) => string | undefined`, SQLITE_BUSY handling in `findConversationForWorktree` and `agyWatchLoop`.

- [ ] **Step 1: Write the failing tests**

In `src/agent/agyConversationWatch.test.ts`, add tests for `CONTAINER_REPO` path candidate and error resilience:
```typescript
  it('finds conversation when workspace blob contains CONTAINER_REPO (/work/repo)', () => {
    const blob = Buffer.from('file:///work/repo');
    const fakeDb: AgyConversationDb = {
      workspaceBlob: () => blob,
      pendingApprovalCount: () => 0,
      usage: () => null,
      close: vi.fn(),
    };
    const found = findConversationForWorktree(
      '/appdata',
      ['/host/repo', '/work/repo'],
      () => fakeDb,
      () => ['/appdata/conversations/conv-123.db'],
    );
    expect(found?.conversationId).toBe('conv-123');
  });

  it('tolerates db.workspaceBlob() throwing (e.g. SQLITE_BUSY)', () => {
    const throwingDb: AgyConversationDb = {
      workspaceBlob: () => { throw new Error('SQLITE_BUSY: database is locked'); },
      pendingApprovalCount: () => 0,
      usage: () => null,
      close: vi.fn(),
    };
    const found = findConversationForWorktree(
      '/appdata',
      '/host/repo',
      () => throwingDb,
      () => ['/appdata/conversations/conv-busy.db'],
    );
    expect(found).toBeNull();
  });
```

In `src/extension/ops/agyWatchLoop.test.ts`, add test for `sandboxAppDataDir`:
```typescript
  it('reads from sandboxAppDataDir when present on disk and preserves host worktree path in HookPayload.cwd', () => {
    const sandboxDir = mkdtempSync(join(tmpdir(), 'agy-sandbox-'));
    const convDir = join(sandboxDir, 'conversations');
    mkdirSync(convDir, { recursive: true });
    // Write fake summary and conversation DBs in sandboxDir...
    // Verify that dispatchHook receives HookPayload with cwd: worktree.path (host path, never /work/repo)
  });

  it('tolerates SQLITE_BUSY when reading pending approval or usage in agyWatchLoop', () => {
    // Verify loop does not throw or abort sweep when db.pendingApprovalCount() or db.usage() throws
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test:unit -- src/agent/agyConversationWatch.test.ts src/extension/ops/agyWatchLoop.test.ts`
Expected: FAIL (`findConversationForWorktree` doesn't accept array, or `sandboxAppDataDir` not supported).

- [ ] **Step 3: Write minimal implementation**

In `src/agent/agyConversationWatch.ts`:
Update `blobNamesWorktree`:
```typescript
function blobNamesWorktree(blob: Buffer, worktreePath: string | readonly string[]): boolean {
  const paths = typeof worktreePath === 'string' ? [worktreePath] : worktreePath;
  const candidates = paths.flatMap((p) => [p, canonicalPath(p)]);
  for (const candidate of candidates) {
    if (candidate && blob.includes(Buffer.from(FILE_URI_PREFIX + candidate))) return true;
  }
  return false;
}
```
Update `findConversationForWorktree`:
```typescript
export function findConversationForWorktree(
  appDataDir: string,
  worktreePath: string | readonly string[],
  openDb: OpenAgyDb = openAgyConversationDb,
  listDbs: (dir: string) => string[] = (dir) => {
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((name) => name.endsWith('.db'))
      .map((name) => join(dir, name));
  },
): { dbPath: string; conversationId: string } | null {
  let best: { dbPath: string; conversationId: string; mtimeMs: number } | null = null;
  for (const dbPath of listDbs(join(appDataDir, AGY_CONVERSATIONS_RELATIVE))) {
    let db: AgyConversationDb;
    try {
      db = openDb(dbPath);
    } catch {
      continue; // a conversation being created concurrently must not fail the tick
    }
    try {
      let blob: Buffer | null;
      try {
        blob = db.workspaceBlob();
      } catch {
        continue; // transient SQLITE_BUSY: skip file
      }
      if (blob === null || !blobNamesWorktree(blob, worktreePath)) continue;
      const mtimeMs = (() => {
        try {
          return statSync(dbPath).mtimeMs;
        } catch {
          return 0;
        }
      })();
      if (best === null || mtimeMs > best.mtimeMs) {
        best = { dbPath, conversationId: conversationIdOf(dbPath), mtimeMs };
      }
    } finally {
      db.close();
    }
  }
  return best === null ? null : { dbPath: best.dbPath, conversationId: best.conversationId };
}
```

In `src/extension/ops/agyWatchLoop.ts`:
Import `CONTAINER_REPO` from `../../agent/docker/dockerRunArgs.js`.
Add `readonly sandboxAppDataDir?: (ticketId: number) => string | undefined;` to `AgyWatchLoopDeps`.
In `run()`:
```typescript
        const custom = deps.sandboxAppDataDir?.(named.ticketId);
        const ticketAppDataDir = custom && existsSync(custom) ? custom : appDataDir;

        let snapshot: AgyConversationSnapshot | null = null;
        let agyUsage: AgyConversationUsage | null = null;
        try {
          const found = findConversationForWorktree(ticketAppDataDir, [worktree.path, CONTAINER_REPO]);
          if (found) {
            const db = openAgyConversationDb(found.dbPath);
            try {
              let pending = false;
              try {
                pending = db.pendingApprovalCount() > 0;
              } catch {
                // transient SQLITE_BUSY: keep false
              }
              snapshot = {
                dbPath: found.dbPath,
                conversationId: found.conversationId,
                pendingApproval: pending,
                idle: readAgyConversationIdle(ticketAppDataDir, found.conversationId),
              };
              try {
                agyUsage = db.usage();
              } catch {
                // transient SQLITE_BUSY: keep null
              }
            } finally {
              db.close();
            }
          }
        } catch (error) {
          deps.logError(`karst: agy conversation read failed for ticket ${named.ticketId}`, error);
          continue;
        }
```

In `src/extension.ts`:
In `createAgyWatchLoop`:
Import `bridgePaths` from `./agent/bridge/bridgeDir.js`.
```typescript
  const agyWatchLoop = createAgyWatchLoop({
    store: localStore,
    listTerminals: () => vscode.window.terminals,
    identifyTerminal: (terminal) => terminalIdentity.identify(terminal as vscode.Terminal),
    sandboxAppDataDir: (ticketId) => {
      if (!bridgeRoot) return undefined;
      return join(bridgePaths(bridgeRoot, ticketId).dir, 'antigravity', 'gemini', 'antigravity-cli');
    },
    agyWatchStates,
    agyUsageStates,
    notifyHook,
    shouldApplyHookState,
    sessionProviderFor,
    hookChannelRecorder,
    debug: (message) => logger.debug(message),
    logError,
  });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test:unit -- src/agent/agyConversationWatch.test.ts src/extension/ops/agyWatchLoop.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/agent/agyConversationWatch.ts src/agent/agyConversationWatch.test.ts src/extension/ops/agyWatchLoop.ts src/extension/ops/agyWatchLoop.test.ts src/extension.ts
git commit -m "feat(agy): poll container conversation and summary DBs in agyWatchLoop across container boundary"
```

---

### Task 6: Manifest Validation and Settings UI Tests

**Files:**
- Modify: `src/manifest/load.test.ts:2126-2162`
- Modify: `src/ui/settings/app/sections/AgentsSection.test.tsx:635-655`

**Interfaces:**
- Consumes: Manifest schema, `BackendPanel.tsx`
- Produces: Passing test suites asserting `agentBackends.agy: docker` is valid, legacy `agentBackend: docker` includes `agy`, and Settings UI renders enabled `host` and `docker` buttons.

- [ ] **Step 1: Write the updated tests**

In `src/manifest/load.test.ts`:
Update line 2126:
```typescript
    const m = load('agentBackends:\n  claude: sbx\n  codex: host\n  opencode: docker\n  opencode2: docker\n  agy: docker');
    expect(m.agentBackends).toEqual({ claude: 'sbx', opencode: 'docker', opencode2: 'docker', agy: 'docker' });
```
Update line 2135:
```typescript
    ['agy: sbx', /agentBackends\.agy must be one of host, docker/],
```
Remove `['agy: docker', ...]` from rejected entries.
Update line 2161:
```typescript
    expect(load('agentBackend: docker').agentBackends).toEqual({ opencode: 'docker', opencode2: 'docker', agy: 'docker' });
```

In `src/ui/settings/app/sections/AgentsSection.test.tsx`:
Update lines 638-650:
```typescript
    expect(values('claude')).toEqual(['host', 'sbx']);
    expect(values('codex')).toEqual(['host', 'sbx']);
    expect(values('opencode')).toEqual(['host', 'docker']);
    expect(values('opencode2')).toEqual(['host', 'docker']);
    expect(values('agy')).toEqual(['host', 'docker']);
    for (const core of ['claude', 'codex', 'opencode', 'opencode2', 'agy']) expect(checkedOf(core)).toEqual(['host']);
```
Replace the old `the agy row is host only, disabled, with a "no sandbox yet" note` test with:
```typescript
  it('the agy row offers host and docker enabled without a "no sandbox yet" note', () => {
    mount();
    expect((radio('agy', 'host') as HTMLButtonElement).disabled).toBe(false);
    expect((radio('agy', 'docker') as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByTestId('backend-row-agy').textContent).not.toContain('no sandbox yet');
  });
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `npm run test:unit -- src/manifest/load.test.ts src/ui/settings/app/sections/AgentsSection.test.tsx`
Expected: PASS

- [ ] **Step 3: Run full typecheck**

Run: `npm run typecheck`
Expected: PASS with 0 errors.

- [ ] **Step 4: Commit**

```bash
git add src/manifest/load.test.ts src/ui/settings/app/sections/AgentsSection.test.tsx
git commit -m "test(manifest,settings): assert agy accepts docker backend and renders enabled buttons"
```

---

### Task 7: Update Focus Ratchet and Visual Baselines

**Files:**
- Modify: `tests/visual/focus.visual.ts:122-133`
- Run: `npm run -s test:visual:docker:update` (or local equivalent)

**Interfaces:**
- Consumes: Playwright visual test suite
- Produces: Updated `FOCUS_COUNT_RATCHET.settings` (193 -> 195) with fifteenth note justification, and updated Settings visual baseline screenshots.

- [ ] **Step 1: Update focus ratchet count and justification comment**

In `tests/visual/focus.visual.ts`:
Add the fifteenth note before `FOCUS_COUNT_RATCHET`:
```typescript
 * Updated a fifteenth time by enabling Docker backend for agy (ENABLE-DOCKER-BACKEND-FOR-AGY):
 * `settings` 193 → 195 — on the Agents page's Sandbox backend panel (`BackendPanel`),
 * the `agy` row previously rendered a single disabled `host` button (`no sandbox yet`);
 * with `docker` enabled as an allowed backend for `agy`, both `host` and `docker` buttons
 * render enabled (`allowed.length === 2`), adding exactly two focusable buttons to the Settings view.
 */
const FOCUS_COUNT_RATCHET: Record<ViewId, number> = {
  dashboard: 49, // fourteenth note: #closeTicket / #reopenTicket
  usage: 13,
  resources: 19, // thirteenth note: the Servers / Resources tab buttons
  serverLogs: 11,
  sidebar: 70, // the all-sections corpus now renders a sub-tree: each row with children adds its subchev collapse control (tenth note)
  diffs: 35,
  settings: 195,
  ticketForm: 28,
  gettingStarted: 6,
};
```

- [ ] **Step 2: Run visual update command**

Run: `npm run -s test:visual:docker:update`
Verify that `tests/visual/__baselines__` screenshots containing the Settings backend panel are re-recorded.

- [ ] **Step 3: Commit**

```bash
git add tests/visual/focus.visual.ts tests/visual/__baselines__/
git commit -m "test(visual): ratchet settings focusable count to 195 and update visual baselines"
```

---

### Task 8: Architecture Documentation

**Files:**
- Modify: `docs/arch/agent-cores.md` (`@arch:AC-26`, `@arch:AC-31`, `@arch:AC-32`, `@arch:AC-33`)

**Interfaces:**
- Consumes: Architectural decisions for Docker backend for agy
- Produces: Updated architecture document sections

- [ ] **Step 1: Update documentation blocks**

In `docs/arch/agent-cores.md`:
1. In `[@arch:AC-26]`: Document that the conversation watch polls either host `appDataDir` or the ticket's container app-data dir (`<bridgeDir>/antigravity/gemini/antigravity-cli`), matching either host `worktree.path` or `CONTAINER_REPO` (`/work/repo`) in `trajectory_metadata_blob`, while keeping `HookPayload.cwd` as the host `worktree.path`. Mention `try/catch` isolation around `workspaceBlob()`, `pendingApprovalCount()`, and `usage()` against `SQLITE_BUSY`.
2. In `[@arch:AC-31]`: Mention `agy` on the `docker` backend (enforcesSandbox adds `--dangerously-skip-permissions`, host launches remain unrelaxed).
3. In `[@arch:AC-32]`: Update `agentBackends` description to state that `agy` supports `host|docker` (reconciling `'agy'` with `'antigravity'` via `backendCoreKey` and `sbxName`).
4. In `[@arch:AC-33]`: Extend the Docker backend description to cover `agy` / `antigravity` alongside `opencode` / `opencode2` (pinned agy 1.4.6, allowlist Google/Antigravity endpoints, `/home/node/.gemini` mount, credential seeding, container binary `agy`).

- [ ] **Step 2: Verify arch doc blocks**

Run: `node scripts/archDocsLint.mjs` (or check format of arch tags)
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add docs/arch/agent-cores.md
git commit -m "docs(arch): document agy on docker backend across AC-26, AC-31, AC-32, AC-33"
```
