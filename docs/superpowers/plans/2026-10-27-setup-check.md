# `karst setup check` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the ticketless verb `karst setup check [--repos a,b]` that dry-runs everything a first ticket needs and prints a per-item `{ok,warn,fail}` list with fix hints; the setup prompt requires it as exit step.

**Architecture:** Pure check functions in `src/setup/readiness/` take an injected `ReadinessProbes` (host-agnostic, fakeable). A thin `src/cli/setupCheck.ts` parses args, builds real probes (`nodeProbes.ts`, async git via `execFile`, never `spawnSync`), runs, returns JSON `{ok, items}`. `main.ts` routes `setup check` as an async verb next to `setup verify`. Reuses D269 (`loadManifestWithDiagnostics` warnings, all counted as fail), D230 (`deriveNpmScript` + `baseDefinesScript` from `workflow/gates/npmScript.ts`), doctor/deps (`agentDependency`, `dependencyState`), and `setup verify` for services.

**Tech Stack:** TypeScript ESM (`.js` import suffix, `noUncheckedIndexedAccess`), vitest, node `child_process.execFile`.

**Spec:** ticket prompt (D272) + `docs/arch/cli.md` `[@arch:CLI-14]`.

## Global Constraints

- Ticketless like `setup verify`: needs `--manifest`, never opens a store for the checks (only services step needs `--db`; if absent it is reported `warn`/not run).
- No `spawnSync` on new paths; every git call async with a timeout. `git ls-remote` timeout 10 s, `GIT_TERMINAL_PROMPT=0`.
- Every D269 warning is a FAIL here. Overall `ok` = no item with status `fail`.
- Disabled repos (`enabled === false`) skipped.
- Mutation gate ≥ 85 for `src/setup/**`/`src/cli/**` changes; never add `mutate` excludes. Test naming: any test spawning real git is `*.integration.test.ts`.
- Strict TDD, conventional commits, files < 400 lines.
- Item ids are stable strings: `manifest.load`, `manifest.warning.N`, `repo.git.<name>`, `repo.baseline.<name>`, `repo.origin.<name>`, `repo.remote.<name>`, `repo.worktree.<name>`, `gates.review`, `gates.uat`, `gates.script.<where>`, `uat.tester`, `services`, `core.<provider>`.

## File Structure

- Create `src/setup/readiness/types.ts` — `ReadinessItem`, `ReadinessProbes`.
- Create `src/setup/readiness/repoChecks.ts` (+test) — items 2, 3.
- Create `src/setup/readiness/gateChecks.ts` (+test) — items 4, 5.
- Create `src/setup/readiness/runReadiness.ts` (+test) — orchestration, items 1, 6, 7, summary.
- Create `src/setup/readiness/nodeProbes.ts` (+`nodeProbes.integration.test.ts`) — real probes.
- Create `src/cli/setupCheck.ts` (+test) — arg parse + command.
- Modify `src/cli/main.ts` (route, `exitsAfterFlush` not needed: no detached children), `src/cli/registry.ts` (enum `check`), `src/setup/instructions.ts` (step 8), `src/cli/guide.ts`, `docs/arch/cli.md` (CLAUDE.md: edit CLI-14 block, keep format, add `setupCheck.ts#runSetupCheckCommand` to `covers:`), `docs/arch/system-map.md` via `npm run -s docs:graph`.

---

### Task 1: Types + per-repo checks (item 2, item 3)

**Files:** Create `src/setup/readiness/types.ts`, `repoChecks.ts`, `repoChecks.test.ts`.

**Interfaces:**
- Produces (types.ts):
```ts
export type ReadinessStatus = 'ok' | 'warn' | 'fail';
export interface ReadinessItem { id: string; status: ReadinessStatus; detail: string; fix?: string }
export interface WorktreeTrial { ok: boolean; error?: string }
export interface ReadinessProbes {
  isGitRepo(path: string): boolean;
  branchExists(repoPath: string, branch: string): boolean;
  hasRemote(repoPath: string, remote: string): boolean;
  remoteReachable(repoPath: string): Promise<boolean>;
  /** add detached worktree at baseline under <repo>/.karst/worktrees, remove it, verify removal */
  worktreeTrial(repoPath: string, branch: string): Promise<WorktreeTrial>;
  fileExists(repoPath: string, rel: string): boolean;
  baseDefinesScript(repoPath: string, branch: string, script: string): Promise<boolean>;
  binaryResolves(command: string): boolean;
  coreState(provider: string): 'ok' | 'missing' | 'not-ready';
}
```
- Produces (repoChecks.ts): `checkRepo(name: string, repo: RepositoryDef, baseline: string, p: ReadinessProbes): Promise<ReadinessItem[]>`

- [ ] **Step 1: Write failing test** `repoChecks.test.ts`
```ts
import { describe, it, expect } from 'vitest';
import { checkRepo } from './repoChecks.js';
import type { ReadinessProbes } from './types.js';
import type { RepositoryDef } from '../../manifest/types.js';

const repo: RepositoryDef = { repoPath: '/w/web', hasMigrations: false };
function probes(over: Partial<ReadinessProbes> = {}): ReadinessProbes {
  return {
    isGitRepo: () => true, branchExists: () => true, hasRemote: () => true,
    remoteReachable: async () => true, worktreeTrial: async () => ({ ok: true }),
    fileExists: () => true, baseDefinesScript: async () => true,
    binaryResolves: () => true, coreState: () => 'ok', ...over,
  };
}
const status = (items: { id: string; status: string }[], id: string) => items.find((i) => i.id === id)?.status;

describe('checkRepo', () => {
  it('all ok', async () => {
    const items = await checkRepo('web', repo, 'main', probes());
    expect(items.map((i) => i.status)).toEqual(['ok', 'ok', 'ok', 'ok', 'ok']);
    expect(items.map((i) => i.id)).toEqual(['repo.git.web', 'repo.baseline.web', 'repo.origin.web', 'repo.remote.web', 'repo.worktree.web']);
  });
  it('not a git repo stops further checks for that repo', async () => {
    const items = await checkRepo('web', repo, 'main', probes({ isGitRepo: () => false }));
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ id: 'repo.git.web', status: 'fail' });
    expect(items[0]!.fix).toMatch(/git init/);
  });
  it('missing baseline fails and skips the worktree trial', async () => {
    const items = await checkRepo('web', repo, 'main', probes({ branchExists: () => false }));
    expect(status(items, 'repo.baseline.web')).toBe('fail');
    expect(status(items, 'repo.worktree.web')).toBeUndefined();
  });
  it('no origin fails and skips reachability', async () => {
    const items = await checkRepo('web', repo, 'main', probes({ hasRemote: () => false }));
    expect(status(items, 'repo.origin.web')).toBe('fail');
    expect(status(items, 'repo.remote.web')).toBeUndefined();
  });
  it('unreachable remote fails', async () => {
    const items = await checkRepo('web', repo, 'main', probes({ remoteReachable: async () => false }));
    expect(status(items, 'repo.remote.web')).toBe('fail');
  });
  it('worktree trial failure carries the error', async () => {
    const items = await checkRepo('web', repo, 'main', probes({ worktreeTrial: async () => ({ ok: false, error: 'boom' }) }));
    const w = items.find((i) => i.id === 'repo.worktree.web')!;
    expect(w.status).toBe('fail');
    expect(w.detail).toContain('boom');
  });
});
```
- [ ] **Step 2:** `npx vitest run src/setup/readiness/repoChecks.test.ts` → FAIL (module missing).
- [ ] **Step 3: Implement** `types.ts` (above) and `repoChecks.ts`:
```ts
import type { RepositoryDef } from '../../manifest/types.js';
import type { ReadinessItem, ReadinessProbes } from './types.js';

const ok = (id: string, detail: string): ReadinessItem => ({ id, status: 'ok', detail });
const fail = (id: string, detail: string, fix: string): ReadinessItem => ({ id, status: 'fail', detail, fix });

/** Items 2 and 3: git repo, baseline, origin, reachability, worktree round trip. Each gate stops the ones that depend on it. */
export async function checkRepo(
  name: string, repo: RepositoryDef, baseline: string, p: ReadinessProbes,
): Promise<ReadinessItem[]> {
  const path = repo.repoPath;
  if (!p.isGitRepo(path)) {
    return [fail(`repo.git.${name}`, `${path} is not a git repo`, `propose: git -C ${path} init -b ${baseline} && an initial commit (karst setup propose-change)`)];
  }
  const out: ReadinessItem[] = [ok(`repo.git.${name}`, `${path} is a git repo`)];
  if (!p.branchExists(path, baseline)) {
    out.push(fail(`repo.baseline.${name}`, `baseline branch '${baseline}' not found in ${path}`, `create it (git -C ${path} branch ${baseline} <commit>) or set baselineBranch`));
    return out;
  }
  out.push(ok(`repo.baseline.${name}`, `baseline branch '${baseline}' resolves`));
  if (!p.hasRemote(path, 'origin')) {
    out.push(fail(`repo.origin.${name}`, `no 'origin' remote in ${path}`, `git -C ${path} remote add origin <url> (ship push needs it)`));
  } else {
    out.push(ok(`repo.origin.${name}`, "'origin' remote exists"));
    out.push((await p.remoteReachable(path))
      ? ok(`repo.remote.${name}`, 'origin is reachable')
      : fail(`repo.remote.${name}`, 'git ls-remote origin failed or timed out', 'check the URL, network and credentials for origin'));
  }
  const trial = await p.worktreeTrial(path, baseline);
  out.push(trial.ok
    ? ok(`repo.worktree.${name}`, 'a worktree from the baseline can be created and removed')
    : fail(`repo.worktree.${name}`, `worktree trial failed: ${trial.error ?? 'unknown'}`, `run: git -C ${path} worktree prune; free disk space or fix permissions under ${path}/.karst/worktrees`));
  return out;
}
```
Test 'all ok' expects 5 items with origin present: matches. In the "no origin" case the worktree trial still runs (baseline local) — test only checks remote absent.
- [ ] **Step 4:** rerun the test → PASS.
- [ ] **Step 5:** `git add src/setup/readiness && git commit -m "feat(setup): readiness types and per-repo checks"`

### Task 2: Gate + UAT checks (items 4, 5)

**Files:** Create `gateChecks.ts`, `gateChecks.test.ts`.

**Interfaces:**
- Consumes: `ReadinessProbes`, `deriveNpmScript(command, args)` from `../../workflow/gates/npmScript.js`, `Manifest`/`GateDef` from manifest types (`GateDef` has `command`, optional `repo`; `manifest.review.{gates,requireIndependentSignal,repositories}`, `manifest.uat.{gates,testerVerifier,repositories}`).
- Produces: `checkGates(m: Manifest, baselineOf: (repoName: string) => string, p: ReadinessProbes): Promise<ReadinessItem[]>`

Behavior:
1. `gates.review`: effective gates = `review.gates ∪ review.repositories.*.gates`. If `review.requireIndependentSignal` and none declared and no enabled repo has `package.json` (probe `fileExists`) → fail (fix: declare review.gates). Otherwise ok.
2. `gates.uat`: if `uat` declared with zero gates (all levels) and no `testerVerifier` → `warn` "uat declares nothing to run". Absent `uat` → no item.
3. For each gate (review + uat, every level), split `command` on whitespace → `deriveNpmScript(first, rest)`; if a script, for each target repo (`g.repo` or all enabled) require `p.baseDefinesScript(repoPath, baseline, script)`; miss → `fail` id `gates.script.<where>[i]` fix `add "<script>" to package.json scripts on <baseline>`.
4. `uat.tester`: for `uat.testerVerifier` (single gate): command first token — relative path (contains `/`, not absolute) → `fileExists(repoPath, token)` in its `repo`; otherwise `binaryResolves(token)`; miss → fail `uat.tester`.

- [ ] **Step 1: Failing tests** (`gateChecks.test.ts`), reuse the `probes()` helper (copy it; tests must be self-contained):
```ts
import { describe, it, expect } from 'vitest';
import { checkGates } from './gateChecks.js';
import type { ReadinessProbes } from './types.js';
import type { Manifest } from '../../manifest/types.js';

function probes(over: Partial<ReadinessProbes> = {}): ReadinessProbes {
  return {
    isGitRepo: () => true, branchExists: () => true, hasRemote: () => true,
    remoteReachable: async () => true, worktreeTrial: async () => ({ ok: true }),
    fileExists: () => true, baseDefinesScript: async () => true,
    binaryResolves: () => true, coreState: () => 'ok', ...over,
  };
}
const base = (extra: Partial<Manifest>): Manifest => ({
  host: '127.0.0.1', portRange: [3000, 3999], baselineBranch: 'main',
  repositories: { web: { repoPath: '/w/web', hasMigrations: false } }, ...extra,
} as Manifest);
const main = () => 'main';
const ids = (items: { id: string; status: string }[]) => items.map((i) => `${i.id}:${i.status}`);

describe('checkGates', () => {
  it('review without gates and without package.json fails', async () => {
    const m = base({ review: { gates: [], repositories: {}, requireIndependentSignal: true } as never });
    const items = await checkGates(m, main, probes({ fileExists: () => false }));
    expect(ids(items)).toContain('gates.review:fail');
  });
  it('review without gates but with package.json is ok', async () => {
    const m = base({ review: { gates: [], repositories: {}, requireIndependentSignal: true } as never });
    expect(ids(await checkGates(m, main, probes()))).toContain('gates.review:ok');
  });
  it('npm script missing on baseline fails, present passes', async () => {
    const m = base({ review: { gates: [{ name: 't', command: 'npm run test' }], repositories: {}, requireIndependentSignal: true } as never });
    const bad = await checkGates(m, main, probes({ baseDefinesScript: async () => false }));
    expect(bad.find((i) => i.id.startsWith('gates.script.'))).toMatchObject({ status: 'fail' });
    expect(bad.find((i) => i.id.startsWith('gates.script.'))!.fix).toContain('"test"');
    const good = await checkGates(m, main, probes());
    expect(good.some((i) => i.id.startsWith('gates.script.') && i.status === 'fail')).toBe(false);
  });
  it('non-npm gate commands are not script-checked', async () => {
    const m = base({ review: { gates: [{ name: 'x', command: 'make test' }], repositories: {}, requireIndependentSignal: false } as never });
    const items = await checkGates(m, main, probes({ baseDefinesScript: async () => false }));
    expect(items.some((i) => i.id.startsWith('gates.script.'))).toBe(false);
  });
  it('uat declared but empty warns', async () => {
    const m = base({ uat: { gates: [], repositories: {} } as never });
    expect(ids(await checkGates(m, main, probes()))).toContain('gates.uat:warn');
  });
  it('tester command: relative path must exist, bare binary must resolve', async () => {
    const rel = base({ uat: { gates: [], repositories: {}, testerVerifier: { name: 'tv', command: 'scripts/tv.sh', repo: 'web' } } as never });
    expect(ids(await checkGates(rel, main, probes({ fileExists: () => false })))).toContain('uat.tester:fail');
    const bin = base({ uat: { gates: [], repositories: {}, testerVerifier: { name: 'tv', command: 'playwright test', repo: 'web' } } as never });
    expect(ids(await checkGates(bin, main, probes({ binaryResolves: () => false })))).toContain('uat.tester:fail');
    expect(ids(await checkGates(bin, main, probes()))).toContain('uat.tester:ok');
  });
});
```
Before writing, confirm exact field names in `src/manifest/types.ts` (`GateDef`, `review`, `uat`, `testerVerifier`) and adjust the `as never` casts to proper literals where they differ.
- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3: Implement** `gateChecks.ts` per Behavior above (collect gates as `{where, gate}` list: `review.gates`, `review.repositories.<k>.gates`, `uat.gates`, `uat.repositories.<k>.gates`; helper `targets(m, g)` = enabled repos filtered by `g.repo` case-insensitively; `splitCommand = (c) => { const [a='', ...r] = c.trim().split(/\s+/); return [a, r] as const }`).
- [ ] **Step 4:** run → PASS.
- [ ] **Step 5:** commit `feat(setup): readiness gate and UAT checks`.

### Task 3: Orchestrator (items 1, 6, 7)

**Files:** Create `runReadiness.ts`, `runReadiness.test.ts`.

**Interfaces:**
- Consumes: `checkRepo`, `checkGates`, `ReadinessProbes`, `loadManifestWithDiagnostics` result shape `{manifest, warnings}`, `resolveBaselineBranch(manifest, repo)` from `../../manifest/baselineBranch.js`.
- Produces:
```ts
export interface ReadinessInput {
  manifest: Manifest | undefined;
  loadError?: string;
  /** D269 warnings from the loader; every one is a fail here */
  warnings: readonly string[];
  repos: readonly string[];            // --repos filter, [] = all
  probes: ReadinessProbes;
  /** runs `setup verify` for the selected services; undefined = no store available */
  verifyServices?: (repos: readonly string[]) => Promise<{ ok: boolean; error?: string; failed: string[] }>;
}
export interface ReadinessReport { ok: boolean; items: ReadinessItem[] }
export function coresUsed(m: Manifest): string[];
export async function runReadiness(i: ReadinessInput): Promise<ReadinessReport>;
```
Behavior: load error → single `manifest.load` fail (stop). Else `manifest.load` ok + one `manifest.warning.N` fail per warning (fix: "follow the fix named in the detail"). Then per enabled repo (filtered by `--repos`, unknown name → `repos.filter` fail item `repo.unknown.<n>`) `checkRepo`; then `checkGates`. Services: if no enabled repo has `service` → ok "no services declared"; else if `verifyServices` undefined → `warn` "services declared but setup verify not run (no --db)"; else run it → ok / fail (fix `fix the failing service then rerun karst setup verify`). Cores: for each of `coresUsed(m)`, `coreState(provider)`: `ok`→ok, else fail with `agentDependency(provider).install`. `ok` = no fail.

`coresUsed`: union of `m.agentProvider`, every `m.processes[role].provider` (when present), every preset slot provider — read `src/manifest/types.ts` ~line 801 and `src/agent/agentPresets.ts` to get exact property names, default `'claude'` when none.

- [ ] **Step 1: Failing tests** — cases: load error → one fail item and `ok:false`; warnings each become fail (`manifest.warning.0`); `--repos web` filters; unknown repo name fails; no services → ok; services + no verifier → warn and report still `ok:true`; verifier fail → `services:fail`; core missing → `core.claude:fail` with install text; all-green fixture → `ok:true`. Use the same `probes()` helper.
- [ ] **Step 2:** run → FAIL. **Step 3:** implement. **Step 4:** run → PASS. **Step 5:** commit `feat(setup): readiness orchestrator`.

### Task 4: Real probes

**Files:** Create `nodeProbes.ts`, `nodeProbes.integration.test.ts`.

**Interfaces:** Produces `nodeReadinessProbes(): ReadinessProbes` composed of:
- `isGitRepo`, `branchExists`, `binaryResolves` ← `../../doctor/probes.js` (`isGitRepo`, `branchExists`, `binaryResolves`; `branchExists` there is the doctor one — confirm it accepts `origin/<b>`; if not, wrap: local `rev-parse --verify` OR `refs/remotes/origin/<b>`); `hasRemote`, `fileExists` ← `nodeEnvProbe()` from `../../manifest/nodeEnvProbe.js`.
- `remoteReachable`: async `execFile('git',['-C',repo,'ls-remote','origin','HEAD'],{timeout:10_000,env:{...process.env,GIT_TERMINAL_PROMPT:'0'}})`; resolves false on any error.
- `worktreeTrial(repo, branch)`: path = `worktreePaths(repo, 'setup-check-'+process.pid).path` (from `runtime/worktree.js`, same location tickets use). Ref = local branch if it exists else `origin/<branch>`. `git -C repo worktree add --detach <path> <ref>`; then in `finally` `git -C repo worktree remove --force <path>` + `git worktree prune`; verify `!existsSync(path)` and `git worktree list --porcelain` lacks the path → else `{ok:false,error:'worktree not removed'}`. Never touches the store.
- `baseDefinesScript(repo, branch, script)` ← `baseDefinesScript(gitRunner, repo, ref, script)` from `workflow/gates/npmScript.js` with `runGit` from `integrations/git.js` (check its signature at `integrations/git.ts:194` and adapt to `GitRunner`).
- `coreState(provider)` ← `dependencyState(agentDependency(provider), binaryExists, commandSucceeds, readCommandOutput)` from `runtime/deps.js`.

- [ ] **Step 1: Integration test** (temp git fixture with `mkdtempSync`, `git init -b main`, commit, `git remote add origin <bare repo in tmp>` via `git init --bare`; `git push origin main`):
  - `isGitRepo` true / false for plain dir
  - `remoteReachable` true with bare remote, false after `git remote set-url origin /nonexistent`
  - `worktreeTrial` ok → afterwards `.karst/worktrees/setup-check-*` absent and `git worktree list` has one entry
  - `worktreeTrial` for missing branch → `{ok:false}` with error
  - `baseDefinesScript`: commit `package.json {"scripts":{"test":"x"}}` → true for `test`, false for `lint`
  - `hasRemote` true/false
- [ ] **Step 2:** `npx vitest run --config vitest.integration.config.ts src/setup/readiness/nodeProbes.integration.test.ts` → FAIL. **Step 3:** implement. **Step 4:** PASS. **Step 5:** commit `feat(setup): real readiness probes`.

### Task 5: CLI verb + wiring

**Files:** Create `src/cli/setupCheck.ts`, `src/cli/setupCheck.test.ts`; Modify `src/cli/main.ts` (near line 661), `src/cli/registry.ts:492-520`.

**Interfaces:**
- Produces: `parseSetupCheckArgs(rest): { repos: string[] }` (mirror `parseSetupVerifyArgs`: `setup check [--repos a,b]`, error text prefix `karst setup check:`), `runSetupCheckCommand(input: ReadinessInput): Promise<string>` → `JSON.stringify(report)`.
- `main.ts`: before the `setup verify` branch add
```ts
if (rest[0] === 'setup' && rest[1] === 'check') {
  if (!manifestPath) throw new Error('missing --manifest <path>');
  const parsed = parseSetupCheckArgs(rest);
  let manifest: Manifest | undefined; let loadError: string | undefined; let warnings: string[] = [];
  try { const loaded = loadManifestWithDiagnostics(manifestPath); manifest = loaded.manifest; warnings = loaded.warnings; }
  catch (e) { loadError = (e as Error).message; }
  const { nodeReadinessProbes } = await import('../setup/readiness/nodeProbes.js');
  return runSetupCheckCommand({ manifest, loadError, warnings, repos: parsed.repos, probes: nodeReadinessProbes(),
    verifyServices: db ? (repos) => verifyViaStore(db, manifest!, repos) : undefined });
}
```
  `verifyViaStore` opens the writable store, calls `runSetupVerifyCommand` with lazy `ensureBaseline` (same as the existing branch), parses its JSON, closes the store; because it spawns detached children, add `check` to `exitsAfterFlush` (main.ts ~line 783) ONLY when `--db` is set and the manifest declares a service — simplest: extend `exitsAfterFlush` to `rest[1] === 'verify' || rest[1] === 'check'` (force-exit after flush is harmless for a one-shot).
- `registry.ts`: add `'check'` to the `subcommand` enum; in `toArgv` handle `check` like `verify` (`['setup','check']` + `--repos`). Update the `unknown command` text only if needed (verb `setup` already listed).
- `src/cli/mcp/command.ts` and `guide.ts` mention `setup verify`: add `setup check` where verify is listed; run `npx vitest related src/cli` to see which snapshot/registry tests pin the enum and update them.

- [ ] **Step 1: Failing tests** in `setupCheck.test.ts`: parse (`[]`, `--repos web, api`, unknown arg throws, wrong verb throws); `runSetupCheckCommand` returns JSON whose `ok` is false when a fake probe fails and true when all green (fake `ReadinessProbes`). In `registry` tests (find via `grep -n "verify" src/cli/*.test.ts`) add `toArgv({subcommand:'check', repos:['a','b']})` → `['setup','check','--repos','a,b']`.
- [ ] **Step 2:** FAIL. **Step 3:** implement. **Step 4:** `npx vitest related src/cli/setupCheck.ts src/cli/registry.ts src/cli/main.ts` → PASS; `npm run -s typecheck`.
- [ ] **Step 5:** commit `feat(cli): setup check verb`.

### Task 6: Setup prompt exit step + docs

**Files:** Modify `src/setup/instructions.ts` (+`instructions.test.ts`), `docs/arch/cli.md`, regenerate `docs/arch/system-map.md`.

- [ ] **Step 1: Failing test** in `instructions.test.ts`: the rendered instructions contain `setup check` and the sentence that the session may end only after it passes or after the remaining fails are reported with a proposed fix each; greenfield text mentions check still runs.
- [ ] **Step 2:** FAIL. **Step 3:** After the `7) VERIFY` block (instructions.ts ~line 93) add:
```ts
    `8) CHECK (required last step): run \`node ${cli} setup check\`. It dry-runs everything a first`,
    '   ticket needs — manifest warnings (all count as failures), git repo/baseline/origin/remote',
    '   reachability, a throwaway worktree from the baseline, gate scripts on the baseline, UAT',
    '   tester paths, services, and the agent CLIs. It works with no services too (greenfield and',
    '   gate-only repos). Fix each fail (propose changes via `setup propose-change` / `manifest',
    '   propose`) and re-run. You may end the session ONLY when it reports ok, or after you report',
    '   every remaining fail to the user with the proposed fix for each.',
```
  Also change step 7 wording only if the test for it pins text.
- [ ] **Step 4:** In `docs/arch/cli.md` `[@arch:CLI-14]`: add `src/cli/setupCheck.ts#runSetupCheckCommand` to `covers:` and a bullet `**setup check [--repos a,b]**` (ticketless, async verb, D269 warnings = fails, items list, why not a throwaway ticket, services via `setup verify` only with `--db`, exit step in prompt). Keep `END_DOC_BLOCK`. Run `npm run -s docs:graph`.
- [ ] **Step 5:** `npx vitest run src/setup/instructions.test.ts` PASS; commit `docs+feat(setup): require setup check as exit step`.

### Task 7: Final gates

- [ ] `npm run -s typecheck && npm run -s lint:react` clean.
- [ ] `npm run -s test:unit 2>&1 | tail -15` and `npm run -s test:integration 2>&1 | tail -15` pass.
- [ ] `npx stryker run --mutate src/setup/readiness/repoChecks.ts,src/setup/readiness/gateChecks.ts,src/setup/readiness/runReadiness.ts,src/cli/setupCheck.ts` then `node scripts/mutationSummary.mjs | head -30`; add tests until ≥ 85 (nodeProbes is covered by the integration suite; if Stryker's unit run cannot reach it, report rather than excluding it).
- [ ] `git status` clean, then `stage impl pass` marker.

## Self-Review

- Spec 1 → Task 3 (warnings=fail); 2 → Task 1; 3 → Tasks 1+4; 4 → Task 2; 5 → Task 2; 6 → Task 3+5; 7 → Task 3+4; prompt exit step → Task 6; tests for each item pass/fail → Tasks 1–4.
- Names consistent: `ReadinessProbes`, `ReadinessItem`, `checkRepo`, `checkGates`, `runReadiness`, `nodeReadinessProbes`, `runSetupCheckCommand`, `parseSetupCheckArgs`.
- Known unknowns for the implementer to confirm from source (not guesses to paper over): exact manifest field names in Task 2/3 and `runGit` → `GitRunner` adaptation in Task 4.
