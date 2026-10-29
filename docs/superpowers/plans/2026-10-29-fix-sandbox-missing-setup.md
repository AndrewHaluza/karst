# Sandbox missing-setup diagnostics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A sandboxed repo with a lockfile but no `sandbox.setup`, or an unwritable `node_modules`, is named at launch/doctor/setup, and in-sandbox gates print the sandbox hint instead of the main-checkout one.

**Architecture:** (1) New env marker `KARST_SANDBOX=1` on every in-sandbox gate exec (sbx + docker), read by `rebuild-better-sqlite3.mjs` and `archGraph.mjs`. (2) Writability preflight at the start of `runSetup` in `agent/sandboxSetup.ts`. (3) Missing-setup warning: pure finder in `ops/sandboxSetupOp.ts` called from `reattachTicketSandbox`, plus a pure doctor check in `doctor/sandboxChecks.ts`. No auto install, no auto chown.

**Tech Stack:** TypeScript ESM (`.js` import suffix), vitest, node `.mjs` scripts.

**Spec:** ticket T836 brief (D300); `docs/arch/agent-cores.md` blocks `arch:AC-36`, `AC-39`, `AC-40`.

## Global Constraints

- No `spawnSync` on gate/driver paths; host-agnostic modules take injected deps.
- Do NOT auto-run an install; do NOT auto-chown.
- Lockfile set = `package-lock.json`, `pnpm-lock.yaml`, `yarn.lock` (same as AC-40 fingerprint).
- Mutation gate: new `src/extension/**` code needs tests that kill mutants (score >= 85).
- Test naming: no real process/port => plain `*.test.ts`/`*.test.mjs`.
- Conventional commits; files < 400 lines typical.
- Run `npm run -s` scripts; single-file `npx vitest run <file>`; full suite once at the end.

## File Structure

- Modify `src/agent/sbx/sbxRunner.ts` (+ `.test.ts`): export `SANDBOX_ENV`, add to exec args.
- Modify `src/agent/docker/dockerRunner.ts` (+ `.test.ts`): add to `gateEnv`.
- Modify `scripts/rebuild-better-sqlite3.mjs`, `scripts/archGraph.mjs` (+ `archGraph.test.mjs`, `src/agent/rebuildSandboxMessage.integration.test.ts`).
- Modify `src/agent/sandboxSetup.ts` (+ test): writability preflight.
- Modify `src/extension/ops/sandboxSetupOp.ts`, `sandboxTicketOps.ts` (+ tests): missing-setup finder + reattach warning.
- Modify `src/doctor/sandboxChecks.ts`, `src/cli/doctorCommand.ts` (+ tests): doctor finding.
- Modify `docs/arch/agent-cores.md` (AC-40 block): document marker, preflight, warning.

---

### Task 1: Sandbox marker on gate exec + script hints

**Files:**
- Modify: `src/agent/sbx/sbxRunner.ts:68,93,140`; `src/agent/docker/dockerRunner.ts:5,58`
- Modify: `scripts/rebuild-better-sqlite3.mjs:36`; `scripts/archGraph.mjs:30-40`
- Test: `src/agent/sbx/sbxRunner.test.ts`, `src/agent/docker/dockerRunner.test.ts`, `scripts/archGraph.test.mjs`, `src/agent/rebuildSandboxMessage.integration.test.ts`

**Interfaces:**
- Produces: `export const SANDBOX_ENV = 'KARST_SANDBOX'` in `sbxRunner.ts`; value `'1'`. `resolveDepcruiseBin(root, exists, env = process.env)`.

- [ ] **Step 1: Failing tests.** In `sbxRunner.test.ts` find the existing runGate test (grep `'exec'`) and add (adapt the rig helper there):

```ts
it('marks every gate exec as in-sandbox, with or without evidence', async () => {
  // build runner like the neighbouring runGate test, no evidenceDir
  await runner.runGate!('echo', ['hi'], '/wt');
  expect(calls[0]).toEqual(['exec', '--env', 'KARST_SANDBOX=1', 'karst-x', '--', 'echo', 'hi']);
});
```
In `dockerRunner.test.ts` runGate test add: the exec args contain `'--env', 'KARST_SANDBOX=1'` both for the `docker exec` path and the one-shot `docker run` path. In `archGraph.test.mjs` add:

```js
it('says dependencies are missing in this sandbox when KARST_SANDBOX is set', () => {
  expect(() => resolveDepcruiseBin('/clone/scripts', () => false, { KARST_SANDBOX: '1' })).toThrow(/sandbox.*sandbox\.setup/s);
});
it('keeps the npm install hint outside a sandbox', () => {
  expect(() => resolveDepcruiseBin('/main/scripts', () => false, {})).toThrow(/run npm install/);
});
```
In `rebuildSandboxMessage.integration.test.ts` add a case using `run({ KARST_SANDBOX: '1' })` expecting the `sandbox.setup` hint (mirror the existing KARST_BRIDGE_DIR case).

- [ ] **Step 2:** `npx vitest run src/agent/sbx/sbxRunner.test.ts src/agent/docker/dockerRunner.test.ts scripts/archGraph.test.mjs` (integration file via `--config vitest.integration.config.ts`). Expected: FAIL.

- [ ] **Step 3: Implement.**
`sbxRunner.ts` next to `EVIDENCE_DIR_ENV`:
```ts
/** Env marker every in-sandbox gate exec carries, so scripts print sandbox-specific hints. */
export const SANDBOX_ENV = 'KARST_SANDBOX';
```
line 93: `const evidenceEnv = ['--env', `${SANDBOX_ENV}=1`, ...(opts.evidenceDir ? ['--env', `${EVIDENCE_DIR_ENV}=${opts.evidenceDir}`] : [])];`
`dockerRunner.ts`: import `SANDBOX_ENV` with `EVIDENCE_DIR_ENV`; `const gateEnv: Record<string, string> = { [SANDBOX_ENV]: '1', ...(opts.evidenceDir ? { [EVIDENCE_DIR_ENV]: opts.evidenceDir } : {}) };`
`rebuild-better-sqlite3.mjs`: `const hint = (process.env.KARST_SANDBOX || process.env.KARST_BRIDGE_DIR)`.
`archGraph.mjs`:
```js
export function resolveDepcruiseBin(root = ROOT, exists = existsSync, env = process.env) {
  ...
      const hint = env.KARST_SANDBOX
        ? 'dependencies are not installed in this sandbox (declare sandbox.setup in the manifest)'
        : 'run npm install';
      throw new Error(`dependency-cruiser is not installed in ${root} or any ancestor — ${hint}`);
```
Keep the existing "not installed in X or any ancestor" text so the existing test still passes.

- [ ] **Step 4:** rerun Step 2 commands plus `npm run -s typecheck`. Expected PASS. Fix any pre-existing exact-args assertions in the sbx/docker tests that now include the marker.

- [ ] **Step 5:** `git add -A && git commit -m "fix(sandbox): mark in-sandbox gate exec with KARST_SANDBOX so scripts print the sandbox hint"`

---

### Task 2: Writability preflight before setup

**Files:**
- Modify: `src/agent/sandboxSetup.ts` (in `runSetup`, after `waitForIdle`, before `writeState(... 'running')`)
- Test: `src/agent/sandboxSetup.test.ts`

**Interfaces:**
- Consumes: `SetupDeps.runGate`, `SetupRequest.cwd`, `writeState`.
- Produces: unwritable `node_modules` => `{ ok:false, reason }` and state `failed`; setup command NOT run.

- [ ] **Step 1: Failing test** (reuse the file's rig; its `runGate` fake gets the `args`):

```ts
it('fails setup naming node_modules and its owner when it is not writable, without running setup', async () => {
  const ran: string[] = [];
  const runGate: GateProcessRunner = async (_c, args) => {
    ran.push(String(args[1]));
    if (String(args[1]).includes('node_modules')) return { kind: 'completed', exitCode: 1, output: 'root', stdout: 'root' };
    return fingerprintOrOk(args); // existing helper in the file, or inline: fingerprint script => HASH
  };
  const r = await ensureSandboxSetup({ runGate, stateFile }, { key: 'k', setup: 'npm ci', cwd: '/wt' });
  expect(r).toEqual({ ok: false, reason: expect.stringContaining('/wt/node_modules is not writable by the sandbox user (owner root)') });
  expect(ran.some((s) => s.includes('npm ci'))).toBe(false);
  expect(JSON.parse(readFileSync(stateFile, 'utf8')).status).toBe('failed');
});
it('runs setup when node_modules is absent or writable', ...); // preflight exit 0 => normal path
```

- [ ] **Step 2:** `npx vitest run src/agent/sandboxSetup.test.ts` — FAIL.

- [ ] **Step 3: Implement** in `sandboxSetup.ts`:

```ts
/** Exit 0 when `node_modules` is absent or writable; else print its owner and exit 1. Never chowns (needs sudo in the agent's clone). */
const WRITABLE_SH = 'if [ ! -e node_modules ] || [ -w node_modules ]; then exit 0; fi; stat -c %U node_modules 2>/dev/null || ls -ld node_modules | awk \'{print $3}\'; exit 1';

async function unwritableNodeModules(deps: SetupDeps, req: SetupRequest): Promise<string | undefined> {
  const out = await deps.runGate('sh', ['-c', WRITABLE_SH], req.cwd, { signal: req.signal });
  if (out.kind !== 'completed' || out.exitCode === 0) return undefined; // a probe that cannot run is not a verdict
  const owner = (out.stdout ?? out.output).trim() || 'unknown';
  return `sandbox dependencies not provisioned: ${req.cwd}/node_modules is not writable by the sandbox user (owner ${owner}); fix its ownership inside the sandbox (e.g. \`sudo chown -R agent:agent node_modules\`), then re-run setup`;
}
```
In `runSetup` after `refused` check:
```ts
const blocked = await unwritableNodeModules(deps, req);
if (blocked) {
  await writeState(deps.stateFile, { fingerprint, status: 'failed', exitCode: null, at: now() });
  return { ok: false, reason: blocked };
}
```

- [ ] **Step 4:** rerun test, PASS. `npx vitest related src/agent/sandboxSetup.ts` all green.

- [ ] **Step 5:** `git commit -am "fix(sandbox): setup fails fast naming an unwritable node_modules and its owner"`

---

### Task 3: Launch/reattach warning for lockfile without setup

**Files:**
- Modify: `src/extension/ops/sandboxSetupOp.ts` (add `reposMissingSetup`), `src/extension/ops/sandboxTicketOps.ts:187-205` (`reattachTicketSandbox`)
- Test: `src/extension/ops/sandboxSetupOp.test.ts`, `src/extension/ops/sandboxTicketOps.test.ts`

**Interfaces:**
- Produces: `export const MISSING_SETUP_HINT = 'sandbox.setup: npm ci'` and
  `export async function reposMissingSetup(deps: Pick<TicketSetupDeps,'manifest'|'worktrees'|'gateProcess'>, ticketId: number): Promise<string[]>` — repo names whose manifest def has no `sandbox.setup` and whose sandbox clone has a lockfile (probe `LOCKFILES_SH` via runGate at the worktree path). Host ticket (no gateProcess) => `[]`.
- Consumes: `LOCKFILES_SH`, `probeOk`.

- [ ] **Step 1: Failing tests** in `sandboxSetupOp.test.ts` (uses `rig`; extend rig so runGate returns exit 0/1 for the `ls package-lock.json` probe via a new `lockfile?: boolean` option):

```ts
describe('reposMissingSetup', () => {
  it('names a repo with a lockfile and no sandbox.setup', async () => {
    const r = rig({ lockfile: true });
    expect(await reposMissingSetup(r.deps, 7)).toEqual(['app']);
  });
  it('is empty when the repo declares setup', async () => {
    const r = rig({ setup: 'npm ci', lockfile: true });
    expect(await reposMissingSetup(r.deps, 7)).toEqual([]);
  });
  it('is empty without a lockfile', async () => {
    const r = rig({ lockfile: false });
    expect(await reposMissingSetup(r.deps, 7)).toEqual([]);
  });
  it('is empty for a host ticket', async () => {
    const r = rig({ lockfile: true, sandboxed: false });
    expect(await reposMissingSetup(r.deps, 7)).toEqual([]);
  });
});
```
In `sandboxTicketOps.test.ts` (find the existing `reattachTicketSandbox` test and its deps rig) add: when a repo has a lockfile and no setup, `notify.warn` is called once with a string containing the repo name and `sandbox.setup: npm ci`; not called otherwise. Warn only when `deps.notify` exists (check whether `TicketSandboxDeps` has one; if not add optional `readonly warn?: (message: string) => void` and bind it where `deps` is built from `input.notify?.warn`).

- [ ] **Step 2:** run both files — FAIL.

- [ ] **Step 3: Implement.** In `sandboxSetupOp.ts` (reuse the manifest lookup used in `ticketCloneReady`):

```ts
export const MISSING_SETUP_HINT = 'sandbox.setup: npm ci';

/** Repos placed in the sandbox that carry a lockfile but declare no `sandbox.setup` (non-blocking; arch:AC-40). */
export async function reposMissingSetup(deps: Pick<TicketSetupDeps, 'manifest' | 'worktrees' | 'gateProcess'>, ticketId: number): Promise<string[]> {
  const manifest = deps.manifest();
  const runGate = deps.gateProcess(ticketId);
  if (!manifest || !runGate) return [];
  const missing: string[] = [];
  for (const wt of deps.worktrees(ticketId)) {
    const [name, def] = Object.entries(manifest.repositories).find(([key, r]) => key === wt.repo || r.repoPath === wt.repo) ?? [];
    if (name && def && !def.sandbox?.setup && (await probeOk(runGate, LOCKFILES_SH, wt.path))) missing.push(name);
  }
  return missing;
}
```
In `reattachTicketSandbox`, after `ctx` resolved:
```ts
const missing = await reposMissingSetup({ manifest: () => manifest, worktrees: (id) => listWorktreesByTicket(store, id), gateProcess: (id) => ticketGateProcess(deps, id) }, ticketId);
if (missing.length > 0) deps.warn?.(`Karst: sandbox repo ${missing.join(', ')} has a lockfile but no sandbox.setup, so its clone has no dependencies. Add \`${MISSING_SETUP_HINT}\` to its manifest entry.`);
```
(wrap probe errors in try/catch -> `deps.debug`; a failed probe must not break reattach.) `reattachTicketSandbox` runs 15 s after every launch/reattach (`scheduleSandboxReattach`), so it covers both.

- [ ] **Step 4:** rerun, PASS; `npm run -s typecheck`.

- [ ] **Step 5:** `git commit -am "feat(sandbox): warn at launch when a lockfile repo has no sandbox.setup"`

---

### Task 4: Doctor finding

**Files:**
- Modify: `src/doctor/sandboxChecks.ts`, `src/cli/doctorCommand.ts` (near `sandboxBackendChecks`, ~line 170)
- Test: `src/doctor/sandboxChecks.test.ts`, doctorCommand test (grep `sandboxBackendChecks` usage in `src/cli/*.test.ts`)

**Interfaces:**
- Produces: `export interface SetupRepoFact { readonly name: string; readonly hasLockfile: boolean; readonly hasSetup: boolean }` and `export function checkSandboxSetupDeclared(selected: readonly ('sbx'|'docker')[], repos: readonly SetupRepoFact[]): DoctorCheck[]` — id `manifest.sandbox-setup.<name>`, area `'manifest'`, status `'warn'`, fix `{tier:'report', summary, nextStep:'add `sandbox.setup: npm ci` (or your package manager\'s frozen install) under the repository in karst.yml'}`. Empty when no sandbox backend is selected.

- [ ] **Step 1: Failing tests** in `sandboxChecks.test.ts`:

```ts
describe('checkSandboxSetupDeclared', () => {
  const repo = (o: Partial<SetupRepoFact> = {}): SetupRepoFact => ({ name: 'app', hasLockfile: true, hasSetup: false, ...o });
  it('warns naming the repo and the suggested setup', () => {
    const [c] = checkSandboxSetupDeclared(['sbx'], [repo()]);
    expect(c).toMatchObject({ id: 'manifest.sandbox-setup.app', area: 'manifest', status: 'warn' });
    expect(c!.detail).toContain('app');
    expect(c!.fix).toMatchObject({ tier: 'report' });
  });
  it.each([[{ hasSetup: true }], [{ hasLockfile: false }]])('is silent for %o', (o) => {
    expect(checkSandboxSetupDeclared(['docker'], [repo(o)])).toEqual([]);
  });
  it('is silent without a sandbox backend', () => {
    expect(checkSandboxSetupDeclared([], [repo()])).toEqual([]);
  });
});
```
Add a doctorCommand-level test following the neighbouring sandbox-backend test: manifest with `agentBackends` selecting sbx, a repo whose `repoPath` temp dir holds `package-lock.json`, no `sandbox` => report has the warn check.

- [ ] **Step 2:** run — FAIL.

- [ ] **Step 3: Implement** the pure function in `sandboxChecks.ts`, then in `doctorCommand.ts` add

```ts
function sandboxSetupChecks(area: DoctorArea, manifest: Manifest | undefined): DoctorCheck[] {
  const selected = selectedSandboxBackends(manifest?.agentBackends);
  if (!manifest || selected.length === 0) return [];
  const repos = Object.entries(manifest.repositories).map(([name, r]) => ({
    name, hasSetup: Boolean(r.sandbox?.setup),
    hasLockfile: ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock'].some((f) => existsSync(join(r.repoPath, f))),
  }));
  return checkSandboxSetupDeclared(selected, repos).filter((c) => c.area === area);
}
```
and call it from the `areas.includes('manifest')` branch of `collector` (add `existsSync`/`join` imports if absent). Doctor reads the host repo (the lockfile is committed, so it matches the clone).

- [ ] **Step 4:** rerun, PASS; `npx vitest related src/doctor/sandboxChecks.ts src/cli/doctorCommand.ts`.

- [ ] **Step 5:** `git commit -am "feat(doctor): warn when a sandboxed repo has a lockfile but no sandbox.setup"`

---

### Task 5: Docs, gates, mutation

**Files:** Modify `docs/arch/agent-cores.md` (AC-40 block, keep keyed format)

- [ ] **Step 1:** Extract block: `awk -v id="[@arch:AC-40]" 'index($0,"## " id)==1{p=1} p{print} index($0,"END_DOC_BLOCK: " id)==1{exit}' docs/arch/agent-cores.md`. Append one bullet before `END_DOC_BLOCK`: gates exec with `KARST_SANDBOX=1` (sbx `--env`, docker `--env`); `runSetup` preflight fails on an unwritable `node_modules` naming path+owner, never chowns; launch/reattach warns and `doctor` (`manifest.sandbox-setup.<repo>`) reports a lockfile repo without `sandbox.setup`, never auto-installs.
- [ ] **Step 2:** `npm run -s docs:graph` (regenerates system-map if imports changed), `npm run -s typecheck`, `npm run -s lint:react`.
- [ ] **Step 3:** `npx stryker run --mutate src/extension/ops/sandboxSetupOp.ts,src/extension/ops/sandboxTicketOps.ts` then `node scripts/mutationSummary.mjs | head -40`. Add tests for survivors in the new code (score >= 85).
- [ ] **Step 4:** Full suite once: `npm run -s test:unit 2>&1 | tail -15` and `npm run -s test:integration 2>&1 | tail -15`.
- [ ] **Step 5:** `git commit -am "docs(arch): AC-40 sandbox marker, writability preflight, missing-setup warning"`

---

## Self-Review

- Decision 1 (warning + doctor, no auto install): Tasks 3, 4. Decision 2 (preflight, no chown): Task 2. Decision 3 (marker sbx + docker, archGraph hint): Task 1. Decision 4 (tests): in each task; archGraph in existing `archGraph.test.mjs`.
- Names consistent: `SANDBOX_ENV`, `reposMissingSetup`, `MISSING_SETUP_HINT`, `checkSandboxSetupDeclared`, `SetupRepoFact`.
- Known judgment call: preflight runs only when setup would actually run (inside `runSetup`), so an already-`ok` fingerprint never fails on a later ownership change.
- Open check for implementer: Task 3 needs `TicketSandboxDeps.warn`; bind it to `input.notify?.warn` where deps are built.
