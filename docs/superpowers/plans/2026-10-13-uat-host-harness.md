# UAT Host Harness (real VS Code in Docker) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Tasks marked **[haiku]** are small and mechanical: delegate them to a haiku subagent.

**Goal:** `npm run uat:host:docker -- --fixture <name>` boots a pinned VS Code under xvfb in Docker with the built karst extension, a seeded fixture workspace and a deterministic fake agent core, waits for activation, and exits 0 with nothing left running.

**Architecture:** One bundled Node entry (`dist/uat-host/prepare.js`) builds the fixture workspace (scratch git repo, local bare remote, `.karst/karst.yml`) and seeds `karst.db` with tickets. It runs under the downloaded VS Code binary with `ELECTRON_RUN_AS_NODE=1`, so it loads the same Electron-ABI `better-sqlite3` the extension host loads. `scripts/uat-host/run.mjs` then launches VS Code through `@vscode/test-electron` with an in-host test runner (`testRunner.cjs`) that activates the extension and asserts the DB was opened and the fixture tickets are visible. A fake `AgentAdapter` replaces every provider when `KARST_FAKE_CORE=1`. A Docker wrapper (`docker.mjs`) builds the image, runs it `--rm --init` under `xvfb-run`, and force-removes the container on signal.

**Tech Stack:** Node ESM, TypeScript (vitest), `@vscode/test-electron`, esbuild (existing `scripts/build-extension.mjs`), Docker (`node:22-bookworm` + xvfb + Electron libs), better-sqlite3 (Electron ABI 140, VS Code 1.126).

**Spec:** Ticket UAT-HOST-HARNESS-REAL-VS-CODE (T684) prompt and context brief (`karst context UAT-HOST-HARNESS-REAL-VS-CODE`). Design constraints: `docs/arch/ABI.md` (`arch:ABI-01..03`), `docs/arch/stages-and-gates.md` (`arch:UAT-SERVICES`), `docs/arch/agent-cores.md` (`arch:AC-01`), commits dbcafdff and 18086580.

## Global Constraints

- VS Code is pinned: `UAT_VSCODE_VERSION = '1.126.0'` (Electron 39, ABI 140; `engines.vscode` is `^1.105.1`).
- Never touch the user's real Cursor/Code profile or globalStorage: every run uses a fresh temp `--user-data-dir` and `--extensions-dir`.
- No LLM calls: `KARST_FAKE_CORE=1` selects the fake core for every provider.
- better-sqlite3 inside the container is rebuilt with `npm run rebuild:electron` (`BETTER_SQLITE3_ABI=140`) in a container-private `node_modules` volume (`-v /work/node_modules`, same as `test:visual:docker`). The host checkout's addon is never flipped (ABI-01/ABI-03).
- `spawnSync` is banned on gate/driver paths; harness scripts under `scripts/` and test code may spawn.
- Naming rule: a test file that spawns real git/child processes is `*.integration.test.ts`.
- ESM imports need the `.js` suffix; `noUncheckedIndexedAccess` is on.
- Strict TDD, conventional commits, files under 400 lines.
- Fixtures are predefined scripts only. Real-core mode is out of scope. The probe command/CLI is a separate draft.
- Fixture names: `empty`, `ticket-mid-stage`, `blocked`.

## File Structure

| File | Responsibility |
|---|---|
| `src/agent/fakeCore.ts` (+test) | `FakeAdapter`: deterministic `AgentAdapter`, no network |
| `src/agent/registry.ts` (mod, +test) | `KARST_FAKE_CORE=1` makes `resolveAdapter` return `FakeAdapter` |
| `src/uatHost/fixtures.ts` (+test) | Pure fixture specs: names, manifest text, ticket seeds |
| `src/uatHost/seed.ts` (+test) | Applies ticket seeds to a `Store` |
| `src/uatHost/workspace.ts` (+integration test) | Builds scratch repo, bare remote, `.karst/karst.yml` |
| `src/uatHost/prepare.ts` | CLI entry: workspace + seed, prints JSON; bundled to `dist/uat-host/prepare.js` |
| `scripts/build-extension.mjs` (mod) | Extra bundle entry for `prepare.ts` |
| `scripts/uat-host/settings.json` | Checked-in VS Code settings preset |
| `scripts/uat-host/run.mjs` | Orchestrator: download VS Code, prepare, `runTests` |
| `scripts/uat-host/testRunner.cjs` | In-host runner: activate, assert |
| `docker/uat-host/Dockerfile`, `scripts/uat-host/docker.mjs` | Image + `--rm` wrapper with signal teardown |
| `src/uatHost/boot.integration.test.ts` | Boot+activate per fixture, exit 0, no leftovers |
| `docs/arch/uat-host.md` | Keyed doc block `arch:UATHOST-01` |

---

### Task 1: Fake agent core + registry flag

**Files:**
- Create: `src/agent/fakeCore.ts`, `src/agent/fakeCore.test.ts`
- Modify: `src/agent/registry.ts` (`resolveAdapter`), `src/agent/registry.test.ts`

**Interfaces:**
- Consumes: `AgentAdapter`, `HeadlessResult`, `InteractiveCommand` from `./adapter.js`.
- Produces: `export const FAKE_CORE_ENV = 'KARST_FAKE_CORE'`; `export class FakeAdapter implements AgentAdapter`; `resolveAdapter(provider)` returns a `FakeAdapter` when `process.env.KARST_FAKE_CORE === '1'`.

- [ ] **Step 1: Write the failing tests**

`src/agent/fakeCore.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { FakeAdapter } from './fakeCore.js';

describe('FakeAdapter', () => {
  it('answers headless runs deterministically with no usage', async () => {
    const a = new FakeAdapter();
    const r1 = await a.runHeadless({ prompt: 'x', cwd: '/tmp' });
    const r2 = await a.runHeadless({ prompt: 'y', cwd: '/tmp' });
    expect(r1).toEqual(r2);
    expect(r1.sessionId).toBe('fake-session');
    expect(r1.verdict).toBeNull();
    expect(r1.usage).toBeUndefined();
  });

  it('builds an inert interactive command', () => {
    const cmd = new FakeAdapter().buildInteractiveCommand({} as never);
    expect(cmd.command).toBe('node');
    expect(cmd.env).toEqual({});
  });

  it('declares no lifecycle or resume support', () => {
    expect(new FakeAdapter().capabilities).toEqual({ lifecycleEvents: false, resume: false });
  });
});
```
Append to `src/agent/registry.test.ts` (match the file's existing import style):
```ts
describe('KARST_FAKE_CORE', () => {
  afterEach(() => vi.unstubAllEnvs());
  it('returns FakeAdapter for every provider when set to 1', () => {
    vi.stubEnv('KARST_FAKE_CORE', '1');
    for (const p of ['claude', 'codex', 'antigravity', 'opencode', 'opencode2'] as const) {
      expect(resolveAdapter(p)).toBeInstanceOf(FakeAdapter);
    }
  });
  it('is off by default', () => {
    vi.stubEnv('KARST_FAKE_CORE', '');
    expect(resolveAdapter('claude')).not.toBeInstanceOf(FakeAdapter);
  });
});
```
(add `FakeAdapter` import and `afterEach, vi` to the vitest import if missing.)

- [ ] **Step 2: Run, expect FAIL**

Run: `npx vitest run src/agent/fakeCore.test.ts src/agent/registry.test.ts`
Expected: FAIL, cannot resolve `./fakeCore.js`.

- [ ] **Step 3: Implement**

`src/agent/fakeCore.ts`:
```ts
import type { AgentAdapter, HeadlessResult, InteractiveCommand } from './adapter.js';

/** Env flag that swaps every real agent core for `FakeAdapter` (UAT host harness). */
export const FAKE_CORE_ENV = 'KARST_FAKE_CORE';

/** Deterministic stand-in core: no process, no network, no tokens. */
export class FakeAdapter implements AgentAdapter {
  readonly requiredBinary = 'node';
  readonly capabilities = { lifecycleEvents: false, resume: false };

  async runHeadless(): Promise<HeadlessResult> {
    return { sessionId: 'fake-session', verdict: null, raw: 'fake core: no LLM call' };
  }

  buildInteractiveCommand(): InteractiveCommand {
    return { command: 'node', args: ['-e', 'setTimeout(() => {}, 1000)'], env: {} };
  }
}
```
In `registry.ts` add `import { FAKE_CORE_ENV, FakeAdapter } from './fakeCore.js';` and change `resolveAdapter`:
```ts
export function resolveAdapter(provider: AgentProvider): AgentAdapter {
  if (process.env[FAKE_CORE_ENV] === '1') return new FakeAdapter();
  return FACTORIES[provider]();
}
```

- [ ] **Step 4: Run, expect PASS**

Run: `npx vitest run src/agent/fakeCore.test.ts src/agent/registry.test.ts`, then `npm run -s typecheck`.
Expected: PASS. If `AgentAdapter` has required members the tests or typecheck flag, add the minimal member.

- [ ] **Step 5: Commit**
```bash
git add src/agent/fakeCore.ts src/agent/fakeCore.test.ts src/agent/registry.ts src/agent/registry.test.ts
git commit -m "feat: fake agent core selected by KARST_FAKE_CORE for the UAT host harness"
```

---

### Task 2: Fixture specs (pure)

**Files:**
- Create: `src/uatHost/fixtures.ts`, `src/uatHost/fixtures.test.ts`

**Interfaces:**
- Produces:
```ts
export const FIXTURE_NAMES = ['empty', 'ticket-mid-stage', 'blocked'] as const;
export type FixtureName = (typeof FIXTURE_NAMES)[number];
export function isFixtureName(s: string): s is FixtureName;
export interface TicketSeed {
  key: string; title: string; stageCurrent: StageKey;
  stage?: { stageKey: StageKey; patch: StagePatch };
}
export interface FixtureSpec { name: FixtureName; tickets: TicketSeed[]; }
export function fixtureSpec(name: FixtureName): FixtureSpec;
export function manifestText(repoPath: string): string;   // karst.yml body
```
- Imports `StageKey` and `StagePatch` types from where `src/store/stages.ts` gets them (`StagePatch` is exported from `src/store/stages.ts`; find `StageKey` with `grep -n "export type StageKey" -r src`).

- [ ] **Step 1: Write the failing test**
```ts
import { describe, expect, it } from 'vitest';
import { FIXTURE_NAMES, fixtureSpec, isFixtureName, manifestText } from './fixtures.js';

describe('fixtures', () => {
  it('empty has no tickets', () => {
    expect(fixtureSpec('empty').tickets).toEqual([]);
  });
  it('ticket-mid-stage has one running impl ticket', () => {
    const [t] = fixtureSpec('ticket-mid-stage').tickets;
    expect(t?.stageCurrent).toBe('impl');
    expect(t?.stage?.patch.status).toBe('running');
  });
  it('blocked has a boot-failed uat block', () => {
    const [t] = fixtureSpec('blocked').tickets;
    expect(t?.stageCurrent).toBe('uat');
    expect(t?.stage?.patch.blockedKind).toBe('boot-failed');
  });
  it('isFixtureName guards', () => {
    expect(FIXTURE_NAMES.every(isFixtureName)).toBe(true);
    expect(isFixtureName('nope')).toBe(false);
  });
  it('manifestText points the only repo at the given path', () => {
    const text = manifestText('/w/repo');
    expect(text).toContain('repoPath: /w/repo');
    expect(text).toContain('agentProvider: claude');
  });
});
```

- [ ] **Step 2: Run, expect FAIL** — `npx vitest run src/uatHost/fixtures.test.ts` (module missing).

- [ ] **Step 3: Implement** `fixtures.ts`:
```ts
import type { StageKey } from '../model/stage.js'; // use the real import path found by grep
import type { StagePatch } from '../store/stages.js';

export const FIXTURE_NAMES = ['empty', 'ticket-mid-stage', 'blocked'] as const;
export type FixtureName = (typeof FIXTURE_NAMES)[number];

export function isFixtureName(s: string): s is FixtureName {
  return (FIXTURE_NAMES as readonly string[]).includes(s);
}

export interface TicketSeed {
  key: string;
  title: string;
  stageCurrent: StageKey;
  stage?: { stageKey: StageKey; patch: StagePatch };
}
export interface FixtureSpec { name: FixtureName; tickets: TicketSeed[] }

const STARTED = '2026-01-01T00:00:00.000Z';

const SPECS: Record<FixtureName, TicketSeed[]> = {
  empty: [],
  'ticket-mid-stage': [{
    key: 'FIX-MID', title: 'Fixture: ticket mid-stage', stageCurrent: 'impl',
    stage: { stageKey: 'impl', patch: { status: 'running', startedAt: STARTED } },
  }],
  blocked: [{
    key: 'FIX-BLOCKED', title: 'Fixture: blocked ticket', stageCurrent: 'uat',
    stage: { stageKey: 'uat', patch: {
      status: 'running', startedAt: STARTED,
      blockedKind: 'boot-failed', blockedReason: 'fixture: services failed to start',
    } },
  }],
};

export function fixtureSpec(name: FixtureName): FixtureSpec {
  return { name, tickets: SPECS[name] };
}

export function manifestText(repoPath: string): string {
  return [
    'host: 127.0.0.1',
    'portRange: [4000, 4100]',
    'baselineBranch: main',
    'agentProvider: claude',
    'repositories:',
    '  app:',
    `    repoPath: ${repoPath}`,
    '    hasMigrations: false',
    '    signals: [app]',
    '',
  ].join('\n');
}
```
If `'running'` is not a valid `StageStatus`, use the member the type offers for an in-flight stage; if `loadManifest` rejects this minimal manifest in Task 4's test, add the missing required keys (compare `karst.example.yml`).

- [ ] **Step 4: Run, expect PASS** — same command, then `npm run -s typecheck`.
- [ ] **Step 5: Commit** — `git add src/uatHost && git commit -m "feat: UAT host fixture specs"`

---

### Task 3: Seed a store from a spec

**Files:**
- Create: `src/uatHost/seed.ts`, `src/uatHost/seed.test.ts`

**Interfaces:**
- Consumes: `FixtureSpec` (Task 2); `openStore`, `Store` from `../store/db.js`; `createTicket`, `setStageCurrent` from `../store/tickets.js`; `setStage` from `../store/stages.js`.
- Produces: `export function seedStore(store: Store, spec: FixtureSpec): number[]` (created ticket ids). Tickets are created without `projectId`; the extension adopts unassigned tickets into the workspace project on activation (`adoptUnassignedTickets`, `src/store/projects.ts`).

- [ ] **Step 1: Failing test**
```ts
import { describe, expect, it } from 'vitest';
import { openStore } from '../store/db.js';
import { getTicketByKey } from '../store/tickets.js';
import { stageBlock } from '../store/stageBlocks.js';
import { fixtureSpec } from './fixtures.js';
import { seedStore } from './seed.js';

describe('seedStore', () => {
  it('seeds nothing for empty', () => {
    const store = openStore(':memory:');
    expect(seedStore(store, fixtureSpec('empty'))).toEqual([]);
  });
  it('seeds the blocked ticket at uat with its block', () => {
    const store = openStore(':memory:');
    const [id] = seedStore(store, fixtureSpec('blocked'));
    const t = getTicketByKey(store, 'FIX-BLOCKED');
    expect(t?.stage_current ?? t?.stageCurrent).toBe('uat');
    expect(stageBlock(store, id!, 'uat')?.kind).toBe('boot-failed');
  });
  it('seeds the mid-stage ticket at impl', () => {
    const store = openStore(':memory:');
    seedStore(store, fixtureSpec('ticket-mid-stage'));
    expect(getTicketByKey(store, 'FIX-MID')).toBeDefined();
  });
});
```
(Check the `Ticket` field casing in `src/store/tickets.ts` and keep only the real property; drop the `??`.)

- [ ] **Step 2: Run, expect FAIL** — `npx vitest run src/uatHost/seed.test.ts`.
- [ ] **Step 3: Implement**
```ts
import type { Store } from '../store/db.js';
import { setStage } from '../store/stages.js';
import { createTicket, setStageCurrent } from '../store/tickets.js';
import type { FixtureSpec } from './fixtures.js';

export function seedStore(store: Store, spec: FixtureSpec): number[] {
  return spec.tickets.map((seed) => {
    const ticket = createTicket(store, { key: seed.key, title: seed.title });
    setStageCurrent(store, ticket.id, seed.stageCurrent);
    if (seed.stage) setStage(store, ticket.id, seed.stage.stageKey, seed.stage.patch);
    return ticket.id;
  });
}
```
- [ ] **Step 4: Run, expect PASS** — then `npm run -s typecheck`.
- [ ] **Step 5: Commit** — `git commit -am "feat: seed fixture tickets into a store"` (add new files first).

---

### Task 4: Scratch workspace builder (git + bare remote + manifest)

**Files:**
- Create: `src/uatHost/workspace.ts`, `src/uatHost/workspace.integration.test.ts`

**Interfaces:**
- Consumes: `manifestText` (Task 2); `loadManifest` from `../manifest/load.js` (check its exact signature with `grep -n "export" src/manifest/load.ts`).
- Produces:
```ts
export interface Workspace { workspaceDir: string; repoDir: string; remoteDir: string; manifestPath: string }
export function buildWorkspace(root: string): Workspace;
```
Layout under `root`: `remote.git` (bare), `workspace/` (VS Code opens this; holds `.karst/karst.yml` and the repo as `workspace/repo`, a clone with one commit on `main`, `origin` = `remote.git`, commit pushed).

- [ ] **Step 1: Failing test** (`workspace.integration.test.ts`)
```ts
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildWorkspace } from './workspace.js';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe('buildWorkspace', () => {
  it('creates repo with pushed main, bare remote and manifest', () => {
    const root = mkdtempSync(join(tmpdir(), 'karst-ws-'));
    dirs.push(root);
    const ws = buildWorkspace(root);
    expect(existsSync(ws.manifestPath)).toBe(true);
    expect(readFileSync(ws.manifestPath, 'utf8')).toContain(`repoPath: ${ws.repoDir}`);
    const remoteHead = execFileSync('git', ['--git-dir', ws.remoteDir, 'rev-parse', 'main']).toString().trim();
    const localHead = execFileSync('git', ['-C', ws.repoDir, 'rev-parse', 'main']).toString().trim();
    expect(remoteHead).toBe(localHead);
  });
});
```
- [ ] **Step 2: Run, expect FAIL** — `npx vitest run --config vitest.integration.config.ts src/uatHost/workspace.integration.test.ts`.
- [ ] **Step 3: Implement**
```ts
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { manifestText } from './fixtures.js';

export interface Workspace { workspaceDir: string; repoDir: string; remoteDir: string; manifestPath: string }

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'karst', GIT_AUTHOR_EMAIL: 'karst@example.invalid',
  GIT_COMMITTER_NAME: 'karst', GIT_COMMITTER_EMAIL: 'karst@example.invalid',
};
const git = (args: string[], cwd?: string): void => {
  execFileSync('git', args, { cwd, env: GIT_ENV, stdio: 'pipe' });
};

export function buildWorkspace(root: string): Workspace {
  const remoteDir = join(root, 'remote.git');
  const workspaceDir = join(root, 'workspace');
  const repoDir = join(workspaceDir, 'repo');
  const manifestPath = join(workspaceDir, '.karst', 'karst.yml');
  mkdirSync(workspaceDir, { recursive: true });
  git(['init', '--bare', '--initial-branch=main', remoteDir]);
  git(['init', '--initial-branch=main', repoDir]);
  writeFileSync(join(repoDir, 'README.md'), '# fixture repo\n');
  git(['add', '.'], repoDir);
  git(['commit', '-m', 'chore: fixture seed'], repoDir);
  git(['remote', 'add', 'origin', remoteDir], repoDir);
  git(['push', '-u', 'origin', 'main'], repoDir);
  mkdirSync(join(workspaceDir, '.karst'), { recursive: true });
  writeFileSync(manifestPath, manifestText(repoDir));
  return { workspaceDir, repoDir, remoteDir, manifestPath };
}
```
- [ ] **Step 4: Run, expect PASS.** Then add to the test a `loadManifest` assertion on `ws.manifestPath` (using the real signature) so an invalid minimal manifest fails here, not in the container; fix `manifestText` until it passes.
- [ ] **Step 5: Commit** — `git commit -m "feat: scratch git workspace with bare remote and manifest for UAT host"`

---

### Task 5: `prepare` entry + bundle

**Files:**
- Create: `src/uatHost/prepare.ts`
- Modify: `scripts/build-extension.mjs` (add entry), `scripts/verify-build.mjs` only if it fails on the extra output.

**Interfaces:**
- Consumes: `buildWorkspace`, `fixtureSpec`, `isFixtureName`, `seedStore`, `openStore`.
- Produces: CLI `node dist/uat-host/prepare.js --fixture <name> --root <dir> --db <path>`. Creates the workspace under `<root>`, creates parent dirs of `<db>`, seeds `<db>`, prints one line of JSON `{"workspaceDir": "...", "tickets": <n>}` to stdout. Exit 2 with a stderr message on an unknown fixture or missing flag.

- [ ] **Step 1: Implement** `prepare.ts` (thin binding, no new logic worth a unit test; covered by Task 7):
```ts
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { openStore } from '../store/db.js';
import { fixtureSpec, isFixtureName } from './fixtures.js';
import { seedStore } from './seed.js';
import { buildWorkspace } from './workspace.js';

function flag(name: string): string {
  const i = process.argv.indexOf(`--${name}`);
  const v = i >= 0 ? process.argv[i + 1] : undefined;
  if (!v) { console.error(`uat-host prepare: missing --${name}`); process.exit(2); }
  return v;
}

const fixture = flag('fixture');
if (!isFixtureName(fixture)) {
  console.error(`uat-host prepare: unknown fixture "${fixture}"`);
  process.exit(2);
}
const ws = buildWorkspace(flag('root'));
const dbPath = flag('db');
mkdirSync(dirname(dbPath), { recursive: true });
const store = openStore(dbPath);
const ids = seedStore(store, fixtureSpec(fixture));
store.db.close();
console.log(JSON.stringify({ workspaceDir: ws.workspaceDir, tickets: ids.length }));
```
- [ ] **Step 2:** Read `scripts/build-extension.mjs`; add a second entry `src/uatHost/prepare.ts` → `dist/uat-host/prepare.js`, same format/platform/externals as the `dist/cli/main.js` entry (keep `better-sqlite3` external, as the extension bundle does).
- [ ] **Step 3: Verify the bundle** — `npm run -s build && ls dist/uat-host/prepare.js && node dist/uat-host/prepare.js --fixture nope --root /tmp/x --db /tmp/x/k.db; echo $?`
Expected: file exists, message `unknown fixture "nope"`, exit 2.
- [ ] **Step 4:** `npm run -s typecheck`. Commit: `git add src/uatHost/prepare.ts scripts/build-extension.mjs && git commit -m "feat: bundle UAT host prepare entry"`

---

### Task 6: Host runner, settings preset, in-host assertions

**Files:**
- Create: `scripts/uat-host/settings.json`, `scripts/uat-host/run.mjs`, `scripts/uat-host/testRunner.cjs`
- Modify: `package.json` (devDependency `@vscode/test-electron`, script `uat:host`)

**Interfaces:**
- Consumes: `dist/uat-host/prepare.js` (Task 5).
- Produces: `node scripts/uat-host/run.mjs --fixture <name>` — exit 0 when the extension activated with the fixture visible; non-zero otherwise. Env overrides: `UAT_VSCODE_VERSION` (default `1.126.0`), `UAT_VSCODE_CACHE` (download dir, default `.vscode-test`).

- [ ] **Step 1:** `npm install -D @vscode/test-electron` (pin the exact resolved version in `package.json`, no `^`).
- [ ] **Step 2:** `scripts/uat-host/settings.json`:
```json
{
  "security.workspace.trust.enabled": false,
  "telemetry.telemetryLevel": "off",
  "update.mode": "none",
  "extensions.autoUpdate": false,
  "workbench.startupEditor": "none",
  "window.restoreWindows": "none",
  "git.autofetch": false,
  "git.openRepositoryInParentFolders": "never"
}
```
- [ ] **Step 3:** `scripts/uat-host/run.mjs`:
```js
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { downloadAndUnzipVSCode, runTests } from '@vscode/test-electron';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');
const FIXTURES = ['empty', 'ticket-mid-stage', 'blocked'];
const version = process.env.UAT_VSCODE_VERSION ?? '1.126.0';
const cachePath = resolve(process.env.UAT_VSCODE_CACHE ?? join(repoRoot, '.vscode-test'));

const i = process.argv.indexOf('--fixture');
const fixture = i >= 0 ? process.argv[i + 1] : undefined;
if (!fixture || !FIXTURES.includes(fixture)) {
  console.error(`usage: run.mjs --fixture <${FIXTURES.join('|')}>`);
  process.exit(2);
}

const root = mkdtempSync(join(tmpdir(), 'karst-uat-host-'));
let code = 1;
try {
  const userData = join(root, 'user-data');
  const extensionsDir = join(root, 'extensions');
  const dbPath = join(userData, 'User', 'globalStorage', 'karst.karst', 'karst.db');
  mkdirSync(join(userData, 'User'), { recursive: true });
  mkdirSync(extensionsDir, { recursive: true });
  copyFileSync(join(here, 'settings.json'), join(userData, 'User', 'settings.json'));

  const vscodeExecutablePath = await downloadAndUnzipVSCode({ version, cachePath });

  // Seed under the VS Code binary as plain Node so better-sqlite3 loads at the
  // Electron ABI the extension host will use (arch:ABI-01).
  const prep = spawnSync(
    vscodeExecutablePath,
    [join(repoRoot, 'dist', 'uat-host', 'prepare.js'), '--fixture', fixture, '--root', join(root, 'fixture'), '--db', dbPath],
    { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8' },
  );
  if (prep.status !== 0) throw new Error(`prepare failed (${prep.status}): ${prep.stderr}`);
  const { workspaceDir, tickets } = JSON.parse(prep.stdout.trim().split('\n').pop());

  await runTests({
    vscodeExecutablePath,
    extensionDevelopmentPath: repoRoot,
    extensionTestsPath: join(here, 'testRunner.cjs'),
    extensionTestsEnv: {
      KARST_FAKE_CORE: '1',
      UAT_EXPECT_TICKETS: String(tickets),
      UAT_DB_PATH: dbPath,
    },
    launchArgs: [
      workspaceDir,
      '--user-data-dir', userData,
      '--extensions-dir', extensionsDir,
      '--disable-extensions',
      '--disable-workspace-trust',
      '--no-sandbox',
      '--disable-gpu',
    ],
  });
  code = 0;
} catch (err) {
  console.error('uat-host: FAILED —', err instanceof Error ? err.message : err);
} finally {
  rmSync(root, { recursive: true, force: true });
}
process.exit(code);
```
Note: `--disable-extensions` still loads the `extensionDevelopmentPath` extension.
- [ ] **Step 4:** `scripts/uat-host/testRunner.cjs` (runs inside the extension host):
```js
const assert = require('node:assert');
const { existsSync } = require('node:fs');
const vscode = require('vscode');

exports.run = async function run() {
  const ext = vscode.extensions.getExtension('karst.karst');
  assert.ok(ext, 'karst.karst extension not found');
  await ext.activate();
  assert.strictEqual(ext.isActive, true, 'extension did not activate');

  // activate() returns normally even when the store open fails (it shows an
  // error modal and returns), so also require a registered karst command.
  const cmds = await vscode.commands.getCommands(true);
  assert.ok(cmds.some((c) => c.startsWith('karst.')), 'no karst.* command registered: activation aborted');

  const dbPath = process.env.UAT_DB_PATH;
  assert.ok(dbPath && existsSync(dbPath), `karst.db missing at ${dbPath}`);
  const Database = require('better-sqlite3');
  const db = new Database(dbPath, { readonly: true });
  try {
    const { n } = db.prepare('SELECT COUNT(*) AS n FROM tickets').get();
    assert.strictEqual(n, Number(process.env.UAT_EXPECT_TICKETS), 'seeded ticket count mismatch');
  } finally {
    db.close();
  }
  console.log('uat-host: extension active, db opened, fixture visible');
};
```
`require('better-sqlite3')` resolves from the runner's location (`scripts/uat-host/` walks up to the repo `node_modules`).
- [ ] **Step 5:** Add to `package.json` scripts: `"uat:host": "node scripts/uat-host/run.mjs"`.
- [ ] **Step 6: Local smoke, Linux only** (macOS lacks xvfb and the addon is the Node ABI, so this step happens in Task 7's container). Here only run `node scripts/uat-host/run.mjs --fixture nope; echo $?`. Expected: usage line, exit 2.
- [ ] **Step 7: Commit** — `git add scripts/uat-host package.json package-lock.json && git commit -m "feat: UAT host runner with settings preset and in-host activation assertions"`

---

### Task 7: Docker image + wrapper **[haiku]**

**Files:**
- Create: `docker/uat-host/Dockerfile`, `scripts/uat-host/docker.mjs`
- Modify: `package.json` (script `uat:host:docker`), `.dockerignore` (create if absent: `node_modules`, `.git`, `.karst`, `.vscode-test`, `.stryker-tmp`, `reports`, `dist`)

**Interfaces:**
- Consumes: `npm run uat:host` (Task 6).
- Produces: `npm run uat:host:docker -- --fixture <name>`; image tag `karst-uat-host:local`; container name `karst-uat-host-<pid>`.

- [ ] **Step 1:** `docker/uat-host/Dockerfile`:
```dockerfile
FROM node:22-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends \
    xvfb xauth git ca-certificates python3 make g++ \
    libgtk-3-0 libnss3 libasound2 libgbm1 libxss1 libxkbfile1 libsecret-1-0 libdrm2 libxkbcommon0 \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /work
ENV BETTER_SQLITE3_ABI=140 \
    UAT_VSCODE_CACHE=/vscode-cache
# Source and node_modules are mounted/built at run time (see docker.mjs); the image holds only the OS layer.
CMD ["bash", "-lc", "npm ci && npm run -s build && npm run -s rebuild:electron && xvfb-run -a --server-args='-screen 0 1280x800x24' npm run -s uat:host -- \"$@\"", "--"]
```
- [ ] **Step 2:** `scripts/uat-host/docker.mjs`:
```js
import { spawn, spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const IMAGE = 'karst-uat-host:local';
const name = `karst-uat-host-${process.pid}`;

const build = spawnSync('docker', ['build', '-t', IMAGE, '-f', 'docker/uat-host/Dockerfile', '.'], {
  cwd: repoRoot, stdio: 'inherit',
});
if (build.status !== 0) process.exit(build.status ?? 1);

const child = spawn('docker', [
  'run', '--rm', '--init', '--name', name,
  '-v', `${repoRoot}:/work`,
  '-v', '/work/node_modules',          // container-private addon (arch:ABI-01/ABI-03)
  '-v', 'karst-uat-vscode:/vscode-cache',
  IMAGE, ...process.argv.slice(2),
], { cwd: repoRoot, stdio: 'inherit' });

const forceRemove = () => { spawnSync('docker', ['rm', '-f', name], { stdio: 'ignore' }); };
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { forceRemove(); process.exit(130); });
}
child.on('exit', (code) => { forceRemove(); process.exit(code ?? 1); });
```
- [ ] **Step 3:** `package.json`: `"uat:host:docker": "node scripts/uat-host/docker.mjs"`.
- [ ] **Step 4: Verify (needs Docker):** `npm run -s uat:host:docker -- --fixture empty 2>&1 | tail -20; echo "exit=${PIPESTATUS[0]}"`
Expected: `uat-host: extension active, db opened, fixture visible`, exit 0. Then `docker ps -a --filter name=karst-uat-host --format '{{.Names}}'` prints nothing. If `better-sqlite3` ABI fails, check `rebuild:electron` detected the downloaded VS Code ABI (it falls back to 140); if the Electron version differs from 39, set `BETTER_SQLITE3_ABI` accordingly and update the pin note in Global Constraints.
- [ ] **Step 5: Commit** — `git add docker scripts/uat-host/docker.mjs package.json .dockerignore && git commit -m "feat: Dockerized UAT host harness (xvfb, pinned VS Code)"`

---

### Task 8: Boot+activate integration test

**Files:**
- Create: `src/uatHost/boot.integration.test.ts`

**Interfaces:**
- Consumes: `npm run uat:host:docker` (Task 7).
- Produces: test that runs all three fixtures end to end; skipped when Docker is unavailable.

- [ ] **Step 1: Write the test**
```ts
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { FIXTURE_NAMES } from './fixtures.js';

const hasDocker = spawnSync('docker', ['info'], { stdio: 'ignore' }).status === 0;

describe.skipIf(!hasDocker)('uat:host:docker', () => {
  it.each(FIXTURE_NAMES)('boots and activates on fixture %s with a clean teardown', (fixture) => {
    const run = spawnSync('npm', ['run', '-s', 'uat:host:docker', '--', '--fixture', fixture], {
      encoding: 'utf8',
    });
    expect(run.status, run.stdout + run.stderr).toBe(0);
    expect(run.stdout).toContain('extension active, db opened, fixture visible');

    const leftovers = spawnSync('docker', ['ps', '-a', '--filter', 'name=karst-uat-host-', '--format', '{{.Names}}'], {
      encoding: 'utf8',
    });
    expect(leftovers.stdout.trim()).toBe('');
  }, 900_000);
});
```
- [ ] **Step 2: Run** — `npx vitest run --config vitest.integration.config.ts src/uatHost/boot.integration.test.ts`
Expected: 3 PASS (Docker present) or 3 skipped. Mutate once to prove it bites: change a fixture name in `testRunner.cjs` expected count (`UAT_EXPECT_TICKETS` + 1), rerun, expect FAIL, revert.
- [ ] **Step 3: Commit** — `git add src/uatHost/boot.integration.test.ts && git commit -m "test: UAT host boot and activate on every fixture"`

---

### Task 9: Docs, gates, finish **[haiku for step 1-2]**

**Files:**
- Create: `docs/arch/uat-host.md`
- Modify: `CONTRIBUTING.md` or `README.md` only if they list `npm run` entry points (grep first; skip otherwise).

- [ ] **Step 1:** `docs/arch/uat-host.md`, keyed block format:
```markdown
## [@arch:UATHOST-01] UAT host harness boots the real extension host in Docker with a fake core

`npm run uat:host:docker -- --fixture <empty|ticket-mid-stage|blocked>` builds `karst-uat-host:local`, runs it `--rm --init`, and inside it: builds, rebuilds better-sqlite3 for the Electron ABI in a container-private `node_modules` volume (ABI-01/ABI-03), downloads the pinned VS Code (`UAT_VSCODE_VERSION`, default 1.126.0), seeds `karst.db` and a scratch git workspace by running `dist/uat-host/prepare.js` under the VS Code binary (`ELECTRON_RUN_AS_NODE=1`, so the addon ABI matches), then launches VS Code under xvfb with a temp user-data dir, a temp extensions dir and `scripts/uat-host/settings.json`. `KARST_FAKE_CORE=1` makes `resolveAdapter` return `FakeAdapter` for every provider: no LLM call. `activate()` returns normally when the store open fails, so the in-host runner also requires a registered `karst.*` command and the seeded ticket count. Never point the harness at a real Cursor/Code profile.
END_DOC_BLOCK: [@arch:UATHOST-01]
```
- [ ] **Step 2:** `npm run -s docs:check` — follow its output (it may require an `docs/INDEX.md` entry; add exactly what it asks for).
- [ ] **Step 3:** Final gates: `npm run -s typecheck && npx vitest run src/agent/fakeCore.test.ts src/agent/registry.test.ts src/uatHost && npm run -s test:unit 2>&1 | tail -15`. Expected: all pass. `src/extension/**` is untouched, so the mutation gate does not apply.
- [ ] **Step 4:** Post one bulletin note (optional): `karst notes post` with title "UAT host harness: seed under ELECTRON_RUN_AS_NODE", body: seeding with the VS Code binary as Node gives the Electron-ABI better-sqlite3; `activate()` swallows store-open failure, so assert a `karst.*` command.
- [ ] **Step 5: Commit** — `git add docs && git commit -m "docs: UAT host harness (arch:UATHOST-01)"`, then fire the `stage impl` marker.

---

## Self-Review

- **Spec coverage:** pinned VS Code via test-electron (T6); xvfb + Docker image (T7); built extension loaded (`extensionDevelopmentPath`, T6); isolated user-data/extensions (T6); checked-in settings preset (T6); scratch git repo + `.karst/karst.yml` + seeded tickets + local bare remote (T2-T5); fake core by env flag (T1); better-sqlite3 for container Electron ABI (T7 `rebuild:electron`, ABI-01/03); entry `npm run uat:host:docker -- --fixture` (T7); fixtures empty / ticket-mid-stage / blocked (T2); exit 0 and teardown with no containers/processes (T7 wrapper, T8 asserts); integration test boot+activate (T8). Gap noted: no CI job (YAGNI; advisory job can follow once stable).
- **Placeholders:** none; the two spots that need a real lookup (`StageKey` import path, `loadManifest` signature, `StageStatus` member) say exactly which grep to run.
- **Type consistency:** `FixtureName`, `FixtureSpec`, `TicketSeed`, `seedStore`, `buildWorkspace`, `Workspace`, `FAKE_CORE_ENV`, `FakeAdapter` are used with the same names in every task. Env names `KARST_FAKE_CORE`, `UAT_VSCODE_VERSION`, `UAT_VSCODE_CACHE`, `UAT_EXPECT_TICKETS`, `UAT_DB_PATH` match between `run.mjs`, `testRunner.cjs`, Dockerfile and docs.
- **Known risks:** the extension id `karst.karst` and the globalStorage path come from the session's additional directories (`.../globalStorage/karst.karst`); confirm with `grep -n '"publisher"\|"name"' package.json` in Task 6. VS Code 1.126.0 availability and Electron 39 are taken from `CLAUDE.md`; if the download 404s, pick the nearest published version and recheck the ABI.
