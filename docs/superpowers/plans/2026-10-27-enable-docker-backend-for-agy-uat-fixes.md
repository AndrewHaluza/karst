# Fix UAT Failures for ENABLE-DOCKER-BACKEND-FOR-AGY Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resolve the 9 failing unit tests and the stale docs index gate on branch `karst/feat/enable-docker-backend-for-agy-enable-docker-backend-for-agy` so all UAT gates (unit, docs, docs-graph, integration, visual, layout) pass.

**Architecture:** The 8 feature commits introduced Docker backend support for `antigravity`/`agy`, which correctly expanded `DOCKER_CORES` and wired container app-data polling and `bridgeDir`. However, pre-existing unit tests and guards had assumptions that `agy` or `antigravity` are purely host cores or non-docker cores. Specifically:
1. `src/agent/sandboxInventory.test.ts`: Replaces `claude` with `agy` in an "unknown core" negative test; now that `agy` is a known Docker core, the test needs to test a truly unknown core (e.g. `'unknown'` or `'other'`).
2. `src/agent/docker/dockerNames.test.ts`: Guards against non-docker cores and tested `it.each(['null', 'antigravity', 'claude', 'codex'])`; now that `antigravity` is in `DOCKER_CORES`, `antigravity` is valid and should be removed from that negative test list.
3. `src/agent/docker/resolveDocker.test.ts`: Asserted `resolveDocker` refuses `claude`, `codex`, and `antigravity`; now `antigravity` and `agy` are valid docker cores and should be prepared and returned (or handled as supported docker runners), not rejected as unsupported.
4. `src/extension/ops/sandboxDiffOp.test.ts`: Used `core: 'antigravity'` expecting "K-7 has no sandbox (core antigravity)"; but `antigravity` is now a Docker core, triggering Docker runner creation without mock docker image/process. The test should use a true non-sandbox core (e.g. `core: 'none'`).
5. `src/extension/ops/sandboxLifecycleOps.test.ts`: Tested that `backendKindOf('agy')` is `'host'`, `stopSandboxOp` does nothing for `core: 'agy'`, and `reconcileSandboxes` ignores `agy`; now that `agy` is in `DOCKER_CORES`, `backendKindOf('agy')` is `'docker'`. The tests must be updated to reflect that `agy`/`antigravity` are Docker cores and use a non-docker/non-sbx core for the host test.
6. `src/extension/ops/sandboxWiring.test.ts`: Tested host ticket detachment with `setSessionId(..., 'antigravity')` expecting no sandbox listing; now that `antigravity` is a docker core, `backendKindOf('antigravity')` is `'docker'`, so session close checks the sandbox listing unless recorded as host placement (`recordPlacement(store, a, { kind: 'host' }, 'antigravity')`).
7. `src/extension/ops/ratchet.test.ts`: `src/extension.ts` grew by 1 line (from 8769 to 8770) due to wiring `sandboxAppDataDir`. The ratchet ceiling needs to be raised by 1 line with its explanatory comment.
8. `docs/INDEX.md`: `npm run -s docs:index` updates the index title of `[@arch:AC-33]` to match `docs/arch/agent-cores.md`.

**Tech Stack:** TypeScript, Docker session runner, Vitest, Node.js.

**Spec:** Ticket ENABLE-DOCKER-BACKEND-FOR-AGY (T815, P29 / D250); `@arch:AC-26`, `@arch:AC-31`, `@arch:AC-32`, `@arch:AC-33`.

## Global Constraints

- Never use `sbx` for `agy`: only `docker` backend is supported for `agy` / `antigravity`.
- `sbxName` canonicalizes `agy -> antigravity` for docker container/network/volume names.
- All unit tests must pass with `npm run test:unit`.
- All docs checks must pass with `npm run -s docs:check`.
- Stryker mutation score on modified files under `src/extension/**` must remain >= 85.

---

### Task 1: Update `sandboxInventory.test.ts` and `dockerNames.test.ts` for Known Docker Cores

**Files:**
- Modify: `src/agent/sandboxInventory.test.ts:18`
- Modify: `src/agent/docker/dockerNames.test.ts:24-26`

**Interfaces:**
- Consumes: `DOCKER_CORES` containing `'opencode' | 'opencode2' | 'antigravity' | 'agy'`
- Produces: Passing unit tests for `sandboxInventory` and `dockerNames`

- [ ] **Step 1: Update `sandboxInventory.test.ts`**

In `src/agent/sandboxInventory.test.ts`:
Change line 18 from:
```typescript
    expect(parseSandboxName(own(7, 'claude').replace(/claude$/, 'agy'), ROOT)).toBeUndefined();
```
to:
```typescript
    expect(parseSandboxName(own(7, 'claude').replace(/claude$/, 'unknown'), ROOT)).toBeUndefined();
```

- [ ] **Step 2: Update `dockerNames.test.ts`**

In `src/agent/docker/dockerNames.test.ts`:
Line 24 tests non-docker cores rejecting in `dockerNames`:
```typescript
describe('dockerNames core guard (F6)', () => {
  it.each(['null', 'claude', 'codex'])('rejects the non-docker core %s', (core) => {
    expect(() => dockerNames({ projectRoot: '/p', ticketId: 7, core })).toThrow(/not a docker core/);
  });
  it.each(['opencode', 'opencode2', 'antigravity', 'agy'])('accepts the docker core %s', (core) => {
    expect(() => dockerNames({ projectRoot: '/p', ticketId: 7, core })).not.toThrow();
  });
});
```

- [ ] **Step 3: Run tests to verify they pass**

Run: `npm run test:unit -- src/agent/sandboxInventory.test.ts src/agent/docker/dockerNames.test.ts`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/agent/sandboxInventory.test.ts src/agent/docker/dockerNames.test.ts
git commit -m "test(sandbox): update sandboxInventory and dockerNames tests for antigravity/agy docker cores"
```

---

### Task 2: Update `resolveDocker.test.ts`

**Files:**
- Modify: `src/agent/docker/resolveDocker.test.ts:10-25`

**Interfaces:**
- Consumes: `resolveDocker(input: DockerResolveInput)`
- Produces: Prepared docker session runner for `antigravity` and `agy`

- [ ] **Step 1: Inspect `resolveDocker.test.ts`**

In `src/agent/docker/resolveDocker.test.ts`:
Line 11 currently checks:
```typescript
  it.each(['opencode', 'opencode2'])('prepares and returns an enforcing docker runner for %s', async (core) => {
```
and line 20 checks:
```typescript
  it.each(['claude', 'codex', 'antigravity'])('refuses %s (agy deferred, claude/codex are sbx)', async (core) => {
```

Update line 11 to include `'antigravity'` and `'agy'`:
```typescript
  it.each(['opencode', 'opencode2', 'antigravity', 'agy'])('prepares and returns an enforcing docker runner for %s', async (core) => {
```
And line 20 to only test `'claude'` and `'codex'`:
```typescript
  it.each(['claude', 'codex'])('refuses %s (claude/codex are sbx)', async (core) => {
```
Also verify what container name is expected:
For `core === 'agy'`, `sbxName` canonicalizes it to `karst-<hash8>-7-antigravity`.
Adjust the regex in line 17:
```typescript
    const expectedCore = core === 'agy' ? 'antigravity' : core;
    expect(out.names.container).toMatch(new RegExp(`^karst-[0-9a-f]{8}-7-${expectedCore}$`));
```

- [ ] **Step 2: Run test to verify it passes**

Run: `npm run test:unit -- src/agent/docker/resolveDocker.test.ts`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/agent/docker/resolveDocker.test.ts
git commit -m "test(docker): assert resolveDocker prepares runner for antigravity and agy"
```

---

### Task 3: Update `sandboxDiffOp.test.ts` and `sandboxLifecycleOps.test.ts`

**Files:**
- Modify: `src/extension/ops/sandboxDiffOp.test.ts:46-48`
- Modify: `src/extension/ops/sandboxLifecycleOps.test.ts:56-63, 162-168, 200-214`

**Interfaces:**
- Consumes: `backendKindOf(core: string | null): BackendKind`
- Produces: Passing unit tests for diff and lifecycle ops

- [ ] **Step 1: Update `sandboxDiffOp.test.ts`**

In `src/extension/ops/sandboxDiffOp.test.ts`:
Line 46 used `core: 'antigravity'` as an example of a non-sandbox core. Now `antigravity` is a sandbox core (`docker`).
Update it to use a true non-sandbox core (e.g. `'none'`):
```typescript
    const b = setup();
    await expect(diffSandboxOp(b.deps, { ...target, core: 'none' })).resolves.toBe(false);
    expect(b.errors).toEqual(['Karst: K-7 has no sandbox (core none).']);
    expect(a.proc.calls.length + b.proc.calls.length).toBe(0);
```

- [ ] **Step 2: Update `sandboxLifecycleOps.test.ts`**

In `src/extension/ops/sandboxLifecycleOps.test.ts`:
1. In `describe('backendKindOf')`:
```typescript
  it('maps cores to runners', () => {
    expect(backendKindOf('claude')).toBe('sbx');
    expect(backendKindOf('codex')).toBe('sbx');
    expect(backendKindOf('opencode2')).toBe('docker');
    expect(backendKindOf('antigravity')).toBe('docker');
    expect(backendKindOf('agy')).toBe('docker');
    expect(backendKindOf('none')).toBe('host');
    expect(backendKindOf(null)).toBe('host');
  });
```
2. In `describe('stopSandboxOp')`:
```typescript
  it('non-owner and host core do nothing', async () => {
    const { d, proc } = deps({ owns: () => false });
    await expect(stopSandboxOp(d, target)).resolves.toBe(false);
    const host = deps();
    await expect(stopSandboxOp(host.d, { ...target, core: 'none' })).resolves.toBe(false);
    expect([...proc.calls, ...host.proc.calls]).toEqual([]);
  });
```
3. In `describe('reconcileSandboxes')`:
`live` array has `{ id: 11, sessionId: 's11', sessionProvider: 'agy' }`.
Previously `agy` was considered a host core, so `reconcileSandboxes` skipped it and didn't expect a sandbox. Now that `agy` is a docker core, ticket 11 has a live session with a sandbox core and no sandbox listed, so ticket 11 is reported in `missing: [9, 11]`.
Update the expectation in line 212:
```typescript
    expect(r).toEqual({ running: [7], stopped: [8], missing: [9, 11], orphans: [box(42)] });
    expect(clear.mock.calls).toEqual([[9], [11]]);
```

- [ ] **Step 3: Run tests to verify they pass**

Run: `npm run test:unit -- src/extension/ops/sandboxDiffOp.test.ts src/extension/ops/sandboxLifecycleOps.test.ts`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/extension/ops/sandboxDiffOp.test.ts src/extension/ops/sandboxLifecycleOps.test.ts
git commit -m "test(lifecycle): align diff and lifecycle tests with antigravity/agy docker backend"
```

---

### Task 4: Fix `sandboxWiring.test.ts` Session Close Host Detach Test

**Files:**
- Modify: `src/extension/ops/sandboxWiring.test.ts:347-361`

**Interfaces:**
- Consumes: `onSessionClosed(ticketId: number)`
- Produces: Passing test for host ticket detachment

- [ ] **Step 1: Inspect `sandboxWiring.test.ts`**

In `src/extension/ops/sandboxWiring.test.ts`:
Line 347:
```typescript
  it('a host ticket detaches without listing any sandbox', async () => {
    const projectId = upsertProject(store, { slug: 'p' }).id;
    const a = createTicket(store, { key: 'H-1', title: 'a', projectId }).id;
    setSessionId(store, a, 's', 'antigravity');
    const detach = vi.fn(async () => {});
    const proc = fakeSbxProcess();
    const { w } = wiring({
      backendOn: () => true, projectRoot: () => ROOT, projectId: () => projectId, owned: new Set([a]),
      proc, dockerProc: Object.assign(fakeSbxProcess(), { pipe: vi.fn() }),
      bridges: () => ({ dispose: vi.fn(async () => {}), detach, markerStatus: vi.fn(() => undefined) }),
    });
    await w.onSessionClosed(a);
    expect(detach).toHaveBeenCalledWith(a);
    expect(proc.calls).toEqual([]);
  });
```
When `sessionProvider` is `'antigravity'`, `backendKindOf('antigravity')` is now `'docker'`, not `'host'`.
If the ticket is placed on `'host'` (either via `recordPlacement(store, a, { kind: 'host' }, 'antigravity')` or because its provider is a non-sandbox core like `'unsupported'`), it is a host ticket and detaches without running `sbx ls` or `docker ps`.
Record host placement:
```typescript
    recordPlacement(store, a, { kind: 'host' }, 'antigravity');
```

- [ ] **Step 2: Run test to verify it passes**

Run: `npm run test:unit -- src/extension/ops/sandboxWiring.test.ts`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/extension/ops/sandboxWiring.test.ts
git commit -m "test(wiring): record host placement in sandboxWiring host session close test"
```

---

### Task 5: Ratchet `MAX_EXTENSION_LINES` and Update `docs/INDEX.md`

**Files:**
- Modify: `src/extension/ops/ratchet.test.ts:93-94`
- Modify: `docs/INDEX.md:73`

**Interfaces:**
- Consumes: `extension.ts` (8770 lines), `docsKeys.mjs index`
- Produces: Passing `ratchet.test.ts` and `npm run -s docs:check`

- [ ] **Step 1: Update `src/extension/ops/ratchet.test.ts`**

Update `MAX_EXTENSION_LINES` from `8769` to `8770` with justification comment:
```typescript
// Raised by 1 (8769 -> 8770): agy sandbox appDataDir resolution in createAgyWatchLoop (ENABLE-DOCKER-BACKEND-FOR-AGY).
const MAX_EXTENSION_LINES = 8770;
```

- [ ] **Step 2: Update `docs/INDEX.md`**

In `docs/INDEX.md` line 73:
```markdown
[@arch:AC-33] docs/arch/agent-cores.md — Docker backend for opencode, opencode2, and agy
```
Run: `npm run -s docs:check`
Expected: PASS

- [ ] **Step 3: Run full unit test suite and ratchet test**

Run: `npm run test:unit -- src/extension/ops/ratchet.test.ts`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/extension/ops/ratchet.test.ts docs/INDEX.md
git commit -m "chore: ratchet MAX_EXTENSION_LINES to 8770 and update docs index"
```

---

### Task 6: Full Verification of All UAT Gates

**Files:** None (verification step)

- [ ] **Step 1: Run unit test suite**

Run: `npm run test:unit`
Expected: PASS (all tests pass, 0 failed).

- [ ] **Step 2: Run docs check**

Run: `npm run -s docs:check`
Expected: PASS.

- [ ] **Step 3: Run typecheck**

Run: `npm run -s typecheck`
Expected: PASS.

- [ ] **Step 4: Check git status**

Ensure clean working tree and review `git log origin/develop..HEAD`.
