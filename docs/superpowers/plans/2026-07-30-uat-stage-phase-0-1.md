# UAT Stage — Phase 0 + Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the UAT stage ask a real, multi-gate question of every affected repository, park durably when it cannot ask at all, and route every fix back through UAT — with no AI and no running stack.

**Architecture:** UAT stops being one hardcoded `npm test` call. A gate *list* (explicit from `karst.yml`, else probed from `package.json`) runs over a dependency-aware multi-repository target plan; a pure aggregator reduces the results to one verdict under an explicit conjunction. When karst could not ask a question at all — nothing to run, unreadable repo — the runner returns `blocked` instead of a verdict and a transactional `parkGateStage` persists that on the `stages` row, so nothing throws and nothing re-sweeps forever. `graph.ts` gets one word changed so `fix` re-enters `uat`, and `countFixAttempts` stops summing two stages into one budget.

**Tech Stack:** TypeScript (ESM, `moduleResolution: Bundler`), vitest, better-sqlite3 (extension host) / `node:sqlite` (CLI), js-yaml.

## Global Constraints

Copied from `CLAUDE.md` and the spec. Every task's requirements implicitly include this section.

- **ESM:** every relative import needs a `.js` suffix, including from `.ts` files.
- **`noUncheckedIndexedAccess` is on:** array/index access needs `!` or a guard.
- **`vscode` is not a runtime dependency.** No module under `src/workflow/`, `src/store/`, `src/model/` or `src/manifest/` may import it. Only `src/extension.ts` and its thin wrappers may.
- **`spawnSync` is banned on the gate path.** Anything that runs a repository command uses async `spawn` (`src/workflow/gates/run.ts`). Guard test: `gates/run.test.ts` "leaves the event loop free while the child runs".
- **All stage mutation goes through `setStage`** (`src/store/stages.ts`). Single-writer.
- **Store SQL uses positional `?` only** — no named parameters, no `.pluck()`. Aggregator/store helpers stay driver-agnostic because the CLI opens the same helpers with `node:sqlite`.
- **New schema column checklist:** `src/store/schema.sql` (fresh DBs) + a guarded `ALTER` in `src/store/migrations.ts` + bump `SCHEMA_VERSION` + update every `user_version` assertion in `src/store/db.test.ts`.
- **New `Manifest` field checklist:** `src/manifest/types.ts` + `validateManifest` (`src/manifest/schema.ts`) + **the `writeManifest` overlay (`src/manifest/write.ts`)** or Save silently drops it + `src/manifest/fixtures.ts`.
- **File size:** 200–400 lines typical, 800 max. `src/extension.ts` is already 2319 lines — move code out of it, never into it.
- **TDD is mandatory:** write the failing test, run it, watch it fail, then implement.
- **Conventional commits:** `feat:`, `fix:`, `refactor:`, `test:`, `docs:`, `chore:`.
- **Commands:** `npm test` (full suite), `npx vitest run <path>` (single file), `npm run typecheck`.

**Spec of record:** `docs/superpowers/specs/2026-07-29-uat-stage-design.md` (rev 5). The two companion files in that directory are historical — do not implement from them.

## Scope

This plan covers **Phase 0 and Phase 1 only**. Three things the spec defines are deliberately out:

| out of scope | where it goes | why |
|---|---|---|
| **Phase P** — P1/P7 marker CAS + launch token, P2 `starting` servers row, P3 archive ordering, P4 service logs out of the worktree, P5 wiring `openDiff` | its own ticket, ships first and independently | six pre-existing `main` bugs, none caused by UAT, each independently valuable |
| **Phase 1a** — the B8 env allowlist | its own ticket | it changes **review** gate behaviour on `main`, so it must be revertable by itself (spec: "does not ride inside a larger ticket") |
| **Phase 2** — boot, adopt-or-spin, the P6 lease, the extractor→verifier→author chain, Playwright, the digest short-circuit | blocked on an experiment | the spec gates Phase 2 planning on a half-day falsification of "authored steps must be repo-runnable" that has **not been run** |

Phase 1 does not depend on Phase P. If Phase P lands first, nothing here changes.

---

### Task 1: Phase 0 — a UAT gate list instead of one constant

Makes the gate set expressible and stops a regression. It does **not** close the bug for a repo that defines only `test` — that is Task 10's warning. The guard test records the gap rather than hiding it.

**Files:**
- Modify: `src/workflow/gates/scripts.ts:31`
- Modify: `src/model/inside/gates.ts:1,113`
- Modify: `src/workflow/stages/uat.ts:9,80,81,83,124`
- Test: `src/workflow/gates/scripts.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `UAT_GATES: readonly GateSpec[]` exported from `src/workflow/gates/scripts.ts`. `UAT_GATE` is deleted. `GateSpec` is unchanged.

- [ ] **Step 1: Write the failing test**

Append to `src/workflow/gates/scripts.test.ts`:

```ts
import { REVIEW_GATES, UAT_GATES } from './scripts.js';

describe('UAT_GATES', () => {
  it('is a non-empty list whose first entry is the repo test script', () => {
    expect(UAT_GATES.length).toBeGreaterThan(0);
    expect(UAT_GATES[0]).toEqual({ name: 'test', script: 'test', args: ['test'] });
  });

  // Phase 0 records the known gap rather than asserting it away. Every declared
  // UAT gate is also a review gate today, which is exactly the bug — a static
  // check over declared constants cannot catch it, so this test pins the state
  // so that widening the list is a visible diff rather than a silent one.
  it('records that every declared UAT gate is still a declared review gate', () => {
    const reviewScripts = REVIEW_GATES.map((g) => g.script);
    for (const gate of UAT_GATES) {
      expect(reviewScripts, `UAT gate ${gate.name} left the review set`).toContain(gate.script);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/workflow/gates/scripts.test.ts`
Expected: FAIL — `UAT_GATES` is not exported from `./scripts.js`.

- [ ] **Step 3: Write minimal implementation**

In `src/workflow/gates/scripts.ts`, replace the `UAT_GATE` export (line 26–31) with:

```ts
/**
 * The UAT gate list. A list, not a constant: the original bug was that UAT asked
 * exactly ONE question and another stage asked it too, so the fix is not removing
 * `test` — it is giving UAT room to ask more. `test` stays FIRST because it is the
 * conventional entry point and usually the cheapest suite in the repo, and
 * cheapest-first is what makes a failing gate fail fast.
 *
 * Sharing REVIEW_GATES' `test` entry is still true here and still not enough on
 * its own — see `uat/aggregate.ts`, which checks the identities that actually RAN.
 */
export const UAT_GATES: readonly GateSpec[] = [
  { name: 'test', script: 'test', args: ['test'] },
];
```

In `src/model/inside/gates.ts` line 1, change the import to `import { REVIEW_GATES, UAT_GATES, type GateSpec } from '../../workflow/gates/scripts.js';` and line 113 to:

```ts
  const ops = gateOps(UAT_GATES, latestBatch(runs, 'uat'), showPending);
```

In `src/workflow/stages/uat.ts` line 9, change the import to `import { UAT_GATES, readPackageScripts } from '../gates/scripts.js';` and add above `makeNpmTestRunner`:

```ts
/** The repo-suite gate — the first entry, which the list guarantees exists. */
const TEST_GATE = UAT_GATES[0]!;
```

Then replace `UAT_GATE` with `TEST_GATE` at lines 80, 81, 83 and 124.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/workflow/gates/scripts.test.ts src/model/inside/gates.test.ts src/workflow/stages/uat.test.ts`
Expected: PASS. Then `npm run typecheck` — expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/workflow/gates/scripts.ts src/workflow/gates/scripts.test.ts src/model/inside/gates.ts src/workflow/stages/uat.ts
git commit -m "refactor: express UAT gates as a list, not one constant"
```

---

### Task 2: Route every fix back through UAT

One word in the static table. A ticket that fails UAT currently reaches `ship` without ever passing UAT, because `fix` re-enters `review`.

**Files:**
- Modify: `src/workflow/graph.ts:15,17,33`
- Test: `src/workflow/graph.test.ts`, `src/workflow/machine.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `STAGE_GRAPH.fix.passed === 'uat'`. `isBranch`, `MAIN_LINE`, `isTerminal`, `GATE_STAGES` are all unchanged in behaviour and need no edits — they derive from the table.

- [ ] **Step 1: Write the failing test**

Append to `src/workflow/graph.test.ts`:

```ts
import { STAGE_GRAPH, isBranch, MAIN_LINE } from './graph.js';

describe('the fix return edge', () => {
  it('re-enters uat, so a ticket that failed uat cannot ship without passing it', () => {
    expect(STAGE_GRAPH.fix.passed).toBe('uat');
  });

  it('leaves fix a branch and the main line unchanged', () => {
    expect(isBranch('fix')).toBe(true);
    expect(isBranch('uat')).toBe(false);
    expect(MAIN_LINE).toEqual(['scope', 'impl', 'uat', 'review', 'ship', 'done']);
  });
});
```

Append to `src/workflow/machine.test.ts`:

```ts
it('a review failure re-validates through uat, not straight back to review', () => {
  const store = openStore(':memory:');
  const id = createTicketFlow(store, { key: 'T-9', title: 't' }).id;
  transition(store, id, 'scope', { kind: 'passed' });
  transition(store, id, 'impl', { kind: 'passed' });
  transition(store, id, 'uat', { kind: 'passed' });
  expect(transition(store, id, 'review', { kind: 'failed' })).toBe('fix');
  expect(transition(store, id, 'fix', { kind: 'passed' })).toBe('uat');
  store.close();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/workflow/graph.test.ts src/workflow/machine.test.ts`
Expected: FAIL — `expected 'review' to be 'uat'`.

- [ ] **Step 3: Write minimal implementation**

In `src/workflow/graph.ts`, change line 33 to:

```ts
  fix: { passed: 'uat' }, // revalidate: every fix re-enters uat, whichever gate failed
```

Update the ASCII diagram in the module doc comment (lines 10–18) to:

```
 * Shape (fix→revalidate→uat loop):
 *   scope ─pass→ impl ─pass→ uat ─pass→ review ─pass→ ship ─pass→ done
 *                            ↑ │              │
 *                            │ fail          fail
 *                            │  ▼              ▼
 *                            └─ fix ←──────────┘
 *
 * `fix` always returns to `uat`. A review failure re-validates from uat because a
 * fix made for a review finding is still unvalidated code, and the two keys a
 * split would need are distinguishable only by WHICH gate failed — which
 * `gate_runs` already records, append-only, per stage and attempt.
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS. Any failure here is a real assumption elsewhere that `fix → review`; fix that call site, do not weaken the test.

- [ ] **Step 5: Commit**

```bash
git add src/workflow/graph.ts src/workflow/graph.test.ts src/workflow/machine.test.ts
git commit -m "fix: route every fix back through uat so a failed uat cannot ship"
```

---

### Task 3: Shared gate result type and discriminated script probing

`readPackageScripts` returns `{}` for four different situations — no `package.json`, unreadable, malformed JSON, permission error — so a broken repo and a repo with no tests are indistinguishable and both currently produce a vacuous green.

**Files:**
- Create: `src/workflow/gates/result.ts`
- Create: `src/workflow/gates/probe.ts`
- Create: `src/workflow/gates/probe.test.ts`
- Modify: `src/workflow/gates/scripts.ts:39-48`
- Modify: `src/workflow/stages/review.ts:24-40`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `src/workflow/gates/result.ts` — `export interface GateResult { name: string; exitCode: number | null; output: string; startedAt?: string; endedAt?: string }`
  - `src/workflow/gates/probe.ts` — `export type ScriptProbe = { kind: 'ok'; scripts: Record<string, string> } | { kind: 'absent' } | { kind: 'malformed'; message: string } | { kind: 'io-error'; message: string }` and `export function probeScripts(cwd: string): ScriptProbe`.
  - `readPackageScripts(cwd: string): Record<string, string>` keeps its exact current signature and behaviour, reimplemented on `probeScripts`.

- [ ] **Step 1: Write the failing test**

Create `src/workflow/gates/probe.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { probeScripts } from './probe.js';

describe('probeScripts', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'karst-probe-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('returns the scripts block when package.json is well-formed', () => {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'vitest' } }));
    expect(probeScripts(dir)).toEqual({ kind: 'ok', scripts: { test: 'vitest' } });
  });

  it('treats a package.json with no scripts block as ok-and-empty, not absent', () => {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'x' }));
    expect(probeScripts(dir)).toEqual({ kind: 'ok', scripts: {} });
  });

  it('distinguishes an absent package.json from a malformed one', () => {
    expect(probeScripts(dir).kind).toBe('absent');
    writeFileSync(join(dir, 'package.json'), '{ not json');
    const probe = probeScripts(dir);
    expect(probe.kind).toBe('malformed');
    if (probe.kind === 'malformed') expect(probe.message.length).toBeGreaterThan(0);
  });

  it('reports an unreadable package.json as io-error, not as absent', () => {
    const file = join(dir, 'package.json');
    writeFileSync(file, JSON.stringify({ scripts: {} }));
    chmodSync(file, 0o000);
    const probe = probeScripts(dir);
    chmodSync(file, 0o644); // restore so afterEach can remove it
    // Running as root defeats mode bits; skip rather than assert a false thing.
    if (process.getuid?.() === 0) return;
    expect(probe.kind).toBe('io-error');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/workflow/gates/probe.test.ts`
Expected: FAIL — cannot resolve `./probe.js`.

- [ ] **Step 3: Write minimal implementation**

Create `src/workflow/gates/result.ts`:

```ts
/**
 * One gate's outcome. Shared, because more than one stage depends on it now:
 * `CommandResult.exitCode` is `number` and cannot express "did not run", which is
 * exactly what a gate whose script the repo never defined has to say.
 */
export interface GateResult {
  name: string;
  /**
   * The gate's exit code, or null when it did not run because the repo does not
   * define its script. Null is not a number the code earned — it means karst had
   * no question to ask, so the gate says nothing about the ticket either way.
   */
  exitCode: number | null;
  output: string;
  /**
   * When the gate's process started and ended. Both absent for a gate that never
   * ran — it has no duration, and stamping one would read as a zero-length run
   * rather than as "karst had no question to ask".
   */
  startedAt?: string;
  endedAt?: string;
}
```

Create `src/workflow/gates/probe.ts`:

```ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * What karst learned when it looked for a repository's npm scripts.
 *
 * Discriminated deliberately. `readPackageScripts` collapsed four situations into
 * `{}`, so a malformed package.json and a repo with no tests were the same answer
 * — and both produced a vacuous green. They are different questions with
 * different owners: a malformed file is a repository defect an agent can fix, a
 * permission error is environmental and an agent cannot chmod its way out of it.
 */
export type ScriptProbe =
  | { kind: 'ok'; scripts: Record<string, string> }
  | { kind: 'absent' }
  | { kind: 'malformed'; message: string }
  | { kind: 'io-error'; message: string };

/** Read `<cwd>/package.json`'s scripts block, saying WHY when it cannot. */
export function probeScripts(cwd: string): ScriptProbe {
  let raw: string;
  try {
    raw = readFileSync(join(cwd, 'package.json'), 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return { kind: 'absent' };
    const message = error instanceof Error ? error.message : String(error);
    return { kind: 'io-error', message };
  }
  try {
    const parsed = JSON.parse(raw) as { scripts?: Record<string, string> };
    return { kind: 'ok', scripts: parsed.scripts ?? {} };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { kind: 'malformed', message };
  }
}
```

In `src/workflow/gates/scripts.ts`, replace `readPackageScripts` (lines 33–48) with:

```ts
import { probeScripts } from './probe.js';

/**
 * The `scripts` a repo defines, or `{}` when karst could not read them.
 *
 * Kept for review, which has no place to put a richer answer yet. UAT calls
 * `probeScripts` directly, because "why is this empty" is the whole question
 * there — see `uat/gates.ts`.
 */
export function readPackageScripts(cwd: string): Record<string, string> {
  const probe = probeScripts(cwd);
  return probe.kind === 'ok' ? probe.scripts : {};
}
```

Remove the now-unused `readFileSync`/`join` imports at the top of `scripts.ts`.

In `src/workflow/stages/review.ts`, delete the local `GateResult` interface (lines 24–40) and re-export the shared one so nothing downstream has to move:

```ts
import type { GateResult } from '../gates/result.js';

export type { GateResult };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/workflow/gates/ src/workflow/stages/review.test.ts && npm run typecheck`
Expected: PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/workflow/gates/result.ts src/workflow/gates/probe.ts src/workflow/gates/probe.test.ts src/workflow/gates/scripts.ts src/workflow/stages/review.ts
git commit -m "feat: discriminate script probing and share the gate result type"
```

---

### Task 4: Discriminated process outcomes and a run-wide abort signal

`shouldContinue` is polled only *between* stages. One UAT stage is now N gates at up to 15 minutes each, so Stop is inert for up to an hour and reads as a broken button. And `exitCode: null` currently means both "signalled" and "never ran" — a cancel must not read as a gate failure.

**Files:**
- Modify: `src/workflow/gates/run.ts`
- Test: `src/workflow/gates/run.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces, from `src/workflow/gates/run.ts`:
  - `export type ProcessOutcome = { kind: 'completed'; exitCode: number; output: string } | { kind: 'spawnFailed'; message: string; output: string } | { kind: 'timedOut'; output: string } | { kind: 'aborted'; output: string }`
  - `export interface RunProcessOptions extends RunCommandOptions { signal?: AbortSignal }`
  - `export function runProcess(command: string, args: readonly string[], cwd: string, options?: RunProcessOptions): Promise<ProcessOutcome>`
  - `runCommand` keeps its exact current signature and reduction (`spawnFailed`/`timedOut` → `exitCode: 1`), so review is untouched.

- [ ] **Step 1: Write the failing test**

Append to `src/workflow/gates/run.test.ts`:

```ts
import { runProcess } from './run.js';

describe('runProcess', () => {
  it('reports a clean exit as completed with its code', async () => {
    const out = await runProcess('node', ['-e', 'process.exit(3)'], process.cwd());
    expect(out).toMatchObject({ kind: 'completed', exitCode: 3 });
  });

  it('reports a missing binary as spawnFailed, never as a nonzero gate', async () => {
    const out = await runProcess('karst-no-such-binary-xyz', [], process.cwd());
    expect(out.kind).toBe('spawnFailed');
  });

  it('reports an aborted child as aborted, not as a failing gate', async () => {
    const controller = new AbortController();
    const started = runProcess(
      'node',
      ['-e', 'setTimeout(() => {}, 60_000)'],
      process.cwd(),
      { signal: controller.signal },
    );
    setTimeout(() => controller.abort(), 50);
    const out = await started;
    expect(out.kind).toBe('aborted');
  });

  it('resolves aborted immediately when the signal is already aborted', async () => {
    const out = await runProcess('node', ['-e', ''], process.cwd(), {
      signal: AbortSignal.abort(),
    });
    expect(out.kind).toBe('aborted');
  });

  it('runCommand still reduces a spawn failure to exit 1', async () => {
    const r = await runCommand('karst-no-such-binary-xyz', [], process.cwd());
    expect(r.exitCode).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/workflow/gates/run.test.ts`
Expected: FAIL — `runProcess` is not exported.

- [ ] **Step 3: Write minimal implementation**

In `src/workflow/gates/run.ts`, add above `runCommand`:

```ts
/**
 * How a child process ended. Discriminated because `exitCode: null` meant two
 * incompatible things — "signalled" and "never ran" — and a Stop must not read as
 * a gate failure. A `failed` verdict says the code is wrong; an abort says karst
 * stopped asking.
 */
export type ProcessOutcome =
  | { kind: 'completed'; exitCode: number; output: string }
  | { kind: 'spawnFailed'; message: string; output: string }
  | { kind: 'timedOut'; output: string }
  | { kind: 'aborted'; output: string };

export interface RunProcessOptions extends RunCommandOptions {
  /**
   * One controller per driver run, threaded through every phase. Without it Stop
   * is polled only between stages, which for a multi-gate UAT is up to an hour of
   * a button that appears to do nothing.
   */
  signal?: AbortSignal;
}
```

Rewrite the body of the module so `runProcess` holds the logic and `runCommand` reduces it. Replace `runCommand` (lines 38–113) with:

```ts
export function runProcess(
  command: string,
  args: readonly string[],
  cwd: string,
  options: RunProcessOptions = {},
): Promise<ProcessOutcome> {
  return new Promise((resolve) => {
    const timeoutMs = options.timeoutMs ?? DEFAULT_GATE_TIMEOUT_MS;
    const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_GATE_MAX_OUTPUT_BYTES;
    const terminationGraceMs =
      options.terminationGraceMs ?? DEFAULT_GATE_TERMINATION_GRACE_MS;
    const output = new BoundedOutput(Math.max(0, maxOutputBytes));

    // Already aborted: never spawn. Otherwise Stop would start the very child it
    // is cancelling, and the run would pay for a gate nobody is waiting for.
    if (options.signal?.aborted) {
      resolve({ kind: 'aborted', output: output.render() });
      return;
    }

    const p = prepareCommand(command, args);
    const child = spawn(p.command, p.args, {
      cwd,
      windowsVerbatimArguments: p.windowsVerbatimArguments,
      detached: true,
    });

    let settled = false;
    let timedOut = false;
    let aborted = false;
    let terminationDiagnostic = '';
    let deadline: ReturnType<typeof setTimeout> | undefined;
    let terminationDeadline: ReturnType<typeof setTimeout> | undefined;

    const settle = (outcome: ProcessOutcome): void => {
      if (settled) return;
      settled = true;
      if (deadline !== undefined) clearTimeout(deadline);
      if (terminationDeadline !== undefined) clearTimeout(terminationDeadline);
      options.signal?.removeEventListener('abort', onAbort);
      resolve(outcome);
    };

    const terminate = (): void => {
      try {
        if (child.pid === undefined) terminationDiagnostic = '; child pid unavailable';
        else killTree(child.pid);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        terminationDiagnostic = `; termination error: ${message}`;
      }
    };

    function onAbort(): void {
      if (settled) return;
      aborted = true;
      terminate();
      settle({ kind: 'aborted', output: output.render('\nStopped\n') });
    }
    options.signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout?.on('data', (chunk: Buffer) => output.append(chunk));
    child.stderr?.on('data', (chunk: Buffer) => output.append(chunk));

    child.once('error', (err: Error) => {
      if (timedOut || aborted) {
        terminationDiagnostic += `; termination error: ${err.message}`;
        return;
      }
      settle({ kind: 'spawnFailed', message: err.message, output: output.render(err.message) });
    });

    child.once('close', (code) => {
      if (aborted) return;
      if (timedOut) {
        settle({
          kind: 'timedOut',
          output: output.render(
            `\nCommand timed out after ${timeoutMs}ms${terminationDiagnostic}\n`,
          ),
        });
        return;
      }
      // A signalled child reports code null; that is not a pass.
      settle({ kind: 'completed', exitCode: code ?? 1, output: output.render() });
    });

    deadline = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      terminate();
      if (settled) return;
      terminationDeadline = setTimeout(() => {
        terminationDiagnostic += '; child exit was not confirmed';
        settle({
          kind: 'timedOut',
          output: output.render(
            `\nCommand timed out after ${timeoutMs}ms${terminationDiagnostic}\n`,
          ),
        });
      }, Math.max(0, terminationGraceMs));
    }, Math.max(0, timeoutMs));
  });
}

/**
 * The legacy reduction: a `CommandResult` with no way to say "stopped".
 *
 * Kept because review's gate loop reduces every non-completion to exit 1 and the
 * spec puts review's redesign out of scope. UAT calls `runProcess` directly, so
 * an abort there yields no verdict and no attempt rather than a false failure.
 */
export function runCommand(
  command: string,
  args: readonly string[],
  cwd: string,
  options: RunCommandOptions = {},
): Promise<CommandResult> {
  return runProcess(command, args, cwd, options).then((outcome) =>
    outcome.kind === 'completed'
      ? { exitCode: outcome.exitCode, output: outcome.output }
      : { exitCode: 1, output: outcome.output },
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/workflow/gates/run.test.ts && npm run typecheck`
Expected: PASS. The existing "leaves the event loop free while the child runs" guard must still pass — if it does not, `runProcess` has gone synchronous somewhere.

- [ ] **Step 5: Commit**

```bash
git add src/workflow/gates/run.ts src/workflow/gates/run.test.ts
git commit -m "feat: discriminate process outcomes and accept an abort signal"
```

---

### Task 5: Schema v16 — durable blocked columns on `stages`

An exception is not a resting place. Three purely additive columns; absence means "not blocked", so there is nothing to backfill.

**Files:**
- Modify: `src/store/schema.sql:51-61`
- Modify: `src/store/migrations.ts:9` and its tail
- Modify: `src/store/stages.ts:4-57`
- Modify: `src/model/types.ts`
- Modify: `src/store/db.test.ts` (every `user_version` assertion)
- Modify: `CLAUDE.md`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `src/model/types.ts` — `export type BlockerKind = 'nothing-to-run' | 'capability-missing' | 'no-independent-signal' | 'boot-failed' | 'lease-lost'`
  - `Stage` gains `blockedKind: BlockerKind | null`, `blockedReason: string | null`, `blockedAt: string | null`
  - `StagePatch` gains the same three as optional fields; `COLUMN` maps them to `blocked_kind`, `blocked_reason`, `blocked_at`
  - `SCHEMA_VERSION === 16`

- [ ] **Step 1: Write the failing test**

In `src/store/db.test.ts`, add a legacy-upgrade test in the house style beside the existing ones:

```ts
it('migrates a legacy v15 DB by adding the stage blocked columns', () => {
  const file = join(tmp, 'legacy-v15.db');
  const legacy = openStore(file);
  legacy.db.pragma('user_version = 15');
  legacy.close();

  const migrated = openStore(file);
  cleanups.push(() => migrated.close());
  const cols = migrated.db
    .prepare("PRAGMA table_info('stages')")
    .all()
    .map((r) => (r as { name: string }).name);
  expect(cols).toContain('blocked_kind');
  expect(cols).toContain('blocked_reason');
  expect(cols).toContain('blocked_at');
  expect(migrated.db.pragma('user_version', { simple: true })).toBe(16);
});
```

Then change **every** existing `.toBe(15)` `user_version` assertion in that file to `.toBe(16)` — there are 14 of them, at lines 107, 180, 207, 251, 277, 303, 334, 365, 396, 428, 485, 504, 537 and 573. Leave the `legacy.pragma('user_version = N')` *setters* alone; they pin the starting version each test is upgrading from.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/store/db.test.ts`
Expected: FAIL — `expected 15 to be 16`, and the new test fails on the missing `blocked_kind` column.

- [ ] **Step 3: Write minimal implementation**

In `src/store/schema.sql`, extend the `stages` table (keeping the existing columns and PK):

```sql
CREATE TABLE IF NOT EXISTS stages (
  ticket_id     INTEGER NOT NULL,     -- -> tickets.id
  stage_key     TEXT NOT NULL,        -- StageKey (no `fetch` in MVP, C1)
  status        TEXT NOT NULL,        -- pending | running | passed | failed | skipped
  attempt       INTEGER NOT NULL DEFAULT 0,  -- review/fix loop iteration
  verdict       TEXT,
  artifact_path TEXT,
  started_at    TEXT,
  ended_at      TEXT,
  -- v16 blocked columns (kept in sync with migrations.ts v16 ALTERs).
  -- A block is karst saying it could not ASK the question — distinct from a
  -- `failed` verdict, which says the code is wrong. NULL kind = not blocked, so
  -- there is nothing to backfill and no status value had to change.
  blocked_kind   TEXT,                -- BlockerKind; NULL = not blocked
  blocked_reason TEXT,                -- the specific text a human needs
  blocked_at     TEXT,
  PRIMARY KEY (ticket_id, stage_key)
);
```

In `src/store/migrations.ts`, set `export const SCHEMA_VERSION = 16;` and append before `db.pragma(...)`:

```ts
  if (current < 16) {
    // v16 gives a gate stage a durable "karst could not ask" state. Purely
    // additive and guarded on the CURRENT columns, so a fresh DB (already carrying
    // them from schema.sql) skips the step and a re-open is a no-op. Nothing is
    // backfilled: absence IS "not blocked", which is the correct reading of every
    // existing row.
    const cols = tableColumns(db, 'stages');
    if (cols.size > 0) {
      if (!cols.has('blocked_kind')) db.exec('ALTER TABLE stages ADD COLUMN blocked_kind TEXT');
      if (!cols.has('blocked_reason')) db.exec('ALTER TABLE stages ADD COLUMN blocked_reason TEXT');
      if (!cols.has('blocked_at')) db.exec('ALTER TABLE stages ADD COLUMN blocked_at TEXT');
    }
  }
```

In `src/model/types.ts`, append:

```ts
/**
 * Why karst could not ask a stage's question. Distinct from a `failed` verdict:
 * `failed` means the code is wrong and an agent can act; a blocker is
 * environmental — a human frees the port, installs the binary, fixes the config.
 *
 * `attempts-exhausted` is deliberately NOT here: it is entirely about attempts
 * consumed, it does mean the code is wrong, and its resting place (the ticket sits
 * at `fix`, unswept) already exists and needs no state.
 */
export type BlockerKind =
  | 'nothing-to-run'        // Phase 1: every gate returned null
  | 'capability-missing'    // Phase 1: permission/IO error; Phase 2: Playwright, auth digest
  | 'no-independent-signal' // Phase 2 only — a warning in Phase 1
  | 'boot-failed'           // Phase 2
  | 'lease-lost';           // Phase 2
```

In `src/store/stages.ts`, extend `Stage`, `StagePatch`, `StageRow`, `rowToStage` and `COLUMN`:

```ts
export interface Stage {
  // …existing fields unchanged…
  blockedKind: BlockerKind | null;
  blockedReason: string | null;
  blockedAt: string | null;
}

export interface StagePatch {
  // …existing fields unchanged…
  blockedKind?: BlockerKind | null;
  blockedReason?: string | null;
  blockedAt?: string | null;
}

interface StageRow {
  // …existing fields unchanged…
  blocked_kind: string | null;
  blocked_reason: string | null;
  blocked_at: string | null;
}

export function rowToStage(r: StageRow): Stage {
  return {
    // …existing mappings unchanged…
    blockedKind: (r.blocked_kind as BlockerKind | null) ?? null,
    blockedReason: r.blocked_reason,
    blockedAt: r.blocked_at,
  };
}

const COLUMN: Record<keyof StagePatch, string> = {
  // …existing entries unchanged…
  blockedKind: 'blocked_kind',
  blockedReason: 'blocked_reason',
  blockedAt: 'blocked_at',
};
```

Add `import type { BlockerKind, StageKey, StageStatus } from '../model/types.js';` at the top of `stages.ts`.

In `CLAUDE.md`, correct the stale count in the "New schema column checklist" bullet: replace "(9 hardcoded `user_version` literals)" with "(14 hardcoded `user_version` assertions across 29 occurrences)".

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/store/ && npm run typecheck`
Expected: PASS. `EXPECTED_TABLES` is untouched — v16 adds no tables.

- [ ] **Step 5: Commit**

```bash
git add src/store/schema.sql src/store/migrations.ts src/store/stages.ts src/store/db.test.ts src/model/types.ts CLAUDE.md
git commit -m "feat: add durable blocked columns to stages (schema v16)"
```

---

### Task 6: `parkGateStage` — a block that commits with its evidence

A second writer into `gate_runs`, transactional like the first, reading `attempt` before any bump. It records what ran, why karst stopped, and sets the persisted block — **without** transitioning and **without** consuming an attempt.

**Files:**
- Create: `src/store/stageBlocks.ts`
- Create: `src/store/stageBlocks.test.ts`
- Modify: `CLAUDE.md`

**Interfaces:**
- Consumes: `BlockerKind` and the `stages` blocked columns (Task 5); `recordGateRun` / `GateRunBatch` from `src/store/gateRuns.ts`; `setStage` / `stageAttempt` from `src/store/stages.ts`.
- Produces, from `src/store/stageBlocks.ts`:
  - `export interface StageBlock { kind: BlockerKind; reason: string; at: string }`
  - `export interface ParkGateStageInput { ticketId: number; stageKey: StageKey; kind: BlockerKind; reason: string; runAt: string; gates: GateRunBatch['gates'] }`
  - `export function parkGateStage(store: Store, input: ParkGateStageInput): void`
  - `export function stageBlock(store: Store, ticketId: number, stageKey: StageKey): StageBlock | null`
  - `export function clearStageBlock(store: Store, ticketId: number, stageKey: StageKey): void`

- [ ] **Step 1: Write the failing test**

Create `src/store/stageBlocks.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openStore, type Store } from './db.js';
import { createTicketFlow } from '../workflow/stages/create.js';
import { getTicket } from './tickets.js';
import { transition } from '../workflow/machine.js';
import { listGateRuns } from './gateRuns.js';
import { parkGateStage, stageBlock, clearStageBlock } from './stageBlocks.js';

describe('parkGateStage', () => {
  let store: Store;
  let id: number;

  beforeEach(() => {
    store = openStore(':memory:');
    id = createTicketFlow(store, { key: 'T-1', title: 't' }).id;
    transition(store, id, 'scope', { kind: 'passed' });
    transition(store, id, 'impl', { kind: 'passed' });
  });
  afterEach(() => store.close());

  it('persists the blocker without transitioning or consuming an attempt', () => {
    parkGateStage(store, {
      ticketId: id,
      stageKey: 'uat',
      kind: 'nothing-to-run',
      reason: 'no test, test:integration, e2e, test:e2e, cypress or playwright script',
      runAt: '2026-07-30T10:00:00.000Z',
      gates: [],
    });

    const ticket = getTicket(store, id);
    expect(ticket.stageCurrent).toBe('uat');
    const uat = ticket.stages.find((s) => s.stageKey === 'uat')!;
    expect(uat.attempt).toBe(0);
    expect(uat.blockedKind).toBe('nothing-to-run');
    expect(uat.blockedReason).toContain('cypress');
    expect(uat.blockedAt).toBe('2026-07-30T10:00:00.000Z');
  });

  it('files gate evidence under the attempt that ran', () => {
    parkGateStage(store, {
      ticketId: id,
      stageKey: 'uat',
      kind: 'capability-missing',
      reason: 'cannot read package.json: EACCES',
      runAt: '2026-07-30T10:00:00.000Z',
      gates: [{ gateName: 'test', exitCode: null, startedAt: null, endedAt: null }],
    });
    const runs = listGateRuns(store, id);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ stageKey: 'uat', gateName: 'test', attempt: 0 });
  });

  it('commits the block and the evidence together or not at all', () => {
    expect(() =>
      parkGateStage(store, {
        ticketId: id,
        stageKey: 'uat',
        kind: 'nothing-to-run',
        reason: 'x',
        runAt: '2026-07-30T10:00:00.000Z',
        // A gate name of the wrong type forces the INSERT to throw mid-transaction.
        gates: [{ gateName: { bad: true } as unknown as string, exitCode: null, startedAt: null, endedAt: null }],
      }),
    ).toThrow();
    expect(stageBlock(store, id, 'uat')).toBeNull();
    expect(listGateRuns(store, id)).toHaveLength(0);
  });

  it('reads back and clears a block', () => {
    parkGateStage(store, {
      ticketId: id, stageKey: 'uat', kind: 'nothing-to-run',
      reason: 'nothing to run', runAt: '2026-07-30T10:00:00.000Z', gates: [],
    });
    expect(stageBlock(store, id, 'uat')).toEqual({
      kind: 'nothing-to-run', reason: 'nothing to run', at: '2026-07-30T10:00:00.000Z',
    });
    clearStageBlock(store, id, 'uat');
    expect(stageBlock(store, id, 'uat')).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/store/stageBlocks.test.ts`
Expected: FAIL — cannot resolve `./stageBlocks.js`.

- [ ] **Step 3: Write minimal implementation**

Create `src/store/stageBlocks.ts`:

```ts
import type { Store } from './db.js';
import type { BlockerKind, StageKey } from '../model/types.js';
import { setStage, stageAttempt } from './stages.js';
import { recordGateRun, type GateRunBatch } from './gateRuns.js';

/** A stage's persisted "karst could not ask" state. */
export interface StageBlock {
  kind: BlockerKind;
  reason: string;
  at: string;
}

export interface ParkGateStageInput {
  ticketId: number;
  stageKey: StageKey;
  kind: BlockerKind;
  reason: string;
  runAt: string;
  /** Whatever partial evidence exists. Empty is legitimate — nothing ran. */
  gates: GateRunBatch['gates'];
}

/**
 * Park a gate stage: record the evidence and the blocker in ONE transaction,
 * without transitioning and without touching `attempt`.
 *
 * Why not just throw and let the driver catch it: an exception is not a resting
 * place. `transition(null)` throws, the throw escapes to the host's catch, the
 * ticket is still at `uat`, and `ticketsToSweep` selects any ticket at a gate
 * stage — so the next window activation re-runs the whole failed stage to throw
 * in the same place, forever, across restarts, with no UI state to show for it.
 *
 * No attempt is consumed because nothing about the code was learned: the question
 * failed to be ASKED. Consuming one would spend the fix budget on a missing
 * script.
 *
 * This makes `gate_runs` a two-writer table — `transition`'s `premutate` and this
 * function. Both are transactional, both read `attempt` BEFORE any bump, so a
 * run is always filed under the attempt that ran.
 */
export function parkGateStage(store: Store, input: ParkGateStageInput): void {
  const apply = store.db.transaction(() => {
    if (input.gates.length > 0) {
      recordGateRun(store, {
        ticketId: input.ticketId,
        stageKey: input.stageKey,
        // Read before anything else touches the row. Nothing bumps it here, but
        // the ordering is the invariant, not the arithmetic.
        attempt: stageAttempt(store, input.ticketId, input.stageKey),
        runAt: input.runAt,
        gates: input.gates,
      });
    }
    setStage(store, input.ticketId, input.stageKey, {
      blockedKind: input.kind,
      blockedReason: input.reason,
      blockedAt: input.runAt,
    });
  });
  apply();
}

/** The stage's current block, or null when it is not blocked. */
export function stageBlock(
  store: Store,
  ticketId: number,
  stageKey: StageKey,
): StageBlock | null {
  const row = store.db
    .prepare(
      'SELECT blocked_kind, blocked_reason, blocked_at FROM stages WHERE ticket_id = ? AND stage_key = ?',
    )
    .get(ticketId, stageKey) as
    | { blocked_kind: string | null; blocked_reason: string | null; blocked_at: string | null }
    | undefined;
  if (!row?.blocked_kind) return null;
  return {
    kind: row.blocked_kind as BlockerKind,
    reason: row.blocked_reason ?? '',
    at: row.blocked_at ?? '',
  };
}

/**
 * Clear a block — the explicit Resume path. A fresh run must also call this
 * before it starts, or a ticket that a human unblocked would keep its stale
 * blocker text on the row after passing.
 */
export function clearStageBlock(store: Store, ticketId: number, stageKey: StageKey): void {
  setStage(store, ticketId, stageKey, {
    blockedKind: null,
    blockedReason: null,
    blockedAt: null,
  });
}
```

In `CLAUDE.md`, widen the gate-evidence invariant. Replace "Both are written inside the caller's transaction (`transition`'s `premutate`)" with:

> Both are written inside a transaction that commits with the stage outcome, whether that outcome is a verdict (`transition`'s `premutate`) or a block (`parkGateStage`, `store/stageBlocks.ts`) — `gate_runs` has two writers and both read `attempt` BEFORE any bump

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/store/stageBlocks.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/store/stageBlocks.ts src/store/stageBlocks.test.ts CLAUDE.md
git commit -m "feat: park a gate stage transactionally instead of throwing"
```

---

### Task 7: `StageRunResult` — the driver stops on a block

The runner returns what happened instead of always implying a transition, the driver branches on it, and the activation sweep stops re-selecting a blocked ticket.

**Files:**
- Modify: `src/model/types.ts`
- Modify: `src/workflow/driver.ts`
- Modify: `src/workflow/driverController.ts:25-29`
- Test: `src/workflow/driver.test.ts`, `src/workflow/driverController.test.ts`

**Interfaces:**
- Consumes: `BlockerKind` (Task 5).
- Produces:
  - `src/model/types.ts` — `export type StageRunResult = { kind: 'advanced'; next: StageKey } | { kind: 'blocked'; blocker: BlockerKind; reason: string } | { kind: 'stopped' }`
  - `StageDriverDeps.runUat` and `.runReview` change type to `(ticketId: number, cwd: string) => Promise<StageRunResult>`
  - `ticketsToSweep(tickets: readonly { id: number; stageCurrent: string | null; stages: readonly { stageKey: string; blockedKind: string | null }[] }[]): number[]`

- [ ] **Step 1: Write the failing test**

Append to `src/workflow/driver.test.ts`:

```ts
it('halts at a blocked stage without looping or transitioning', async () => {
  const store = openStore(':memory:');
  const id = createTicketFlow(store, { key: 'T-3', title: 't' }).id;
  transition(store, id, 'scope', { kind: 'passed' });
  transition(store, id, 'impl', { kind: 'passed' });

  let uatRuns = 0;
  const outcome = await runStageDriver(
    {
      store,
      worktreeFor: () => '/wt',
      onProgress: () => {},
      shouldContinue: () => true,
      runUat: async () => {
        uatRuns += 1;
        return { kind: 'blocked', blocker: 'nothing-to-run', reason: 'no scripts' };
      },
      runReview: async () => ({ kind: 'advanced', next: 'ship' }),
    },
    id,
  );

  expect(uatRuns).toBe(1);
  expect(outcome).toEqual({ stage: 'uat', status: 'blocked', reason: 'nothing-to-run: no scripts' });
  store.close();
});

it('halts when a runner reports it was stopped mid-stage', async () => {
  const store = openStore(':memory:');
  const id = createTicketFlow(store, { key: 'T-4', title: 't' }).id;
  transition(store, id, 'scope', { kind: 'passed' });
  transition(store, id, 'impl', { kind: 'passed' });

  const outcome = await runStageDriver(
    {
      store,
      worktreeFor: () => '/wt',
      onProgress: () => {},
      shouldContinue: () => true,
      runUat: async () => ({ kind: 'stopped' }),
      runReview: async () => ({ kind: 'advanced', next: 'ship' }),
    },
    id,
  );

  expect(outcome).toEqual({ stage: 'uat', status: 'stopped' });
  store.close();
});
```

Append to `src/workflow/driverController.test.ts`:

```ts
describe('ticketsToSweep with blocked stages', () => {
  it('selects a ticket parked at an unblocked gate', () => {
    expect(
      ticketsToSweep([
        { id: 1, stageCurrent: 'uat', stages: [{ stageKey: 'uat', blockedKind: null }] },
      ]),
    ).toEqual([1]);
  });

  it('does NOT select a ticket whose current gate is blocked', () => {
    expect(
      ticketsToSweep([
        { id: 1, stageCurrent: 'uat', stages: [{ stageKey: 'uat', blockedKind: 'nothing-to-run' }] },
      ]),
    ).toEqual([]);
  });

  it('ignores a block recorded on a stage the ticket has moved past', () => {
    expect(
      ticketsToSweep([
        {
          id: 1,
          stageCurrent: 'review',
          stages: [
            { stageKey: 'uat', blockedKind: 'nothing-to-run' },
            { stageKey: 'review', blockedKind: null },
          ],
        },
      ]),
    ).toEqual([1]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/workflow/driver.test.ts src/workflow/driverController.test.ts`
Expected: FAIL — the driver ignores the returned object and loops forever (test times out), and `ticketsToSweep` returns `[1]` for the blocked case.

- [ ] **Step 3: Write minimal implementation**

In `src/model/types.ts`, append:

```ts
/**
 * What one stage run did. A runner no longer implies a transition by returning:
 * it says whether it advanced the ticket, could not ask the question at all, or
 * was stopped. `blocked` and `stopped` both mean no verdict and no attempt.
 */
export type StageRunResult =
  | { kind: 'advanced'; next: StageKey }
  | { kind: 'blocked'; blocker: BlockerKind; reason: string }
  | { kind: 'stopped' };
```

In `src/workflow/driver.ts`, change the deps and the loop:

```ts
import type { StageKey, StageRunResult } from '../model/types.js';

export interface StageDriverDeps {
  store: Store;
  runUat: (ticketId: number, cwd: string) => Promise<StageRunResult>;
  runReview: (ticketId: number, cwd: string) => Promise<StageRunResult>;
  worktreeFor: (ticketId: number) => string | null;
  onProgress: (ticketId: number, stage: StageKey, status: DriverStatus) => void;
  shouldContinue: () => boolean;
}
```

and replace lines 60–63 with:

```ts
    deps.onProgress(ticketId, stage, 'running');
    const result = stage === 'uat'
      ? await deps.runUat(ticketId, cwd)
      : await deps.runReview(ticketId, cwd);

    // A block is a resting place, not an error: the stage stays current, the row
    // carries why, and the sweep skips it until a human clears it.
    if (result.kind === 'blocked') {
      return finish(deps, ticketId, stage, 'blocked', `${result.blocker}: ${result.reason}`);
    }
    if (result.kind === 'stopped') return finish(deps, ticketId, stage, 'stopped');
    // advanced: the runner already transitioned; re-read stage_current and continue.
```

In `src/workflow/driverController.ts`, replace `ticketsToSweep` (lines 18–29) with:

```ts
/**
 * Select the ticket ids the driver should resume — those parked at a
 * deterministic gate that is NOT blocked.
 *
 * The blocked check is what makes parking durable. Without it a blocked ticket is
 * re-selected on every window activation and the whole failed stage runs again to
 * park in the same place, forever.
 */
export function ticketsToSweep(
  tickets: readonly {
    id: number;
    stageCurrent: string | null;
    stages: readonly { stageKey: string; blockedKind: string | null }[];
  }[],
): number[] {
  return tickets
    .filter((t) => {
      if (!shouldStartDriver(t.stageCurrent as StageKey)) return false;
      const current = t.stages.find((s) => s.stageKey === t.stageCurrent);
      return !current?.blockedKind;
    })
    .map((t) => t.id);
}
```

Existing `driverController.test.ts` cases that pass `{ id, stageCurrent }` without `stages` need `stages: []` added — a ticket with no stage rows is not blocked, which is the correct reading.

`src/extension.ts:1183` needs no change: `listTickets` already returns `TicketWithStages`, and `Stage.blockedKind` landed in Task 5. Confirm with `npm run typecheck`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/workflow/ && npm run typecheck`
Expected: PASS. `extension.ts` will still fail to typecheck if `runUat`/`runReview` wrappers there return `StageKey` — that is Task 14; if it blocks progress now, temporarily wrap them as `.then(() => ({ kind: 'advanced', next: getTicket(localStore, id).stageCurrent as StageKey }))` and note it in the commit body.

- [ ] **Step 5: Commit**

```bash
git add src/model/types.ts src/workflow/driver.ts src/workflow/driver.test.ts src/workflow/driverController.ts src/workflow/driverController.test.ts src/extension.ts
git commit -m "feat: stop the driver on a blocked stage and exclude it from the sweep"
```

---

### Task 8: One attempt budget per gate stage

`stages.attempt` is already per `(ticket_id, stage_key)` — that is *storage*. `countFixAttempts` is the *policy*, and it sums `uat` + `review` into one counter. Two review failures currently leave UAT one attempt.

**Files:**
- Modify: `src/workflow/fixAttempts.ts`
- Modify: `src/extension.ts:1071-1078`
- Test: `src/workflow/fixAttempts.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces, from `src/workflow/fixAttempts.ts`:
  - `export type GateStageKey = 'uat' | 'review'` — Task 14 imports this by name
  - `export function countFixAttempts(stages: readonly { stageKey: string; attempt?: number }[], stageKey: GateStageKey): number`
  - `export function lastFailedGate(stages: readonly { stageKey: string; status?: string; endedAt?: string | null }[]): 'uat' | 'review' | null`
  - `export function fixAttemptsRemain(attempts: number, cap?: number): boolean` — `cap` defaults to `FIX_ATTEMPT_CAP`
  - `FIX_ATTEMPT_CAP` unchanged at 3

- [ ] **Step 1: Write the failing test**

Replace the body of `src/workflow/fixAttempts.test.ts` with (keeping its imports):

```ts
import { countFixAttempts, lastFailedGate, fixAttemptsRemain, FIX_ATTEMPT_CAP } from './fixAttempts.js';

describe('countFixAttempts', () => {
  it('counts one gate stage only', () => {
    const stages = [
      { stageKey: 'uat', attempt: 1 },
      { stageKey: 'review', attempt: 2 },
    ];
    expect(countFixAttempts(stages, 'uat')).toBe(1);
    expect(countFixAttempts(stages, 'review')).toBe(2);
  });

  // This is the test that fails against today's code, which is the point.
  it('interleaved uat and review failures never move each other counter', () => {
    const stages = [
      { stageKey: 'uat', attempt: 2 },
      { stageKey: 'review', attempt: 2 },
    ];
    expect(countFixAttempts(stages, 'uat')).toBe(2);
    expect(fixAttemptsRemain(countFixAttempts(stages, 'uat'))).toBe(true);
    // Summed, this would be 4 — over the cap of 3 — and UAT would be parked with
    // an attempt it had never spent.
    expect(countFixAttempts(stages, 'uat') + countFixAttempts(stages, 'review')).toBe(4);
  });

  it('treats a missing attempt as zero', () => {
    expect(countFixAttempts([{ stageKey: 'uat' }], 'uat')).toBe(0);
  });
});

describe('lastFailedGate', () => {
  it('names the gate stage that failed most recently', () => {
    expect(
      lastFailedGate([
        { stageKey: 'uat', status: 'failed', endedAt: '2026-07-30T09:00:00.000Z' },
        { stageKey: 'review', status: 'failed', endedAt: '2026-07-30T10:00:00.000Z' },
      ]),
    ).toBe('review');
  });

  it('ignores a gate that did not fail', () => {
    expect(
      lastFailedGate([
        { stageKey: 'uat', status: 'failed', endedAt: '2026-07-30T09:00:00.000Z' },
        { stageKey: 'review', status: 'passed', endedAt: '2026-07-30T10:00:00.000Z' },
      ]),
    ).toBe('uat');
  });

  it('returns null when no gate has failed', () => {
    expect(lastFailedGate([{ stageKey: 'uat', status: 'running', endedAt: null }])).toBeNull();
  });
});

describe('fixAttemptsRemain', () => {
  it('honours a caller-supplied cap for uat.maxFixAttempts', () => {
    expect(fixAttemptsRemain(1, 2)).toBe(true);
    expect(fixAttemptsRemain(2, 2)).toBe(false);
    expect(fixAttemptsRemain(FIX_ATTEMPT_CAP - 1)).toBe(true);
    expect(fixAttemptsRemain(FIX_ATTEMPT_CAP)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/workflow/fixAttempts.test.ts`
Expected: FAIL — `countFixAttempts` takes one argument and sums; `lastFailedGate` is not exported.

- [ ] **Step 3: Write minimal implementation**

Replace `countFixAttempts` and `fixAttemptsRemain` in `src/workflow/fixAttempts.ts` with:

```ts
/** The gate stages that carry their own fix budget. */
const GATE_STAGE_KEYS = ['uat', 'review'] as const;
export type GateStageKey = (typeof GATE_STAGE_KEYS)[number];

/**
 * How many times ONE gate has failed this ticket — the depth of that gate's fix
 * loop.
 *
 * Per stage, not summed. `stages.attempt` was always per `(ticket_id, stage_key)`,
 * but the policy read here summed uat + review into one counter: two review
 * failures left UAT a single attempt for a budget it had never spent. With `fix`
 * returning to `uat`, both gates fail on the same ticket routinely, so the sum
 * exhausts roughly twice as fast as either budget says.
 *
 * The `fix` stage's own `attempt` is always 0 — the machine bumps the stage that
 * FAILED, and fix is only ever passed through.
 */
export function countFixAttempts(
  stages: readonly { stageKey: string; attempt?: number }[],
  stageKey: GateStageKey,
): number {
  return stages.find((s) => s.stageKey === stageKey)?.attempt ?? 0;
}

/**
 * Which gate sent this ticket to `fix` — the one whose budget the resume spends.
 *
 * By latest `endedAt`, not by array order: the stage rows have no ordering
 * contract, and `attempt` cannot break the tie because it only climbs on failure,
 * so a fail-then-pass pair sits at the same number.
 */
export function lastFailedGate(
  stages: readonly { stageKey: string; status?: string; endedAt?: string | null }[],
): GateStageKey | null {
  const failed = stages.filter(
    (s): s is { stageKey: GateStageKey; status?: string; endedAt?: string | null } =>
      s.status === 'failed' && (GATE_STAGE_KEYS as readonly string[]).includes(s.stageKey),
  );
  if (failed.length === 0) return null;
  return failed.reduce((latest, s) =>
    (s.endedAt ?? '') > (latest.endedAt ?? '') ? s : latest,
  ).stageKey;
}

/**
 * True while the ticket still has an auto-resume left after `attempts` failures.
 * `cap` is caller-supplied so UAT can honour `uat.maxFixAttempts` while review
 * keeps `FIX_ATTEMPT_CAP` until its own redesign.
 */
export function fixAttemptsRemain(attempts: number, cap: number = FIX_ATTEMPT_CAP): boolean {
  return attempts < cap;
}
```

In `src/extension.ts`, change `autoResumeFix` (lines 1069–1078) to pick the failing gate's budget:

```ts
  function autoResumeFix(ticketId: number): void {
    const t = getTicket(localStore, ticketId);
    // Which gate's budget this resume spends. No failed gate means nothing sent
    // the ticket here, so there is nothing to resume against.
    const gate = lastFailedGate(t.stages);
    if (!gate) {
      logger.info(`stage driver: ticket ${ticketId} at fix with no failed gate; leaving it`);
      return;
    }
    const cap =
      gate === 'uat'
        ? (currentManifest()?.uat?.maxFixAttempts ?? FIX_ATTEMPT_CAP)
        : FIX_ATTEMPT_CAP;
    const attempts = countFixAttempts(t.stages, gate);
    if (!fixAttemptsRemain(attempts, cap)) {
      logger.info(
        `stage driver: ticket ${ticketId} parked at fix — ${attempts} ${gate} failures, ` +
          `at the cap of ${cap}; leaving it for a human`,
      );
      return;
    }
```

and update the import on line 44 to `import { countFixAttempts, lastFailedGate, fixAttemptsRemain, FIX_ATTEMPT_CAP } from './workflow/fixAttempts.js';`.

`currentManifest()?.uat` does not exist until Task 9. Land Task 8 with `const cap = FIX_ATTEMPT_CAP;` and a `// uat.maxFixAttempts wires in with the manifest block (Task 9)` comment, then complete it in Task 9's step 3.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/workflow/fixAttempts.test.ts && npm run typecheck && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/workflow/fixAttempts.ts src/workflow/fixAttempts.test.ts src/extension.ts
git commit -m "fix: give each gate stage its own fix-attempt budget"
```

---

### Task 9: The `uat:` manifest block

Every field the spec's prose requires, validated at load. `origins` and `authBootstrap` are validated but inert until Phase 2 — declaring them early is harmless and omitting them is the default.

**Files:**
- Modify: `src/manifest/types.ts`
- Create: `src/manifest/validate/uat.ts`
- Create: `src/manifest/validate/uat.test.ts`
- Modify: `src/manifest/schema.ts:352+`
- Modify: `src/manifest/write.ts:146+`
- Modify: `src/manifest/fixtures.ts`
- Modify: `src/extension.ts` (complete Task 8's `cap`)
- Test: `src/manifest/load.test.ts`, `src/manifest/writeManifest.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces, in `src/manifest/types.ts`:

```ts
export type UatGateKind = 'script' | 'command';
export interface UatGateDef {
  name: string;
  kind: UatGateKind;
  script?: string;          // kind: 'script' — the package.json script
  command?: string;         // kind: 'command' — the binary, spawned without a shell
  args?: string[];          // kind: 'command'
  repo?: string;            // manifest repository name; absent = every target
  report?: string;          // repo-relative report path, inert in Phase 1
}
export interface UatAuthBootstrap { path: string; secrets: string[] }
export interface UatAuthor { agent?: string; enabled: boolean }
export interface UatRepositoryOverride {
  env?: Record<string, string>;
  secrets?: string[];
  gates?: UatGateDef[];
  testDir?: string;
}
export interface UatConfig {
  testDir?: string;
  maxFixAttempts: number;
  gates?: UatGateDef[];
  env: Record<string, string>;
  secrets: string[];
  passthrough: string[];
  origins: string[];
  authBootstrap?: UatAuthBootstrap;
  author?: UatAuthor;
  repositories: Record<string, UatRepositoryOverride>;
}
```
  plus `uat?: UatConfig` on `Manifest`.
- Also produces: `export function validateUat(raw: unknown): UatConfig | undefined` and `export function uatEnvWarnings(config: UatConfig): string[]` from `src/manifest/validate/uat.ts`; `export function uat(over?: Partial<UatConfig>): UatConfig` from `src/manifest/fixtures.ts`.

- [ ] **Step 1: Write the failing test**

Create `src/manifest/validate/uat.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { validateUat, uatEnvWarnings } from './uat.js';

describe('validateUat', () => {
  it('returns undefined for an absent block', () => {
    expect(validateUat(undefined)).toBeUndefined();
  });

  it('defaults every collection and maxFixAttempts', () => {
    expect(validateUat({})).toEqual({
      maxFixAttempts: 3,
      env: {},
      secrets: [],
      passthrough: [],
      origins: [],
      repositories: {},
    });
  });

  it('parses a script gate and a shell-free command gate', () => {
    const config = validateUat({
      gates: [
        { name: 'test', kind: 'script', script: 'test' },
        { name: 'gotest', kind: 'command', command: 'go', args: ['test', './...'], repo: 'api' },
      ],
    });
    expect(config?.gates).toEqual([
      { name: 'test', kind: 'script', script: 'test' },
      { name: 'gotest', kind: 'command', command: 'go', args: ['test', './...'], repo: 'api' },
    ]);
  });

  it('refuses a script gate with no script and a command gate with no command', () => {
    expect(() => validateUat({ gates: [{ name: 'x', kind: 'script' }] })).toThrow(/script/);
    expect(() => validateUat({ gates: [{ name: 'x', kind: 'command' }] })).toThrow(/command/);
  });

  it('refuses a gate kind it does not know', () => {
    expect(() => validateUat({ gates: [{ name: 'x', kind: 'shell', command: 'sh' }] })).toThrow(
      /uat.gates "x".kind must be one of: script, command/,
    );
  });

  // The strictness that matters: an ignored key here is a live credential in git.
  it('refuses uat.secrets as a mapping and any entry carrying a value', () => {
    expect(() => validateUat({ secrets: { STRIPE_SECRET_KEY: 'sk_live_x' } })).toThrow(
      /uat.secrets must be a list of key names/,
    );
    expect(() => validateUat({ secrets: [{ STRIPE_SECRET_KEY: 'sk_live_x' }] })).toThrow(
      /uat.secrets must be a list of key names/,
    );
  });

  it('applies the same strictness to passthrough', () => {
    expect(() => validateUat({ passthrough: { A: 'b' } })).toThrow(/uat.passthrough/);
  });

  it('accepts uat.env as a mapping of non-secret literals', () => {
    expect(validateUat({ env: { SMTP_HOST: '127.0.0.1' } })?.env).toEqual({
      SMTP_HOST: '127.0.0.1',
    });
  });

  it('refuses an origin that is not an absolute URL', () => {
    expect(() => validateUat({ origins: ['localhost:5173'] })).toThrow(/uat.origins/);
    expect(validateUat({ origins: ['http://localhost:5173'] })?.origins).toEqual([
      'http://localhost:5173',
    ]);
  });

  it('refuses a non-positive maxFixAttempts', () => {
    expect(() => validateUat({ maxFixAttempts: 0 })).toThrow(/uat.maxFixAttempts/);
  });

  it('parses per-repository overrides', () => {
    expect(validateUat({ repositories: { web: { env: { VITE_MODE: 'uat' } } } })?.repositories).toEqual(
      { web: { env: { VITE_MODE: 'uat' } } },
    );
  });
});

describe('uatEnvWarnings', () => {
  it('warns when a uat.env value looks like a credential', () => {
    const config = validateUat({ env: { KEY: 'sk_live_abc123', MODE: 'test' } })!;
    const warnings = uatEnvWarnings(config);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('KEY');
  });

  it('says nothing about an ordinary literal', () => {
    expect(uatEnvWarnings(validateUat({ env: { SMTP_HOST: '127.0.0.1' } })!)).toEqual([]);
  });
});
```

In `src/manifest/writeManifest.test.ts`, extend the existing `'round-trips every modeled section without dropping fields'` test (line 102) rather than adding a new one — that test is the guard CLAUDE.md names, so the new section belongs inside it. Add to the `full: Manifest` literal, beside `conventions`:

```ts
        uat: {
          testDir: 'e2e/karst',
          maxFixAttempts: 2,
          gates: [
            { name: 'test', kind: 'script', script: 'test' },
            { name: 'gotest', kind: 'command', command: 'go', args: ['test', './...'], repo: 'backend' },
          ],
          env: { SMTP_HOST: '127.0.0.1' },
          secrets: ['STRIPE_SECRET_KEY'],
          passthrough: ['CUSTOM_REGISTRY_TOKEN'],
          origins: ['http://localhost:5173'],
          authBootstrap: { path: 'e2e/auth.setup.ts', secrets: ['UAT_ACCOUNT_PASSWORD'] },
          author: { agent: 'uat-author', enabled: true },
          repositories: { backend: { env: { VITE_MODE: 'uat' } } },
        },
```

The test's existing assertion compares the reloaded manifest to `full`, so no new assertion is needed — a dropped `uat` overlay fails it.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/manifest/`
Expected: FAIL — cannot resolve `./uat.js`; `uat` is not exported from fixtures.

- [ ] **Step 3: Write minimal implementation**

Create `src/manifest/validate/uat.ts`:

```ts
import { ManifestError } from '../error.js';
import type {
  UatAuthBootstrap,
  UatAuthor,
  UatConfig,
  UatGateDef,
  UatGateKind,
  UatRepositoryOverride,
} from '../types.js';

const GATE_KINDS: readonly UatGateKind[] = ['script', 'command'];

/** Value shapes that read as a pasted credential rather than a config literal. */
const CREDENTIAL_PREFIXES = ['sk_live_', 'sk_test_', 'ghp_', 'AKIA', 'SG.'];
const HIGH_ENTROPY = /^[A-Za-z0-9_\-+/=]{32,}$/;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function stringMap(raw: unknown, where: string): Record<string, string> {
  if (raw === undefined) return {};
  if (!isObject(raw)) throw new ManifestError(`${where} must be a mapping`);
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value !== 'string') {
      throw new ManifestError(`${where} "${key}" must be a string`);
    }
    out[key] = value;
  }
  return out;
}

/**
 * A list of bare key NAMES.
 *
 * Strict where the rest of `schema.ts` is permissive, and deliberately so: house
 * style hand-picks known fields and ignores the rest, which is inert everywhere
 * else. Here an ignored key means a live credential committed to git, because
 * `karst.yml` is a committed file. A mapping — or a list entry carrying a value —
 * is refused with the field named rather than quietly dropped.
 */
function keyNameList(raw: unknown, where: string): string[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    throw new ManifestError(`${where} must be a list of key names, never a mapping with values`);
  }
  return raw.map((entry) => {
    if (typeof entry !== 'string' || entry.trim().length === 0) {
      throw new ManifestError(`${where} must be a list of key names, never a mapping with values`);
    }
    return entry;
  });
}

function validateGate(raw: unknown, index: number): UatGateDef {
  if (!isObject(raw)) throw new ManifestError(`uat.gates[${index}] must be a mapping`);
  const name = raw.name;
  if (typeof name !== 'string' || name.trim().length === 0) {
    throw new ManifestError(`uat.gates[${index}].name must be a non-empty string`);
  }
  const kind = raw.kind;
  if (typeof kind !== 'string' || !GATE_KINDS.includes(kind as UatGateKind)) {
    throw new ManifestError(`uat.gates "${name}".kind must be one of: ${GATE_KINDS.join(', ')}`);
  }
  const gate: UatGateDef = { name, kind: kind as UatGateKind };

  if (kind === 'script') {
    if (typeof raw.script !== 'string' || raw.script.trim().length === 0) {
      throw new ManifestError(`uat.gates "${name}".script must be a non-empty string`);
    }
    gate.script = raw.script;
  } else {
    // argv-based and spawned without a shell, so there is no quoting surface.
    // This is `kind: script`'s sibling, not a scripting language — it is what
    // keeps UAT usable by Go, Rust, Java and Python repositories.
    if (typeof raw.command !== 'string' || raw.command.trim().length === 0) {
      throw new ManifestError(`uat.gates "${name}".command must be a non-empty string`);
    }
    gate.command = raw.command;
    if (raw.args !== undefined) {
      if (!Array.isArray(raw.args) || raw.args.some((a) => typeof a !== 'string')) {
        throw new ManifestError(`uat.gates "${name}".args must be a list of strings`);
      }
      gate.args = raw.args as string[];
    }
  }

  if (raw.repo !== undefined) {
    if (typeof raw.repo !== 'string') {
      throw new ManifestError(`uat.gates "${name}".repo must be a string`);
    }
    gate.repo = raw.repo;
  }
  if (raw.report !== undefined) {
    if (typeof raw.report !== 'string') {
      throw new ManifestError(`uat.gates "${name}".report must be a string`);
    }
    gate.report = raw.report;
  }
  return gate;
}

function validateGates(raw: unknown): UatGateDef[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) throw new ManifestError('uat.gates must be a list');
  return raw.map(validateGate);
}

function validateOrigins(raw: unknown): string[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new ManifestError('uat.origins must be a list');
  return raw.map((entry) => {
    if (typeof entry !== 'string') throw new ManifestError('uat.origins must be a list of URLs');
    let url: URL;
    try {
      url = new URL(entry);
    } catch {
      throw new ManifestError(`uat.origins "${entry}" must be an absolute URL with a scheme`);
    }
    // Compared as parsed scheme + host + port, never as a prefix, so
    // "https://api.stripe.com" cannot match "https://api.stripe.com.evil.test".
    return url.origin;
  });
}

function validateAuthBootstrap(raw: unknown): UatAuthBootstrap | undefined {
  if (raw === undefined) return undefined;
  if (!isObject(raw)) throw new ManifestError('uat.authBootstrap must be a mapping');
  if (typeof raw.path !== 'string' || raw.path.trim().length === 0) {
    throw new ManifestError('uat.authBootstrap.path must be a non-empty string');
  }
  return { path: raw.path, secrets: keyNameList(raw.secrets, 'uat.authBootstrap.secrets') };
}

function validateAuthor(raw: unknown): UatAuthor | undefined {
  if (raw === undefined) return undefined;
  if (!isObject(raw)) throw new ManifestError('uat.author must be a mapping');
  const author: UatAuthor = { enabled: raw.enabled !== false };
  if (raw.agent !== undefined) {
    if (typeof raw.agent !== 'string') throw new ManifestError('uat.author.agent must be a string');
    author.agent = raw.agent;
  }
  return author;
}

function validateRepositories(raw: unknown): Record<string, UatRepositoryOverride> {
  if (raw === undefined) return {};
  if (!isObject(raw)) throw new ManifestError('uat.repositories must be a mapping');
  const out: Record<string, UatRepositoryOverride> = {};
  for (const [name, value] of Object.entries(raw)) {
    if (!isObject(value)) throw new ManifestError(`uat.repositories "${name}" must be a mapping`);
    const override: UatRepositoryOverride = {};
    if (value.env !== undefined) override.env = stringMap(value.env, `uat.repositories "${name}".env`);
    if (value.secrets !== undefined) {
      override.secrets = keyNameList(value.secrets, `uat.repositories "${name}".secrets`);
    }
    if (value.gates !== undefined) override.gates = validateGates(value.gates);
    if (value.testDir !== undefined) {
      if (typeof value.testDir !== 'string') {
        throw new ManifestError(`uat.repositories "${name}".testDir must be a string`);
      }
      override.testDir = value.testDir;
    }
    out[name] = override;
  }
  return out;
}

/** Parse the optional `uat:` block. Absent yields the default pipeline. */
export function validateUat(raw: unknown): UatConfig | undefined {
  if (raw === undefined) return undefined;
  if (!isObject(raw)) throw new ManifestError('uat must be a mapping');

  let maxFixAttempts = 3;
  if (raw.maxFixAttempts !== undefined) {
    if (typeof raw.maxFixAttempts !== 'number' || !Number.isInteger(raw.maxFixAttempts) || raw.maxFixAttempts < 1) {
      throw new ManifestError('uat.maxFixAttempts must be a positive integer');
    }
    maxFixAttempts = raw.maxFixAttempts;
  }

  const config: UatConfig = {
    maxFixAttempts,
    env: stringMap(raw.env, 'uat.env'),
    secrets: keyNameList(raw.secrets, 'uat.secrets'),
    passthrough: keyNameList(raw.passthrough, 'uat.passthrough'),
    origins: validateOrigins(raw.origins),
    repositories: validateRepositories(raw.repositories),
  };

  if (raw.testDir !== undefined) {
    if (typeof raw.testDir !== 'string') throw new ManifestError('uat.testDir must be a string');
    config.testDir = raw.testDir;
  }
  const gates = validateGates(raw.gates);
  if (gates !== undefined) config.gates = gates;
  const authBootstrap = validateAuthBootstrap(raw.authBootstrap);
  if (authBootstrap !== undefined) config.authBootstrap = authBootstrap;
  const author = validateAuthor(raw.author);
  if (author !== undefined) config.author = author;

  return config;
}

/**
 * Values in `uat.env` that look like credentials.
 *
 * A warning, never a block, and deliberately outside the validator: it cannot be
 * reliable, and the mistake it catches is the likely one — pasting a value into
 * the wrong block. The host surfaces these; loading never fails on them.
 */
export function uatEnvWarnings(config: UatConfig): string[] {
  return Object.entries(config.env).flatMap(([key, value]) =>
    CREDENTIAL_PREFIXES.some((p) => value.startsWith(p)) || HIGH_ENTROPY.test(value)
      ? [`uat.env "${key}" looks like a credential — declare it under uat.secrets instead`]
      : [],
  );
}
```

In `src/manifest/types.ts`, add the interfaces from the Interfaces block above and `uat?: UatConfig;` to `Manifest`, with this doc comment on the field:

```ts
  /**
   * UAT gates, credentials and (Phase 2) authored-step config. Absent yields the
   * default pipeline: karst probes package.json for known scripts. `origins` and
   * `authBootstrap` are validated at load but inert until Phase 2, so declaring
   * them early is harmless.
   */
  uat?: UatConfig;
```

In `src/manifest/schema.ts`, import `validateUat` and add `uat: validateUat(raw.uat),` to the object `validateManifest` returns.

In `src/manifest/write.ts`, add to the overlay beside `conventions`:

```ts
    // Without this line Save silently drops the whole block — the failure mode
    // the writeManifest round-trip test exists to catch.
    uat: manifest.uat,
```

In `src/manifest/fixtures.ts`, add:

```ts
import type { UatConfig } from './types.js';

/** A uat block. Defaults match `validateUat({})` so tests start from the real default. */
export function uat(over: Partial<UatConfig> = {}): UatConfig {
  return {
    maxFixAttempts: 3,
    env: {},
    secrets: [],
    passthrough: [],
    origins: [],
    repositories: {},
    ...over,
  };
}
```

Finally, complete Task 8's deferred line in `src/extension.ts`:

```ts
    const cap =
      gate === 'uat'
        ? (currentManifest()?.uat?.maxFixAttempts ?? FIX_ATTEMPT_CAP)
        : FIX_ATTEMPT_CAP;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/manifest/ && npm run typecheck`
Expected: PASS, including the existing "round-trips every modeled section" guard.

- [ ] **Step 5: Commit**

```bash
git add src/manifest/types.ts src/manifest/validate/uat.ts src/manifest/validate/uat.test.ts src/manifest/schema.ts src/manifest/write.ts src/manifest/writeManifest.test.ts src/manifest/fixtures.ts src/extension.ts
git commit -m "feat: validate the uat manifest block"
```

---

### Task 10: Resolve and run the UAT gate list

Explicit `uat.gates` always wins; absent, karst probes `package.json` for known scripts. A configured gate whose script is missing is a **failure** (the config names a question the repo cannot answer); a *discovered* one that is absent is `null` (nothing was asked).

**Files:**
- Create: `src/workflow/uat/gates.ts`
- Create: `src/workflow/uat/gates.test.ts`

**Interfaces:**
- Consumes: `ScriptProbe`/`probeScripts` (Task 3), `GateResult` (Task 3), `runProcess`/`ProcessOutcome` (Task 4), `UatConfig`/`UatGateDef` (Task 9), `BlockerKind` (Task 5).
- Produces, from `src/workflow/uat/gates.ts`:
  - `export const PROBE_SCRIPTS: readonly string[]`
  - `export interface ResolvedGate { name: string; command: string; args: readonly string[]; script: string | null; required: boolean }`
  - `export type GateResolution = { kind: 'gates'; gates: ResolvedGate[] } | { kind: 'unavailable'; blocker: BlockerKind; reason: string }`
  - `export function resolveUatGates(probe: ScriptProbe, config: UatConfig | undefined, repoName: string | null): GateResolution`
  - `export interface RunGatesOptions { signal?: AbortSignal; now?: () => string; scriptsAvailable?: (script: string) => boolean }`
  - `export function runUatGates(gates: readonly ResolvedGate[], cwd: string, opts?: RunGatesOptions): Promise<{ kind: 'ran'; results: GateResult[] } | { kind: 'stopped' }>` — `scriptsAvailable` answers whether the repo defines a given script, so a *configured* gate naming a missing one fails by name instead of spawning `npm run` and reading "Missing script" as a code verdict

- [ ] **Step 1: Write the failing test**

Create `src/workflow/uat/gates.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { resolveUatGates, runUatGates, PROBE_SCRIPTS } from './gates.js';
import { uat } from '../../manifest/fixtures.js';

describe('resolveUatGates', () => {
  it('probes package.json when no gates are configured', () => {
    const res = resolveUatGates(
      { kind: 'ok', scripts: { test: 'vitest', e2e: 'playwright test', build: 'tsc' } },
      undefined,
      null,
    );
    expect(res.kind).toBe('gates');
    if (res.kind !== 'gates') return;
    // Cheapest first, in PROBE_SCRIPTS order, and `build` is not a test script.
    expect(res.gates.map((g) => g.name)).toEqual(['test', 'e2e']);
    expect(res.gates.every((g) => g.required === false)).toBe(true);
  });

  it('blocks nothing-to-run when the repo defines no known test script', () => {
    const res = resolveUatGates({ kind: 'ok', scripts: { build: 'tsc' } }, undefined, null);
    expect(res).toMatchObject({ kind: 'unavailable', blocker: 'nothing-to-run' });
    if (res.kind !== 'unavailable') return;
    for (const script of PROBE_SCRIPTS) expect(res.reason).toContain(script);
  });

  it('blocks nothing-to-run when package.json is absent', () => {
    expect(resolveUatGates({ kind: 'absent' }, undefined, null)).toMatchObject({
      kind: 'unavailable',
      blocker: 'nothing-to-run',
    });
  });

  // A malformed package.json is a repository defect an agent can fix; a
  // permission error is environmental and an agent cannot chmod its way out.
  it('makes a malformed package.json a required, failing gate', () => {
    const res = resolveUatGates({ kind: 'malformed', message: 'Unexpected token' }, undefined, null);
    expect(res.kind).toBe('gates');
    if (res.kind !== 'gates') return;
    expect(res.gates).toEqual([]);
  });

  it('blocks capability-missing on an IO error', () => {
    expect(resolveUatGates({ kind: 'io-error', message: 'EACCES' }, undefined, null)).toMatchObject({
      kind: 'unavailable',
      blocker: 'capability-missing',
    });
  });

  it('prefers explicit gates over the probe and marks them required', () => {
    const res = resolveUatGates(
      { kind: 'ok', scripts: { test: 'vitest', e2e: 'playwright test' } },
      uat({ gates: [{ name: 'integration', kind: 'script', script: 'test:integration' }] }),
      null,
    );
    expect(res.kind).toBe('gates');
    if (res.kind !== 'gates') return;
    expect(res.gates).toEqual([
      {
        name: 'integration',
        command: 'npm',
        args: ['run', 'test:integration'],
        script: 'test:integration',
        required: true,
      },
    ]);
  });

  it('renders a command gate as argv with no shell', () => {
    const res = resolveUatGates(
      { kind: 'ok', scripts: {} },
      uat({ gates: [{ name: 'gotest', kind: 'command', command: 'go', args: ['test', './...'] }] }),
      null,
    );
    expect(res.kind).toBe('gates');
    if (res.kind !== 'gates') return;
    expect(res.gates[0]).toEqual({
      name: 'gotest', command: 'go', args: ['test', './...'], script: null, required: true,
    });
  });

  it('keeps only the gates targeting this repository', () => {
    const config = uat({
      gates: [
        { name: 'test', kind: 'script', script: 'test' },
        { name: 'gotest', kind: 'command', command: 'go', args: ['test'], repo: 'api' },
      ],
    });
    const forWeb = resolveUatGates({ kind: 'ok', scripts: { test: 'v' } }, config, 'web');
    expect(forWeb.kind === 'gates' && forWeb.gates.map((g) => g.name)).toEqual(['test']);
    const forApi = resolveUatGates({ kind: 'ok', scripts: { test: 'v' } }, config, 'api');
    expect(forApi.kind === 'gates' && forApi.gates.map((g) => g.name)).toEqual(['test', 'gotest']);
  });
});

describe('runUatGates', () => {
  const now = () => '2026-07-30T10:00:00.000Z';

  it('runs every gate — no short-circuit on the first failure', async () => {
    const out = await runUatGates(
      [
        { name: 'a', command: 'node', args: ['-e', 'process.exit(1)'], script: null, required: true },
        { name: 'b', command: 'node', args: ['-e', 'process.exit(0)'], script: null, required: true },
      ],
      process.cwd(),
      { now },
    );
    expect(out.kind).toBe('ran');
    if (out.kind !== 'ran') return;
    expect(out.results.map((r) => [r.name, r.exitCode])).toEqual([['a', 1], ['b', 0]]);
  });

  it('stamps a duration on a gate that ran and none on one that did not', async () => {
    const out = await runUatGates(
      [
        { name: 'a', command: 'node', args: ['-e', ''], script: null, required: true },
        { name: 'missing', command: '', args: [], script: 'nope', required: false },
      ],
      process.cwd(),
      { now },
    );
    if (out.kind !== 'ran') throw new Error('expected ran');
    expect(out.results[0]!.startedAt).toBe(now());
    expect(out.results[1]!.exitCode).toBeNull();
    expect(out.results[1]!.startedAt).toBeUndefined();
  });

  it('reports stopped when the run is aborted, never a failing gate', async () => {
    const controller = new AbortController();
    const started = runUatGates(
      [{ name: 'slow', command: 'node', args: ['-e', 'setTimeout(()=>{},60000)'], script: null, required: true }],
      process.cwd(),
      { signal: controller.signal, now },
    );
    setTimeout(() => controller.abort(), 50);
    expect((await started).kind).toBe('stopped');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/workflow/uat/gates.test.ts`
Expected: FAIL — cannot resolve `./gates.js`.

- [ ] **Step 3: Write minimal implementation**

Create `src/workflow/uat/gates.ts`:

```ts
import type { BlockerKind } from '../../model/types.js';
import type { UatConfig, UatGateDef } from '../../manifest/types.js';
import type { ScriptProbe } from '../gates/probe.js';
import type { GateResult } from '../gates/result.js';
import { runProcess } from '../gates/run.js';
import { nowIso } from '../../model/time.js';

/**
 * The scripts karst looks for when `uat.gates` is absent, cheapest first.
 *
 * Ordering is a cost argument: `test` (seconds) → integration (tens of seconds) →
 * e2e (minutes), so the cheapest signal fails fastest. Most repositories need no
 * configuration at all, which is the whole point — an explicit list always wins.
 */
export const PROBE_SCRIPTS: readonly string[] = [
  'test',
  'test:integration',
  'e2e',
  'test:e2e',
  'cypress',
  'playwright',
];

export interface ResolvedGate {
  name: string;
  command: string;
  args: readonly string[];
  /** The package.json script this needs, or null for a command gate. */
  script: string | null;
  /**
   * True when the user NAMED this gate. A configured gate whose script is absent
   * is a failure — the config names a question the repo cannot answer. A
   * discovered one that is absent is simply not there, and says nothing.
   */
  required: boolean;
}

export type GateResolution =
  | { kind: 'gates'; gates: ResolvedGate[] }
  | { kind: 'unavailable'; blocker: BlockerKind; reason: string };

function resolveDeclared(gate: UatGateDef): ResolvedGate {
  if (gate.kind === 'command') {
    // Spawned without a shell, so there is no quoting surface to get wrong.
    return {
      name: gate.name,
      command: gate.command!,
      args: gate.args ?? [],
      script: null,
      required: true,
    };
  }
  const script = gate.script!;
  return {
    name: gate.name,
    command: 'npm',
    args: script === 'test' ? ['test'] : ['run', script],
    script,
    required: true,
  };
}

/**
 * Which gates UAT will run against one repository.
 *
 * `null` at the per-gate level and `blocked` at the resolution level are different
 * answers: a gate that never ran says nothing about the ticket, while a repository
 * karst cannot ask ANY question of is not a pass — it is karst reporting that it
 * had nothing to ask, which the aggregate must never convert into green.
 */
export function resolveUatGates(
  probe: ScriptProbe,
  config: UatConfig | undefined,
  repoName: string | null,
): GateResolution {
  // Environmental: an agent cannot chmod its way out of an unreadable repo.
  if (probe.kind === 'io-error') {
    return {
      kind: 'unavailable',
      blocker: 'capability-missing',
      reason: `cannot read package.json: ${probe.message}`,
    };
  }

  const declared = (config?.gates ?? []).filter(
    (g) => g.repo === undefined || repoName === null || g.repo === repoName,
  );
  if (declared.length > 0) return { kind: 'gates', gates: declared.map(resolveDeclared) };

  // A repository defect an agent CAN fix, so it must reach a verdict rather than
  // a block — an empty required set makes the aggregate fail it by name.
  if (probe.kind === 'malformed') return { kind: 'gates', gates: [] };

  const scripts = probe.kind === 'ok' ? probe.scripts : {};
  const discovered = PROBE_SCRIPTS.filter((s) => scripts[s] !== undefined).map<ResolvedGate>(
    (script) => ({
      name: script,
      command: 'npm',
      args: script === 'test' ? ['test'] : ['run', script],
      script,
      required: false,
    }),
  );
  if (discovered.length === 0) {
    return {
      kind: 'unavailable',
      blocker: 'nothing-to-run',
      reason:
        `no uat.gates configured and package.json defines none of: ${PROBE_SCRIPTS.join(', ')}`,
    };
  }
  return { kind: 'gates', gates: discovered };
}

/**
 * Run the gates sequentially in one worktree.
 *
 * Sequential, not `Promise.all`: several npm scripts racing in one worktree fight
 * over the same node_modules and build output, and their interleaved text lands in
 * one unreadable artifact. Each still runs async, so the extension host keeps
 * serving hooks and webviews throughout.
 *
 * No short-circuit on the first failure. The attempt cap makes complete
 * information per attempt worth more than saved minutes: an agent that learns
 * about the unit failure only, fixes it, re-enters and THEN hits the integration
 * failure has spent two of three attempts to learn what one could have told it.
 */
export interface RunGatesOptions {
  signal?: AbortSignal;
  now?: () => string;
  /** Whether the repository defines a given package.json script. */
  scriptsAvailable?: (script: string) => boolean;
}

export async function runUatGates(
  gates: readonly ResolvedGate[],
  cwd: string,
  opts: RunGatesOptions = {},
): Promise<{ kind: 'ran'; results: GateResult[] } | { kind: 'stopped' }> {
  const now = opts.now ?? nowIso;
  const results: GateResult[] = [];
  for (const gate of gates) {
    if (opts.signal?.aborted) return { kind: 'stopped' };
    const startedAt = now();

    if (gate.script !== null && gate.required && opts.scriptsAvailable?.(gate.script) === false) {
      // The config named a question this repo cannot answer. A failure, not null —
      // and agent-fixable, because both the config and the missing script are in
      // the repository. Caught here rather than by spawning `npm run`, whose
      // "Missing script" exit 1 would read as a verdict about the ticket's code.
      results.push({
        name: gate.name,
        exitCode: 1,
        output: `configured gate "${gate.name}" needs a "${gate.script}" script, which package.json does not define`,
        startedAt,
        endedAt: now(),
      });
      continue;
    }

    const outcome = await runProcess(gate.command, gate.args, cwd, { signal: opts.signal });

    if (outcome.kind === 'aborted') return { kind: 'stopped' };
    if (outcome.kind === 'spawnFailed' && !gate.required && gate.script !== null) {
      // A discovered script whose binary vanished between probe and spawn: karst
      // had no question to ask after all, so it stays null rather than becoming a
      // verdict about the ticket's code.
      results.push({
        name: gate.name,
        exitCode: null,
        output: `no "${gate.script}" script available — nothing to run`,
      });
      continue;
    }
    results.push({
      name: gate.name,
      exitCode: outcome.kind === 'completed' ? outcome.exitCode : 1,
      output: outcome.output,
      startedAt,
      endedAt: now(),
    });
  }
  return { kind: 'ran', results };
}
```

Note the `=== false` comparison in that guard, not `!opts.scriptsAvailable?.(...)`: an **absent** `scriptsAvailable` callback must mean "karst did not check", not "the script is missing". With `!`, every caller that omits it would fail every configured gate.

Add this case to `gates.test.ts` in step 1 as well:

```ts
it('fails a configured gate whose script the repo does not define', async () => {
  const out = await runUatGates(
    [{ name: 'integration', command: 'npm', args: ['run', 'test:integration'], script: 'test:integration', required: true }],
    process.cwd(),
    { now, scriptsAvailable: () => false },
  );
  if (out.kind !== 'ran') throw new Error('expected ran');
  expect(out.results[0]).toMatchObject({ exitCode: 1 });
  expect(out.results[0]!.output).toContain('does not define');
});
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/workflow/uat/gates.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/workflow/uat/gates.ts src/workflow/uat/gates.test.ts
git commit -m "feat: resolve and run a real UAT gate list per repository"
```

---

### Task 11: The verdict conjunction, stated once

Rev 4 stated the pass condition three different ways in three sections, and an implementer reading any one of them alone ships the wrong predicate. It lives in one pure function that eats plain objects.

**Files:**
- Create: `src/workflow/uat/aggregate.ts`
- Create: `src/workflow/uat/aggregate.test.ts`

**Interfaces:**
- Consumes: `GateResult` (Task 3), `BlockerKind`/`Verdict` (Tasks 5 and existing).
- Produces, from `src/workflow/uat/aggregate.ts`:
  - `export interface GateIdentity { repo: string; command: string; args: readonly string[] }`
  - `export interface AggregateEntry { result: GateResult; identity: GateIdentity }`
  - `export type AggregateOutcome = { kind: 'verdict'; verdict: Exclude<Verdict, null>; warnings: string[] } | { kind: 'blocked'; blocker: BlockerKind; reason: string }`
  - `export function sameIdentity(a: GateIdentity, b: GateIdentity): boolean`
  - `export function aggregateUat(entries: readonly AggregateEntry[], reviewIdentities: readonly GateIdentity[]): AggregateOutcome`

- [ ] **Step 1: Write the failing test**

Create `src/workflow/uat/aggregate.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { aggregateUat, sameIdentity, type AggregateEntry, type GateIdentity } from './aggregate.js';

const npmTest: GateIdentity = { repo: '/web', command: 'npm', args: ['test'] };
const npmE2e: GateIdentity = { repo: '/web', command: 'npm', args: ['run', 'e2e'] };

function entry(name: string, exitCode: number | null, identity: GateIdentity): AggregateEntry {
  return { result: { name, exitCode, output: '' }, identity };
}

describe('aggregateUat', () => {
  it('passes when every gate that ran exits 0 and one identity is independent', () => {
    const out = aggregateUat([entry('e2e', 0, npmE2e)], [npmTest]);
    expect(out).toEqual({ kind: 'verdict', verdict: { kind: 'passed' }, warnings: [] });
  });

  it('fails when any gate that ran exits non-zero, naming the gates', () => {
    const out = aggregateUat(
      [entry('test', 0, npmTest), entry('e2e', 2, npmE2e)],
      [npmTest],
    );
    expect(out).toEqual({
      kind: 'verdict',
      verdict: { kind: 'failed', reason: 'gates failed: e2e' },
      warnings: [],
    });
  });

  it('a null gate neither passes nor fails — it says nothing', () => {
    const out = aggregateUat([entry('test', 0, npmTest), entry('e2e', null, npmE2e)], []);
    expect(out).toMatchObject({ kind: 'verdict', verdict: { kind: 'passed' } });
  });

  // The rule rev 2 got right per-gate and then lost at the aggregate level.
  it('every gate null is NOT a pass — it blocks nothing-to-run', () => {
    const out = aggregateUat([entry('test', null, npmTest)], []);
    expect(out).toMatchObject({ kind: 'blocked', blocker: 'nothing-to-run' });
  });

  it('no gates at all blocks nothing-to-run', () => {
    expect(aggregateUat([], [])).toMatchObject({ kind: 'blocked', blocker: 'nothing-to-run' });
  });

  // Phase 1 warns rather than blocking: the escape hatch is authored steps, which
  // are Phase 2, so blocking here would park every zero-config repository —
  // karst's own included — permanently, with no configuration that clears it.
  it('warns, does not block, when no effective identity is independent of review', () => {
    const out = aggregateUat([entry('test', 0, npmTest)], [npmTest]);
    expect(out.kind).toBe('verdict');
    if (out.kind !== 'verdict') return;
    expect(out.verdict).toEqual({ kind: 'passed' });
    expect(out.warnings).toHaveLength(1);
    expect(out.warnings[0]).toContain('npm test');
  });

  it('compares identities that RAN, so a declared-but-null probe buys nothing', () => {
    // e2e is declared and never ran; the only effective identity is npm test,
    // which review also runs. An explicit `uat.gates: [test]` recreates the
    // original bug exactly and must be caught here, not by a name ban.
    const out = aggregateUat(
      [entry('test', 0, npmTest), entry('e2e', null, npmE2e)],
      [npmTest],
    );
    expect(out.kind === 'verdict' && out.warnings).toHaveLength(1);
  });

  it('compares repository too, so the same command in another repo is independent', () => {
    const out = aggregateUat(
      [entry('test', 0, { repo: '/api', command: 'npm', args: ['test'] })],
      [npmTest],
    );
    expect(out.kind === 'verdict' && out.warnings).toEqual([]);
  });
});

describe('sameIdentity', () => {
  it('compares repository, command and args exactly', () => {
    expect(sameIdentity(npmTest, { ...npmTest })).toBe(true);
    expect(sameIdentity(npmTest, npmE2e)).toBe(false);
    expect(sameIdentity(npmTest, { ...npmTest, repo: '/api' })).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/workflow/uat/aggregate.test.ts`
Expected: FAIL — cannot resolve `./aggregate.js`.

- [ ] **Step 3: Write minimal implementation**

Create `src/workflow/uat/aggregate.ts`:

```ts
import type { BlockerKind, Verdict } from '../../model/types.js';
import type { GateResult } from '../gates/result.js';

/**
 * What a gate invocation actually was — the tuple that decides whether UAT asked
 * a question review does not.
 *
 * Repository is part of it: the same `npm test` in two repositories is two
 * questions, and dropping the repo would make a monorepo's second service look
 * like a duplicate.
 */
export interface GateIdentity {
  repo: string;
  command: string;
  args: readonly string[];
}

export interface AggregateEntry {
  result: GateResult;
  identity: GateIdentity;
}

export type AggregateOutcome =
  | { kind: 'verdict'; verdict: Exclude<Verdict, null>; warnings: string[] }
  | { kind: 'blocked'; blocker: BlockerKind; reason: string };

export function sameIdentity(a: GateIdentity, b: GateIdentity): boolean {
  return (
    a.repo === b.repo &&
    a.command === b.command &&
    a.args.length === b.args.length &&
    a.args.every((arg, i) => arg === b.args[i])
  );
}

function render(identity: GateIdentity): string {
  return `${identity.command} ${identity.args.join(' ')}`.trim();
}

/**
 * Reduce a run's gates to one outcome. **This is the only place the pass
 * condition is stated.**
 *
 * UAT passes iff:
 *   (a) every gate that RAN exits 0, and
 *   (b) at least one gate ran.
 *
 * The third condition — at least one EFFECTIVE gate identity absent from review's
 * set — is recorded as a warning in Phase 1 and becomes blocking in Phase 2, when
 * authored steps give a human a way out. Effective, not declared: a static check
 * over the configured list passes for a repo that defines only `test`, every other
 * probe records null, and the stage reports green having asked nothing new.
 */
export function aggregateUat(
  entries: readonly AggregateEntry[],
  reviewIdentities: readonly GateIdentity[],
): AggregateOutcome {
  const ran = entries.filter((e) => e.result.exitCode !== null);

  // Not a pass. "Nothing ran" means the stage asked nothing, and converting that
  // into green is the bug this whole design exists to close.
  if (ran.length === 0) {
    return {
      kind: 'blocked',
      blocker: 'nothing-to-run',
      reason:
        entries.length === 0
          ? 'no gates resolved for this ticket'
          : `no gate ran: ${entries.map((e) => e.result.name).join(', ')}`,
    };
  }

  const failing = ran.filter((e) => e.result.exitCode !== 0);
  if (failing.length > 0) {
    return {
      kind: 'verdict',
      verdict: { kind: 'failed', reason: `gates failed: ${failing.map((e) => e.result.name).join(', ')}` },
      warnings: [],
    };
  }

  const independent = ran.filter(
    (e) => !reviewIdentities.some((identity) => sameIdentity(identity, e.identity)),
  );
  const warnings =
    independent.length > 0
      ? []
      : [
          'uat asked no question review does not: every gate that ran was ' +
            `${ran.map((e) => render(e.identity)).join(', ')}, which review runs too. ` +
            'Add a uat.gates entry the review stage does not run.',
        ];

  return { kind: 'verdict', verdict: { kind: 'passed' }, warnings };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/workflow/uat/aggregate.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/workflow/uat/aggregate.ts src/workflow/uat/aggregate.test.ts
git commit -m "feat: state the UAT verdict conjunction once, in one pure function"
```

---

### Task 12: Which repositories UAT runs against

`worktreeFor` is `listWorktreesByTicket(store, id)[0]?.path` — and `dashboard.ts:88` orders by path, so a ticket scoping three repositories gets gates on whichever one sorts first alphabetically, every time, for a reason having nothing to do with the ticket.

**Files:**
- Create: `src/workflow/uat/targets.ts`
- Create: `src/workflow/uat/targets.test.ts`

**Interfaces:**
- Consumes: `selectReviewTargets`/`ReviewWorktree` (`src/workflow/gates/targets.ts`), `Manifest`, `GitRunner`.
- Produces, from `src/workflow/uat/targets.ts`:
  - `export interface UatTarget { repo: string; path: string; names: string[] }`
  - `export function planUatTargets(manifest: Manifest, worktrees: readonly ReviewWorktree[], git: GitRunner): Promise<UatTarget[]>`

- [ ] **Step 1: Write the failing test**

Create `src/workflow/uat/targets.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { planUatTargets } from './targets.js';
import { manifest, repo, svc } from '../../manifest/fixtures.js';
import type { GitRunner } from '../../integrations/git.js';

// Every repo reports a change, so selection is not what is under test here.
const changed: GitRunner = async (args) =>
  args[0] === 'status'
    ? { exitCode: 0, stdout: ' M src/a.ts\n', stderr: '' }
    : { exitCode: 0, stdout: '', stderr: '' };

describe('planUatTargets', () => {
  it('deduplicates two repository entries that share one repoPath', async () => {
    const targets = await planUatTargets(
      manifest({
        api: repo({ repoPath: '/mono', service: svc() }),
        worker: repo({ repoPath: '/mono', service: svc() }),
      }),
      [{ repo: '/mono', path: '/wt/mono', baseRef: null }],
      changed,
    );
    // One monorepo, one worktree, one run of npm test — but both names, because
    // service identity stays keyed by repository NAME (distinct ports, distinct
    // servers rows), and evidence has to name a place.
    expect(targets).toHaveLength(1);
    expect(targets[0]!.names.sort()).toEqual(['api', 'worker']);
    expect(targets[0]!.path).toBe('/wt/mono');
  });

  it('returns every affected worktree, not just the alphabetically first', async () => {
    const targets = await planUatTargets(
      manifest({
        api: repo({ repoPath: '/api', service: svc() }),
        web: repo({ repoPath: '/web', service: svc() }),
      }),
      [
        { repo: '/web', path: '/wt/web', baseRef: null },
        { repo: '/api', path: '/wt/api', baseRef: null },
      ],
      changed,
    );
    expect(targets.map((t) => t.path).sort()).toEqual(['/wt/api', '/wt/web']);
  });

  it('includes a non-runnable repository as a gate target', async () => {
    const targets = await planUatTargets(
      manifest({ docs: repo({ repoPath: '/docs' }) }),
      [{ repo: '/docs', path: '/wt/docs', baseRef: null }],
      changed,
    );
    expect(targets).toHaveLength(1);
  });
});
```

The fixture builder is `manifest(repositories, over?)` — repositories is a positional argument, not a field on an overrides object. `repo()` defaults to **non-runnable**; pass `service: svc()` to make it runnable.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/workflow/uat/targets.test.ts`
Expected: FAIL — cannot resolve `./targets.js`.

- [ ] **Step 3: Write minimal implementation**

Create `src/workflow/uat/targets.ts`:

```ts
import type { Manifest } from '../../manifest/types.js';
import type { GitRunner } from '../../integrations/git.js';
import { selectReviewTargets, type ReviewWorktree } from '../gates/targets.js';

/** One repository UAT runs its gates against. */
export interface UatTarget {
  /** The repository path the worktree row carries. */
  repo: string;
  /** The ticket's worktree for that repository — where the gates run. */
  path: string;
  /** Every manifest entry backed by this worktree (several for a monorepo). */
  names: string[];
}

/**
 * The repositories UAT runs against, built once per run.
 *
 * Reuses review's dependency-aware affected-target selection rather than a second
 * implementation: changing `api` can affect `web`, changing unrelated `docs`
 * cannot, and that propagation rule should have exactly one definition.
 *
 * Deduplicated by `repoPath`, because two `repositories:` entries sharing a path
 * are one monorepo with one worktree — running `npm test` twice in the same
 * directory answers the same question twice. Service identity stays keyed by
 * repository NAME, so those same two entries keep distinct ports and distinct
 * `servers` rows; only the gate run collapses.
 *
 * Non-runnable repositories are included: they are still source trees with
 * suites, and `manifest/runnable.ts` draws the boot line separately.
 */
export async function planUatTargets(
  manifest: Manifest,
  worktrees: readonly ReviewWorktree[],
  git: GitRunner,
): Promise<UatTarget[]> {
  const selected = await selectReviewTargets(manifest, worktrees, git);
  const byPath = new Map<string, UatTarget>();
  for (const target of selected) {
    const existing = byPath.get(target.repo);
    if (existing) {
      for (const name of target.names) {
        if (!existing.names.includes(name)) existing.names.push(name);
      }
      continue;
    }
    byPath.set(target.repo, {
      repo: target.repo,
      path: target.path,
      names: [...target.names],
    });
  }
  return [...byPath.values()];
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/workflow/uat/targets.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/workflow/uat/targets.ts src/workflow/uat/targets.test.ts
git commit -m "feat: run UAT against every affected repository, not the first by path"
```

---

### Task 13: Rewrite the UAT stage as orchestration

`stages/uat.ts` becomes orchestration only — plan targets, resolve gates, run them, aggregate, then either transition or park. It returns `StageRunResult` instead of always implying a verdict.

**Files:**
- Modify: `src/workflow/stages/uat.ts` (full rewrite)
- Modify: `src/workflow/stages/uat.test.ts` (rewrite; delete `TestRunner`-shaped cases)

**Interfaces:**
- Consumes: everything from Tasks 3–12.
- Produces, from `src/workflow/stages/uat.ts`:
  - `export interface RunUatOpts { ticketId: number; cwd: string; artifactDir: string; manifest?: Manifest; signal?: AbortSignal }`
  - `export interface UatDeps { planTargets?: typeof planUatTargets; probe?: (cwd: string) => ScriptProbe; runGates?: typeof runUatGates; git?: GitRunner; now?: () => string }`
  - `export async function runUat(store: Store, opts: RunUatOpts, deps?: UatDeps): Promise<StageRunResult>`
  - `makeTestRunner`, `makeNpmTestRunner`, `TestRunner`, `TestResult` and `UatOutcome` are **deleted** — the gate list replaces them.

- [ ] **Step 1: Write the failing test**

Replace `src/workflow/stages/uat.test.ts` with:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, type Store } from '../../store/db.js';
import { createTicketFlow } from './create.js';
import { getTicket } from '../../store/tickets.js';
import { transition } from '../machine.js';
import { listGateRuns } from '../../store/gateRuns.js';
import { stageBlock } from '../../store/stageBlocks.js';
import { manifest } from '../../manifest/fixtures.js';
import { runUat, type UatDeps } from './uat.js';

const now = () => '2026-07-30T10:00:00.000Z';

function deps(over: Partial<UatDeps> = {}): UatDeps {
  return {
    now,
    planTargets: async () => [{ repo: '/web', path: '/wt/web', names: ['web'] }],
    probe: () => ({ kind: 'ok', scripts: { test: 'vitest', e2e: 'playwright test' } }),
    runGates: async (gates) => ({
      kind: 'ran',
      results: gates.map((g) => ({ name: g.name, exitCode: 0, output: 'ok', startedAt: now(), endedAt: now() })),
    }),
    ...over,
  };
}

describe('runUat', () => {
  let store: Store;
  let id: number;
  let artifactDir: string;

  beforeEach(() => {
    store = openStore(':memory:');
    id = createTicketFlow(store, { key: 'T-1', title: 't' }).id;
    transition(store, id, 'scope', { kind: 'passed' });
    transition(store, id, 'impl', { kind: 'passed' });
    artifactDir = mkdtempSync(join(tmpdir(), 'karst-uat-'));
  });
  afterEach(() => {
    store.close();
    rmSync(artifactDir, { recursive: true, force: true });
  });

  it('all gates green -> advances to review and records one row per gate', async () => {
    const res = await runUat(store, { ticketId: id, cwd: '/wt/web', artifactDir }, deps());
    expect(res).toEqual({ kind: 'advanced', next: 'review' });
    expect(getTicket(store, id).stageCurrent).toBe('review');
    // Every row carries repository identity, or a failure names no place. With no
    // manifest the target is the bare cwd, so the label is the path.
    expect(listGateRuns(store, id).map((r) => r.gateName).sort()).toEqual([
      'e2e (/wt/web)',
      'test (/wt/web)',
    ]);
  });

  it('a failing gate -> routes to fix and files evidence under the attempt that ran', async () => {
    const res = await runUat(
      store,
      { ticketId: id, cwd: '/wt/web', artifactDir },
      deps({
        runGates: async (gates) => ({
          kind: 'ran',
          results: gates.map((g) => ({
            name: g.name,
            exitCode: g.name === 'e2e' ? 1 : 0,
            output: 'boom',
            startedAt: now(),
            endedAt: now(),
          })),
        }),
      }),
    );
    expect(res).toEqual({ kind: 'advanced', next: 'fix' });
    expect(getTicket(store, id).stageCurrent).toBe('fix');
    expect(listGateRuns(store, id).every((r) => r.attempt === 0)).toBe(true);
    expect(getTicket(store, id).stages.find((s) => s.stageKey === 'uat')!.attempt).toBe(1);
  });

  it('nothing to run -> blocks, does not transition, consumes no attempt', async () => {
    const res = await runUat(
      store,
      { ticketId: id, cwd: '/wt/web', artifactDir },
      deps({ probe: () => ({ kind: 'ok', scripts: { build: 'tsc' } }) }),
    );
    expect(res).toMatchObject({ kind: 'blocked', blocker: 'nothing-to-run' });
    expect(getTicket(store, id).stageCurrent).toBe('uat');
    expect(getTicket(store, id).stages.find((s) => s.stageKey === 'uat')!.attempt).toBe(0);
    expect(stageBlock(store, id, 'uat')?.kind).toBe('nothing-to-run');
  });

  it('an unreadable repository -> blocks capability-missing', async () => {
    const res = await runUat(
      store,
      { ticketId: id, cwd: '/wt/web', artifactDir },
      deps({ probe: () => ({ kind: 'io-error', message: 'EACCES' }) }),
    );
    expect(res).toMatchObject({ kind: 'blocked', blocker: 'capability-missing' });
  });

  it('a stopped run yields no verdict and no attempt', async () => {
    const res = await runUat(
      store,
      { ticketId: id, cwd: '/wt/web', artifactDir },
      deps({ runGates: async () => ({ kind: 'stopped' }) }),
    );
    expect(res).toEqual({ kind: 'stopped' });
    expect(getTicket(store, id).stageCurrent).toBe('uat');
    expect(getTicket(store, id).stages.find((s) => s.stageKey === 'uat')!.attempt).toBe(0);
  });

  it('writes the overlap warning into the artifact when nothing is independent', async () => {
    await runUat(
      store,
      { ticketId: id, cwd: '/wt/web', artifactDir },
      deps({
        probe: () => ({ kind: 'ok', scripts: { test: 'vitest' } }),
      }),
    );
    const path = getTicket(store, id).stages.find((s) => s.stageKey === 'uat')!.artifactPath!;
    expect(readFileSync(path, 'utf8')).toContain('asked no question review does not');
  });

  it('clears a previous block when a fresh run reaches a verdict', async () => {
    await runUat(
      store,
      { ticketId: id, cwd: '/wt/web', artifactDir },
      deps({ probe: () => ({ kind: 'ok', scripts: { build: 'tsc' } }) }),
    );
    expect(stageBlock(store, id, 'uat')).not.toBeNull();
    await runUat(store, { ticketId: id, cwd: '/wt/web', artifactDir }, deps());
    expect(stageBlock(store, id, 'uat')).toBeNull();
  });

  // `planTargets` is consulted ONLY when a manifest is supplied — without one
  // there is nothing to resolve repository names against, so runUat falls back to
  // the single cwd. Passing a manifest here is what puts the planner in the path.
  it('runs every target and aggregates only after all of them complete', async () => {
    const ran: string[] = [];
    await runUat(
      store,
      { ticketId: id, cwd: '/wt/web', artifactDir, manifest: manifest({}) },
      deps({
        planTargets: async () => [
          { repo: '/web', path: '/wt/web', names: ['web'] },
          { repo: '/api', path: '/wt/api', names: ['api'] },
        ],
        runGates: async (gates, cwd) => {
          ran.push(cwd);
          return {
            kind: 'ran',
            results: gates.map((g) => ({ name: g.name, exitCode: 0, output: '', startedAt: now(), endedAt: now() })),
          };
        },
      }),
    );
    expect(ran.sort()).toEqual(['/wt/api', '/wt/web']);
    expect(getTicket(store, id).stageCurrent).toBe('review');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/workflow/stages/uat.test.ts`
Expected: FAIL — `runUat` takes a `TestRunner` and returns a `UatOutcome`.

- [ ] **Step 3: Write minimal implementation**

Replace `src/workflow/stages/uat.ts` entirely with:

```ts
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Store } from '../../store/db.js';
import type { StageRunResult } from '../../model/types.js';
import type { Manifest } from '../../manifest/types.js';
import { setStage, stageAttempt } from '../../store/stages.js';
import { recordGateRun } from '../../store/gateRuns.js';
import { parkGateStage, clearStageBlock } from '../../store/stageBlocks.js';
import { transition } from '../machine.js';
import { nowIso } from '../../model/time.js';
import { listWorktreesByTicket } from '../../store/dashboard.js';
import { defaultGitRunner, type GitRunner } from '../../integrations/git.js';
import { probeScripts, type ScriptProbe } from '../gates/probe.js';
import { REVIEW_GATES } from '../gates/scripts.js';
import { planUatTargets, type UatTarget } from '../uat/targets.js';
import { resolveUatGates, runUatGates } from '../uat/gates.js';
import { aggregateUat, type AggregateEntry, type GateIdentity } from '../uat/aggregate.js';

/**
 * UAT stage — orchestration only.
 *
 * Plan the affected repositories, resolve each one's gate list (explicit config
 * else a package.json probe), run them, and reduce. The verdict conjunction lives
 * in `uat/aggregate.ts` and the gate mechanics in `uat/gates.ts`, because this
 * file was 134 lines and would be 600–900 if every mechanism landed in it.
 *
 * Returns `StageRunResult`: a run that could not ask its question parks durably
 * (`parkGateStage`) rather than transitioning or throwing, and consumes no
 * attempt — nothing about the code was learned.
 */

export interface RunUatOpts {
  ticketId: number;
  /** The ticket's primary worktree; used only when no manifest is supplied. */
  cwd: string;
  artifactDir: string;
  manifest?: Manifest;
  signal?: AbortSignal;
}

export interface UatDeps {
  planTargets?: (
    manifest: Manifest,
    worktrees: readonly { repo: string; path: string; baseRef: string | null }[],
    git: GitRunner,
  ) => Promise<UatTarget[]>;
  probe?: (cwd: string) => ScriptProbe;
  runGates?: typeof runUatGates;
  git?: GitRunner;
  now?: () => string;
}

/** Review's gate identities for one target — what UAT must not merely duplicate. */
function reviewIdentitiesFor(target: UatTarget): GateIdentity[] {
  return REVIEW_GATES.map((gate) => ({
    repo: target.repo,
    command: 'npm',
    args: gate.args,
  }));
}

export async function runUat(
  store: Store,
  opts: RunUatOpts,
  deps: UatDeps = {},
): Promise<StageRunResult> {
  const now = deps.now ?? nowIso;
  const planTargets = deps.planTargets ?? planUatTargets;
  const probe = deps.probe ?? probeScripts;
  const runGates = deps.runGates ?? runUatGates;
  const git = deps.git ?? defaultGitRunner;
  const runAt = now();

  const targets: UatTarget[] = opts.manifest
    ? await planTargets(opts.manifest, listWorktreesByTicket(store, opts.ticketId), git)
    : [{ repo: opts.cwd, path: opts.cwd, names: [] }];

  const entries: AggregateEntry[] = [];
  const reviewIdentities: GateIdentity[] = [];
  const sections: string[] = [];

  for (const target of targets) {
    const label = target.names.join(', ') || target.repo;
    const scriptProbe = probe(target.path);
    const resolution = resolveUatGates(
      scriptProbe,
      opts.manifest?.uat,
      target.names[0] ?? null,
    );

    // Environmental: karst could not ask this repository anything. Park rather
    // than reduce — a block is not a verdict about the ticket's code.
    if (resolution.kind === 'unavailable') {
      const reason = `${label}: ${resolution.reason}`;
      parkGateStage(store, {
        ticketId: opts.ticketId,
        stageKey: 'uat',
        kind: resolution.blocker,
        reason,
        runAt,
        gates: [],
      });
      return { kind: 'blocked', blocker: resolution.blocker, reason };
    }

    // A malformed package.json resolves to zero gates and IS a failure about the
    // repository — an agent can fix it, so it must reach a verdict.
    if (resolution.gates.length === 0 && scriptProbe.kind === 'malformed') {
      entries.push({
        result: {
          name: 'package.json',
          exitCode: 1,
          output: `${label}: package.json is malformed — ${scriptProbe.message}`,
          startedAt: runAt,
          endedAt: runAt,
        },
        identity: { repo: target.repo, command: 'node', args: ['--parse-package-json'] },
      });
      sections.push(`# package.json (${label}, exit 1)\n${scriptProbe.message}`);
      continue;
    }

    const scripts = scriptProbe.kind === 'ok' ? scriptProbe.scripts : {};
    const run = await runGates(resolution.gates, target.path, {
      signal: opts.signal,
      now,
      scriptsAvailable: (script) => scripts[script] !== undefined,
    });
    // A Stop yields no verdict and no attempt. Whatever ran is discarded rather
    // than half-recorded: a partial gate set would read as a complete one.
    if (run.kind === 'stopped') return { kind: 'stopped' };

    reviewIdentities.push(...reviewIdentitiesFor(target));
    for (const result of run.results) {
      const gate = resolution.gates.find((g) => g.name === result.name)!;
      entries.push({
        result: { ...result, name: `${result.name} (${label})` },
        identity: { repo: target.repo, command: gate.command, args: gate.args },
      });
      sections.push(
        `# ${result.name} (${label}, ${result.exitCode === null ? 'skipped' : `exit ${result.exitCode}`})\n${result.output}`,
      );
    }
  }

  const outcome = aggregateUat(entries, reviewIdentities);

  mkdirSync(opts.artifactDir, { recursive: true });
  const artifactPath = join(opts.artifactDir, `uat-ticket-${opts.ticketId}.log`);
  const warnings = outcome.kind === 'verdict' ? outcome.warnings : [];
  writeFileSync(
    artifactPath,
    [...warnings.map((w) => `! ${w}`), ...sections].join('\n\n'),
  );

  const gateRows = entries.map((e) => ({
    gateName: e.result.name,
    exitCode: e.result.exitCode,
    startedAt: e.result.startedAt ?? null,
    endedAt: e.result.endedAt ?? null,
  }));

  if (outcome.kind === 'blocked') {
    parkGateStage(store, {
      ticketId: opts.ticketId,
      stageKey: 'uat',
      kind: outcome.blocker,
      reason: outcome.reason,
      runAt,
      gates: gateRows,
    });
    setStage(store, opts.ticketId, 'uat', { artifactPath });
    return { kind: 'blocked', blocker: outcome.blocker, reason: outcome.reason };
  }

  // Evidence and verdict commit together or not at all.
  const next = transition(store, opts.ticketId, 'uat', outcome.verdict, () => {
    setStage(store, opts.ticketId, 'uat', { artifactPath });
    // A run that reached a verdict answers whatever blocked a previous one.
    clearStageBlock(store, opts.ticketId, 'uat');
    recordGateRun(store, {
      ticketId: opts.ticketId,
      stageKey: 'uat',
      // Read before the machine bumps it on a failure: these gates belong to the
      // attempt that RAN, not to the one its failure creates.
      attempt: stageAttempt(store, opts.ticketId, 'uat'),
      runAt,
      gates: gateRows,
    });
  });

  return { kind: 'advanced', next };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/workflow/ src/model/ && npm run typecheck`
Expected: PASS. `model/inside/gates.ts` still reads `UAT_GATES` for the stepper — a run whose gate names now carry a `(label)` suffix will not match a `UAT_GATES` name, so `uatInside` shows those gates as pending. Fix it in the same step by matching on the recorded rows instead:

```ts
export function uatInside(cell: StepperCell, runs: readonly GateRun[], now: string): StageInside {
  const batch = latestBatch(runs, 'uat');
  // UAT's gate set is per-repository and resolved at runtime, so the recorded
  // rows ARE the list — unlike review, whose gates are a static constant.
  const ops = batch.map<StageOp>((run) => ({
    status: run.exitCode === null ? 'note' : run.exitCode === 0 ? 'pass' : 'fail',
    name: run.gateName,
    detail: run.exitCode === null ? 'nothing to run' : `exit ${run.exitCode}`,
    duration: formatDuration(run.startedAt, run.endedAt),
  }));
  return inside(cell, now, ops);
}
```

and update `src/model/inside/gates.test.ts`'s `uatInside` cases to assert against recorded rows rather than `UAT_GATES` names.

- [ ] **Step 5: Commit**

```bash
git add src/workflow/stages/uat.ts src/workflow/stages/uat.test.ts src/model/inside/gates.ts src/model/inside/gates.test.ts
git commit -m "feat: run UAT as a multi-gate, multi-repository stage that parks when it cannot ask"
```

---

### Task 14: Move the driver out of `extension.ts` and wire it up

`driveTicket` and `autoResumeFix` are the only untested part of the driver path, they are exactly where the new `StageRunResult` branching lands, and `extension.ts` is 2319 lines.

**Files:**
- Create: `src/workflow/driveTicket.ts`
- Create: `src/workflow/driveTicket.test.ts`
- Modify: `src/extension.ts:1002-1100`

**Interfaces:**
- Consumes: `runStageDriver`/`StageDriverDeps` (Task 7), `runUat` (Task 13), `runReview`, `countFixAttempts`/`lastFailedGate`/`fixAttemptsRemain` (Task 8).
- Produces, from `src/workflow/driveTicket.ts`:
  - `export interface DriveTicketDeps { store: Store; manifest: () => Manifest | undefined; artifactDirFor: (ticketId: number) => string; worktreeFor: (ticketId: number) => string | null; onProgress: StageDriverDeps['onProgress']; shouldContinue: () => boolean; signal?: AbortSignal; resumeFix: (ticketId: number, gate: 'uat' | 'review', attempts: number) => void; log: (message: string) => void }`
  - `export async function driveTicket(deps: DriveTicketDeps, ticketId: number): Promise<StageOutcome>`
  - `export function fixResumeDecision(stages, manifest): { kind: 'resume'; gate: 'uat' | 'review'; attempts: number } | { kind: 'exhausted'; gate: 'uat' | 'review'; attempts: number; cap: number } | { kind: 'no-failed-gate' }`

- [ ] **Step 1: Write the failing test**

Create `src/workflow/driveTicket.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { fixResumeDecision } from './driveTicket.js';
import { manifest, uat } from '../manifest/fixtures.js';

describe('fixResumeDecision', () => {
  const stages = (uatAttempt: number, reviewAttempt: number) => [
    { stageKey: 'uat', status: 'failed', endedAt: '2026-07-30T10:00:00.000Z', attempt: uatAttempt },
    { stageKey: 'review', status: 'passed', endedAt: '2026-07-30T09:00:00.000Z', attempt: reviewAttempt },
  ];

  it('resumes against the gate that failed, under that gate budget', () => {
    expect(fixResumeDecision(stages(1, 2), undefined)).toEqual({
      kind: 'resume', gate: 'uat', attempts: 1,
    });
  });

  it('honours uat.maxFixAttempts for the uat budget', () => {
    expect(
      fixResumeDecision(stages(1, 0), manifest({}, { uat: uat({ maxFixAttempts: 1 }) })),
    ).toEqual({ kind: 'exhausted', gate: 'uat', attempts: 1, cap: 1 });
  });

  it('does not let review failures exhaust the uat budget', () => {
    // Summed this is 4, over the cap of 3; per-stage it is 2, which still has a
    // resume left. That difference is the bug this replaces.
    expect(fixResumeDecision(stages(2, 2), undefined)).toEqual({
      kind: 'resume', gate: 'uat', attempts: 2,
    });
  });

  it('reports no failed gate when nothing sent the ticket to fix', () => {
    expect(
      fixResumeDecision([{ stageKey: 'uat', status: 'passed', endedAt: null, attempt: 0 }], undefined),
    ).toEqual({ kind: 'no-failed-gate' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/workflow/driveTicket.test.ts`
Expected: FAIL — cannot resolve `./driveTicket.js`.

- [ ] **Step 3: Write minimal implementation**

Create `src/workflow/driveTicket.ts`:

```ts
import type { Store } from '../store/db.js';
import type { StageKey } from '../model/types.js';
import type { Manifest } from '../manifest/types.js';
import { getTicket } from '../store/tickets.js';
import { runStageDriver, type StageOutcome, type DriverStatus } from './driver.js';
import { runUat } from './stages/uat.js';
import { runReview } from './stages/review.js';
import {
  countFixAttempts,
  fixAttemptsRemain,
  lastFailedGate,
  FIX_ATTEMPT_CAP,
  type GateStageKey,
} from './fixAttempts.js';

export type FixResumeDecision =
  | { kind: 'resume'; gate: GateStageKey; attempts: number }
  | { kind: 'exhausted'; gate: GateStageKey; attempts: number; cap: number }
  | { kind: 'no-failed-gate' };

/**
 * Whether to resume the agent into `fix`, and against which budget.
 *
 * Pure, so the cap arithmetic is testable without a window: this is the decision
 * that used to live inline in `extension.ts` and summed two stages' attempts into
 * one counter.
 *
 * Exhaustion needs no new state. The ticket rests at `fix`, `autoResumeFix` does
 * not fire, and `ticketsToSweep` does not select a ticket at `fix` — so it simply
 * stops, somewhere a human can act.
 */
export function fixResumeDecision(
  stages: readonly { stageKey: string; status?: string; endedAt?: string | null; attempt?: number }[],
  manifest: Manifest | undefined,
): FixResumeDecision {
  const gate = lastFailedGate(stages);
  if (!gate) return { kind: 'no-failed-gate' };
  const cap = gate === 'uat' ? (manifest?.uat?.maxFixAttempts ?? FIX_ATTEMPT_CAP) : FIX_ATTEMPT_CAP;
  const attempts = countFixAttempts(stages, gate);
  return fixAttemptsRemain(attempts, cap)
    ? { kind: 'resume', gate, attempts }
    : { kind: 'exhausted', gate, attempts, cap };
}

export interface DriveTicketDeps {
  store: Store;
  manifest: () => Manifest | undefined;
  artifactDirFor: (ticketId: number) => string;
  worktreeFor: (ticketId: number) => string | null;
  onProgress: (ticketId: number, stage: StageKey, status: DriverStatus) => void;
  shouldContinue: () => boolean;
  signal?: AbortSignal;
  /** Called only when a fix attempt remains; the host owns how it resumes. */
  resumeFix: (ticketId: number, gate: GateStageKey, attempts: number) => void;
  log: (message: string) => void;
}

/**
 * Run the gates for one ticket and act on where it stopped.
 *
 * Lives here rather than in `extension.ts` because it is the only untested part
 * of the driver path and it is exactly where the `StageRunResult` branching
 * lands. Nothing in this module imports `vscode`.
 */
export async function driveTicket(
  deps: DriveTicketDeps,
  ticketId: number,
): Promise<StageOutcome> {
  const outcome = await runStageDriver(
    {
      store: deps.store,
      worktreeFor: deps.worktreeFor,
      onProgress: deps.onProgress,
      shouldContinue: deps.shouldContinue,
      runUat: (id, cwd) =>
        runUat(deps.store, {
          ticketId: id,
          cwd,
          artifactDir: deps.artifactDirFor(id),
          manifest: deps.manifest(),
          signal: deps.signal,
        }),
      runReview: (id, cwd) =>
        runReview(deps.store, {
          ticketId: id,
          cwd,
          artifactDir: deps.artifactDirFor(id),
          manifest: deps.manifest(),
        }).then(() => ({
          kind: 'advanced' as const,
          next: getTicket(deps.store, id).stageCurrent as StageKey,
        })),
    },
    ticketId,
  );

  deps.log(
    `stage driver: ticket ${ticketId} halted at ${outcome.stage} (${outcome.status}` +
      `${outcome.reason ? `: ${outcome.reason}` : ''})`,
  );

  if (outcome.stage === 'fix') {
    const decision = fixResumeDecision(getTicket(deps.store, ticketId).stages, deps.manifest());
    if (decision.kind === 'resume') deps.resumeFix(ticketId, decision.gate, decision.attempts);
    else if (decision.kind === 'exhausted') {
      deps.log(
        `stage driver: ticket ${ticketId} parked at fix — ${decision.attempts} ` +
          `${decision.gate} failures, at the cap of ${decision.cap}; leaving it for a human`,
      );
    } else {
      deps.log(`stage driver: ticket ${ticketId} at fix with no failed gate; leaving it`);
    }
  }

  return outcome;
}
```

In `src/extension.ts`, replace the body of the local `driveTicket` (lines 1008–1050) with a call into the new module, and reduce `autoResumeFix` to the host actions only:

```ts
  async function driveTicket(ticketId: number): Promise<void> {
    if (!driver.begin(ticketId)) return; // a run is already in flight
    logger.info(`stage driver: begin ticket ${ticketId}`);
    try {
      await driveTicketRun(
        {
          store: localStore,
          manifest: currentManifest,
          artifactDirFor,
          worktreeFor: (id) => listWorktreesByTicket(localStore, id)[0]?.path ?? null,
          onProgress: (id, stage, status) => {
            logger.info(`stage driver: ticket ${id} ${stage} → ${status}`);
            provider.refresh();
            dashboard.pushState(id);
          },
          shouldContinue: () => driver.shouldContinue(ticketId),
          resumeFix: (id, _gate, attempts) => resumeFixSession(id, attempts),
          log: (message) => logger.info(message),
        },
        ticketId,
      );
    } catch (e) {
      logError('stage driver failed', e);
    } finally {
      driver.end(ticketId);
      provider.refresh();
      dashboard.pushState(ticketId);
    }
  }
```

Rename the remaining `autoResumeFix` to `resumeFixSession(ticketId: number, attempts: number)` and delete its cap check (lines 1070–1078) — `fixResumeDecision` owns that now. Keep the brief, marker and nudge logic exactly as it is. Add `import { driveTicket as driveTicketRun } from './workflow/driveTicket.js';` and drop the now-unused `runStageDriver`, `runUat`, `runReview`, `countFixAttempts`, `fixAttemptsRemain` and `FIX_ATTEMPT_CAP` imports.

`worktreeFor` still returns the first worktree — that is now only a fallback for the no-manifest path, since `runUat` plans its own targets from the manifest. Leave the comment saying so:

```ts
          // Only a fallback: with a manifest, runUat plans its own multi-repository
          // targets and this path is not what decides where gates run.
          worktreeFor: (id) => listWorktreesByTicket(localStore, id)[0]?.path ?? null,
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test && npm run typecheck && npm run build`
Expected: PASS on all three. The build must succeed because `tsconfig.build.json` excludes tests and would catch a test-only import leaking into `dist/`.

- [ ] **Step 5: Commit**

```bash
git add src/workflow/driveTicket.ts src/workflow/driveTicket.test.ts src/extension.ts
git commit -m "refactor: move the stage driver out of extension.ts and branch on StageRunResult"
```

---

## Self-Review

Run after the last task, before handing back.

**Spec coverage — every Phase 0/1 item in the spec's Phasing section, mapped:**

| spec item | task |
|---|---|
| Phase 0: UAT gate list + `inside/gates.ts` consumer + guard test | 1 |
| `fix: { passed: 'uat' }` | 2 |
| Durable `blocked` state + `StageRunResult` contract | 5, 6, 7 |
| Per-stage attempt counting (`countFixAttempts` stops summing) | 8 |
| Static gates over a real gate list with discriminated probing | 3, 10 |
| Aggregate-`null`-is-not-a-pass | 11 |
| Effective-signal check as a warning | 11 |
| Multi-repository target plan via `selectReviewTargets`; kills `extension.ts:1015` | 12, 13 |
| Run-wide `AbortSignal` + discriminated process outcomes | 4 |
| `GateResult` moved to a shared module | 3 |
| `kind: command` for non-Node repositories | 9, 10 |
| The `uat:` manifest surface (all fields incl. inert `origins`/`authBootstrap`) | 9 |
| Zero-config probe of `package.json` | 10 |
| `nothing-to-run` blocker naming the scripts karst looked for | 10, 11 |
| Schema bookkeeping 15 → 16, guarded ALTER, `db.test.ts` sweep, legacy test | 5 |
| CLAUDE.md stale `user_version` count corrected | 5 |
| CLAUDE.md `gate_runs` two-writer invariant widened | 6 |
| File budget: `uat.ts` splits, `driveTicket` out of `extension.ts` | 13, 14 |
| Behaviour-matrix Phase-1 rows | see below |

**Behaviour matrix, Phase 1 rows — each has a test:**

| matrix row | test |
|---|---|
| all gates exit 0 → `review` | Task 13, "all gates green" |
| any gate non-zero → `fix`, attempt +1 | Task 13, "a failing gate" |
| every gate `null` → blocked `nothing-to-run` | Task 11 + Task 13, "nothing to run" |
| gates ran, none independent (Phase 1) → passed with a warning | Task 11 + Task 13, "writes the overlap warning" |
| configured gate's script missing → `failed` | Task 10, "fails a configured gate whose script…" |
| `package.json` malformed → `failed` | Task 10 + Task 13 (malformed branch) |
| permission/IO error → blocked `capability-missing` | Task 10 + Task 13, "an unreadable repository" |
| Stop mid-gate → `stopped`, resumable | Task 4, Task 10, Task 13 |
| `maxFixAttempts` exhausted → rests at `fix`, no blocked row | Task 8, Task 14 |
| ticket scopes two entries sharing a `repoPath` → one gate run, two names | Task 12 |

**Not covered here, by design:** every row marked Phase 2 or Phase P in the matrix. `boot-failed`, `no-independent-signal` as a *block*, `lease-lost`, Playwright, the auth digest, the verifier, and the digest short-circuit are Phase 2. The two forged-marker rows are Phase P.

**Deliberate gaps to state when handing back:**

1. **`kind: command` gates get no path containment.** The spec scopes the shared validator to Phase 2 ("build it when it has two consumers") and `command`/`args` come from a committed `karst.yml`, not from an agent. Nothing here promotes an agent-supplied path.
2. **`BlockerKind` declares five members and Phase 1 writes two.** The other three are named because the behaviour matrix names them; a union member with no writer is inert, not dead code.
3. **`runCommand` keeps its lossy reduction for review.** Review's redesign is out of scope; UAT calls `runProcess` directly, so only review can still read a Stop as a failing gate.
4. **The Phase-1 overlap warning lands in the artifact only.** It is one of the four controls the spec's "Named risk" table says resolve to one inattentive human. Making it blocking is a Phase 2 decision, not a Phase 1 one.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-30-uat-stage-phase-0-1.md`. Two execution options:

**1. Subagent-Driven (recommended)** — a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — execute tasks in this session using executing-plans, batch execution with checkpoints.
