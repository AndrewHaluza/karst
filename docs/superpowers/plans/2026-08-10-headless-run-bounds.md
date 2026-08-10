# Headless Agent Run Bounds Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bound every headless agent-CLI run (codex/claude/opencode/agy) with a timeout, an abort kill, and a byte-bounded output buffer, so a hung or leaking agent process can no longer spin CPU and grow memory forever.

**Architecture:** All four adapters (`codex.ts`, `claude.ts`, `opencode.ts`, `antigravity.ts`) duplicate the same unbounded `defaultSpawn` — `spawn(..., { stdio: ['ignore','pipe','pipe'] })` with `stdout += String(data)` accumulation, no timeout, no abort handling, and `runHeadless` ignores `opts.signal`. Replace the duplicated spawner with one shared module (`src/agent/headlessSpawn.ts`) that spawns detached (own process group), streams into `BoundedOutput`, honors `AbortSignal` and a timeout by `killTree`-ing the group, and rejects with named errors on abort/timeout. Each adapter's `runHeadless` then forwards `opts.signal` into the spawn. Callers (`workflow/uat/tester.ts`, `workflow/review/findingsLane.ts`) already thread the driver's `AbortController.signal` and already check `opts.signal?.aborted` after the call — only the child-kill half is missing.

**Tech Stack:** Node `child_process.spawn` (detached group kill), `AbortController`, existing `runtime/processTree.ts` `killTree`, existing `runtime/boundedOutput.ts` `BoundedOutput`, vitest.

## Global Constraints

- Extension-host rule: nothing may block the event loop — all spawn paths are async, `killTree` is sync-but-bounded (single SIGKILL syscall, same as `workflow/gates/run.ts`).
- Evidence-based: the leak is a headless agent child (`fd0=/dev/null`, pipe pair, cwd=worktree — the exact `stdio: ['ignore','pipe','pipe']` shape) that Stop could not kill and no timeout would reap (869efxycx).
- `SpawnHeadless` gains an OPTIONAL 4th parameter only — every existing test fake (`async () => ({...})`) must keep compiling and keep its behavior.
- Do NOT change the interactive-session path (`buildInteractiveCommand`) — terminals own their own lifecycle.
- Do NOT change verdict semantics: `runHeadless` still throws on nonzero exit via `describeHeadlessFailure`; abort/timeout rejections must be distinguishable (`AbortError` name vs timeout message).
- Keep files small (<400 lines) and colocate tests (`*.test.ts` beside source).

---

### Task 1: Shared headless spawner

**Files:**
- Create: `src/agent/headlessSpawn.ts`
- Test: `src/agent/headlessSpawn.test.ts`

**Interfaces:**
- Produces:
  - `export interface HeadlessSpawnResult { stdout: string; stderr: string; exitCode: number; }`
  - `export interface HeadlessSpawnOptions { signal?: AbortSignal; timeoutMs?: number; maxOutputBytes?: number; terminationGraceMs?: number; }`
  - `export const DEFAULT_HEADLESS_TIMEOUT_MS = 15 * 60 * 1_000;`
  - `export const DEFAULT_HEADLESS_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;`
  - `export const DEFAULT_HEADLESS_TERMINATION_GRACE_MS = 5_000;`
  - `export function spawnHeadlessCli(command: string, args: readonly string[], cwd: string, options?: HeadlessSpawnOptions, spawnImpl?: typeof spawn): Promise<HeadlessSpawnResult>`
  - Rejects: pre-aborted signal (without spawning); child 'error' event; abort (`err.name === 'AbortError'`); timeout (`Error` whose message contains `timed out after`).

- [ ] **Step 1: Write the failing tests**

`src/agent/headlessSpawn.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import {
  spawnHeadlessCli,
  DEFAULT_HEADLESS_TERMINATION_GRACE_MS,
} from './headlessSpawn.js';

/** A fake child with real stdout/stderr EventEmitters, like claude.test.ts. */
function fakeChild(pid = 4242): EventEmitter & {
  pid: number;
  stdout: EventEmitter;
  stderr: EventEmitter;
} {
  const child = new EventEmitter() as EventEmitter & {
    pid: number;
    stdout: EventEmitter;
    stderr: EventEmitter;
  };
  child.pid = pid;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  return child;
}

describe('spawnHeadlessCli', () => {
  it('resolves stdout/stderr and the exit code on a clean close', async () => {
    const child = fakeChild();
    const spawnImpl = vi.fn(() => {
      queueMicrotask(() => {
        child.stdout.emit('data', Buffer.from('out'));
        child.stderr.emit('data', Buffer.from('err'));
        child.emit('close', 3);
      });
      return child;
    }) as unknown as typeof spawn;

    const result = await spawnHeadlessCli('codex', ['exec'], '/wt/a', {}, spawnImpl);
    expect(result).toEqual({ stdout: 'out', stderr: 'err', exitCode: 3 });
    expect(spawnImpl).toHaveBeenCalledWith('codex', ['exec'], {
      cwd: '/wt/a',
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
  });

  it('rejects with an AbortError when the signal fires mid-run and kills the group', async () => {
    const child = fakeChild();
    const killed = vi.spyOn(process, 'kill');
    const spawnImpl = vi.fn(() => {
      setTimeout(() => child.emit('close', null), 50);
      return child;
    }) as unknown as typeof spawn;
    const controller = new AbortController();

    const promise = spawnHeadlessCli('codex', ['exec'], '/wt/a', { signal: controller.signal }, spawnImpl);
    controller.abort();
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
    expect(killed).toHaveBeenCalledWith(-4242, 'SIGKILL');
  });

  it('rejects without spawning when the signal is already aborted', async () => {
    const spawnImpl = vi.fn(() => fakeChild()) as unknown as typeof spawn;
    const controller = new AbortController();
    controller.abort();
    await expect(
      spawnHeadlessCli('codex', ['exec'], '/wt/a', { signal: controller.signal }, spawnImpl),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(spawnImpl).not.toHaveBeenCalled();
  });

  it('rejects with a timed-out error when the child never exits and kills the group', async () => {
    const child = fakeChild();
    const killed = vi.spyOn(process, 'kill');
    const spawnImpl = vi.fn(() => child) as unknown as typeof spawn;

    const promise = spawnHeadlessCli(
      'codex',
      ['exec'],
      '/wt/a',
      { timeoutMs: 20, terminationGraceMs: 5_000 },
      spawnImpl,
    );
    await expect(promise).rejects.toThrow(/timed out after 20ms/);
    expect(killed).toHaveBeenCalledWith(-4242, 'SIGKILL');
  });

  it('bounds stdout to maxOutputBytes and appends the truncation marker', async () => {
    const child = fakeChild();
    const spawnImpl = vi.fn(() => {
      queueMicrotask(() => {
        child.stdout.emit('data', Buffer.from('x'.repeat(2000)));
        child.emit('close', 0);
      });
      return child;
    }) as unknown as typeof spawn;

    const result = await spawnHeadlessCli('codex', ['exec'], '/wt/a', { maxOutputBytes: 1024 }, spawnImpl);
    expect(result.stdout.length).toBeLessThanOrEqual(1024 + 64);
    expect(result.stdout).toContain('[output truncated]');
    expect(result.exitCode).toBe(0);
  });
});
```

- [ ] **Step 2: Run the new tests, verify they fail**

Run: `npx vitest run src/agent/headlessSpawn.test.ts`
Expected: FAIL — module `./headlessSpawn.js` cannot be resolved.

- [ ] **Step 3: Implement `src/agent/headlessSpawn.ts`**

```ts
import { spawn, type ChildProcess } from 'node:child_process';
import { BoundedOutput, OUTPUT_TRUNCATION_MARKER } from '../runtime/boundedOutput.js';
import { killTree } from '../runtime/processTree.js';

export const DEFAULT_HEADLESS_TIMEOUT_MS = 15 * 60 * 1_000;
export const DEFAULT_HEADLESS_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
export const DEFAULT_HEADLESS_TERMINATION_GRACE_MS = 5_000;

export interface HeadlessSpawnResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface HeadlessSpawnOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  maxOutputBytes?: number;
  terminationGraceMs?: number;
}

function abortError(): Error {
  const err = new Error('headless agent run aborted');
  err.name = 'AbortError';
  return err;
}

function timeoutError(timeoutMs: number, diagnostic: string): Error {
  return new Error(`headless agent run timed out after ${timeoutMs}ms${diagnostic}`);
}

function renderOutput(bounded: BoundedOutput): string {
  return bounded.render();
}

/**
 * Run an agent CLI headless with three hard bounds the adapters' old duplicated
 * spawner lacked (869efxycx):
 *
 * - `signal` — an abort kills the whole process GROUP (killTree), so a Stop
 *   pressed mid-call reaches a stuck core and its children instead of being
 *   noticed once the run ends on its own. The child is spawned `detached` so it
 *   leads its own group, exactly like `workflow/gates/run.ts`.
 * - `timeoutMs` — a core that hangs (a stuck turn, a deadlocked worker) is
 *   SIGKILLed after the deadline; without it a hung `codex exec` spun one core
 *   at 100% and grew its RSS until the host restarted.
 * - `maxOutputBytes` — stdout/stderr are drained into `BoundedOutput`, never
 *   `stdout += String(data)`; a run that emits megabytes cannot grow host
 *   memory (or O(n^2) concatenate) forever.
 *
 * Rejects on abort (`name === 'AbortError'`), timeout, or spawn failure. Callers
 * that already check `opts.signal?.aborted` (tester, findings lane) keep working
 * unchanged; `instrumentedAdapter` records the failed call either way.
 */
export function spawnHeadlessCli(
  command: string,
  args: readonly string[],
  cwd: string,
  options: HeadlessSpawnOptions = {},
  spawnImpl: typeof spawn = spawn,
): Promise<HeadlessSpawnResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_HEADLESS_TIMEOUT_MS;
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_HEADLESS_MAX_OUTPUT_BYTES;
  const terminationGraceMs =
    options.terminationGraceMs ?? DEFAULT_HEADLESS_TERMINATION_GRACE_MS;

  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(abortError());
      return;
    }

    let child: ChildProcess;
    try {
      child = spawnImpl(command, args, {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
      });
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }

    const stdout = new BoundedOutput(Math.max(0, maxOutputBytes));
    const stderr = new BoundedOutput(Math.max(0, maxOutputBytes));
    let settled = false;
    let terminationDiagnostic = '';
    let deadline: ReturnType<typeof setTimeout> | undefined;
    let terminationDeadline: ReturnType<typeof setTimeout> | undefined;

    const settle = (
      outcome: HeadlessSpawnResult | Error,
    ): void => {
      if (settled) return;
      settled = true;
      if (deadline !== undefined) clearTimeout(deadline);
      if (terminationDeadline !== undefined) clearTimeout(terminationDeadline);
      options.signal?.removeEventListener('abort', onAbort);
      if (outcome instanceof Error) reject(outcome);
      else resolve(outcome);
    };

    const terminate = (): void => {
      if (child.pid === undefined) {
        terminationDiagnostic = '; child pid unavailable';
        return;
      }
      try {
        killTree(child.pid);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        terminationDiagnostic = `; termination error: ${message}`;
      }
    };

    function onAbort(): void {
      if (settled) return;
      terminate();
      // Wait for the SIGKILLed group to report 'close' before rejecting, so a
      // caller's cleanup never races a process that is still winding down.
      terminationDeadline = setTimeout(() => {
        settle(abortError());
      }, Math.max(0, terminationGraceMs));
    }
    options.signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout?.on('data', (chunk: Buffer) => stdout.append(chunk));
    child.stderr?.on('data', (chunk: Buffer) => stderr.append(chunk));

    child.once('error', (err: Error) => {
      if (settled) return;
      if (terminationDiagnostic !== '') {
        settle(timeoutError(timeoutMs, terminationDiagnostic));
        return;
      }
      settle(err);
    });

    child.once('close', (code) => {
      if (settled) return;
      settle({
        stdout: renderOutput(stdout),
        stderr: renderOutput(stderr),
        exitCode: code ?? 1,
      });
    });

    deadline = setTimeout(() => {
      if (settled) return;
      terminate();
      if (settled) return;
      terminationDeadline = setTimeout(() => {
        settle(timeoutError(timeoutMs, terminationDiagnostic));
      }, Math.max(0, terminationGraceMs));
    }, Math.max(0, timeoutMs));
  });
}
```

- [ ] **Step 4: Run the new tests, verify they pass**

Run: `npx vitest run src/agent/headlessSpawn.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Add real-process kill tests (grandchild reaped, no orphan)**

Append to `src/agent/headlessSpawn.test.ts`:

```ts
describe('spawnHeadlessCli (real processes)', () => {
  it('kills the whole process group on abort, including a grandchild', async () => {
    // The child spawns a grandchild that would survive a plain child.kill();
    // the group kill must take both down. Same pattern as gates/run.test.ts.
    const script =
      'const{spawn}=require("node:child_process");' +
      'const c=spawn(process.execPath,["-e","setInterval(()=>{},1000)"]);' +
      'console.log(c.pid);setInterval(()=>{},1000)';
    const controller = new AbortController();
    const promise = spawnHeadlessCli(
      process.execPath,
      ['-e', script],
      process.cwd(),
      { signal: controller.signal, terminationGraceMs: 5_000 },
    );
    const result = await new Promise<{ stdout: string }>((resolve, reject) => {
      promise.then(resolve, reject);
    });
    const grandchild = Number(result.stdout.trim());
    expect(Number.isInteger(grandchild)).toBe(true);
    expect(process.kill(grandchild, 0)).toBe(true); // alive before the abort
    controller.abort();
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
    expect(() => process.kill(grandchild, 0)).toThrow();
  });

  it('kills a hung child on timeout and rejects with the deadline named', async () => {
    const promise = spawnHeadlessCli(
      process.execPath,
      ['-e', 'setInterval(()=>{},1e9)'],
      process.cwd(),
      { timeoutMs: 150, terminationGraceMs: 5_000 },
    );
    await expect(promise).rejects.toThrow(/timed out after 150ms/);
  });
});
```

Note on the grandchild test: the child's pid arrives on stdout; the abort kills the group (`-pid`), so both the child and its non-detached grandchild die. If `process.kill(pid, 0)` on the grandchild throws ESRCH, the group reaping worked.

- [ ] **Step 6: Run the real-process tests, verify they pass**

Run: `npx vitest run src/agent/headlessSpawn.test.ts`
Expected: PASS (8 tests), no orphaned `node -e setInterval` processes left behind (`pgrep -f "setInterval(()=>{},1e9)"` → nothing).

- [ ] **Step 7: Commit**

```bash
git add src/agent/headlessSpawn.ts src/agent/headlessSpawn.test.ts
git commit -m "feat(agent): bound headless CLI runs with timeout, abort kill and capped output"
```

---

### Task 2: Wire codex + opencode adapters to the shared spawner

**Files:**
- Modify: `src/agent/codex.ts` (defaultSpawn ~line 466-484, `runHeadless` line 748)
- Modify: `src/agent/opencode.ts` (defaultSpawn ~line 41-59, `runHeadless` line 646)
- Test: `src/agent/codex.test.ts`, `src/agent/opencode.test.ts`

**Interfaces:**
- Consumes: `spawnHeadlessCli` from `./headlessSpawn.js`; `HeadlessSpawnOptions` type.
- Produces: each adapter's local `SpawnHeadless` becomes `(command: string, args: string[], cwd: string, opts?: HeadlessSpawnOptions) => Promise<HeadlessSpawnResult>`; `defaultSpawn` delegates to `spawnHeadlessCli`.

- [ ] **Step 1: Widen the spawn seam and replace the implementation**

In `codex.ts`:

```ts
import { spawnHeadlessCli, type HeadlessSpawnOptions } from './headlessSpawn.js';
```

Replace the `SpawnHeadless` type (line ~460) with:

```ts
export type SpawnHeadless = (
  command: string,
  args: string[],
  cwd: string,
  opts?: HeadlessSpawnOptions,
) => Promise<HeadlessSpawnResult>;
```

Replace the `defaultSpawn` body (line ~466) with:

```ts
const defaultSpawn: SpawnHeadless = (command, args, cwd, opts) =>
  spawnHeadlessCli(command, args, cwd, opts);
```

In `runHeadless` (line 748) pass the signal:

```ts
const result = await this.spawnHeadless(CODEX_BIN, args, opts.cwd, {
  signal: opts.signal,
});
```

Make the IDENTICAL three changes in `opencode.ts` (its `SpawnHeadless` type at line 35, `defaultSpawn` at line 41, `runHeadless` spawn call at line 646), using `OPENCODE_BIN`.

- [ ] **Step 2: Add a signal-forwarding test to each adapter test**

In `codex.test.ts` (and `opencode.test.ts`), add:

```ts
it('forwards the abort signal into the headless spawn', async () => {
  let seenOpts: { signal?: AbortSignal } | undefined;
  const spawn: SpawnHeadless = async (_cmd, _args, _cwd, opts) => {
    seenOpts = opts;
    return { stdout: '{}', stderr: '', exitCode: 0 };
  };
  const adapter = new CodexAdapter(spawn);
  const controller = new AbortController();
  await adapter.runHeadless({
    prompt: 'hi',
    cwd: '/wt/a',
    signal: controller.signal,
  });
  expect(seenOpts?.signal).toBe(controller.signal);
});
```

(Adjust the stdout fixture to what the adapter's parser accepts: for codex a JSONL with `thread.started` and a completed agent message — reuse the existing fixtures from the file; for opencode `{"reasoning":[],"result":"ok"}` style — reuse existing fixtures.)

- [ ] **Step 3: Run the adapter suites, verify they pass**

Run: `npx vitest run src/agent/codex.test.ts src/agent/opencode.test.ts`
Expected: PASS — existing tests unchanged (their `async () => ({...})` fakes still satisfy the widened type), plus the new forwarding test.

- [ ] **Step 4: Commit**

```bash
git add src/agent/codex.ts src/agent/opencode.ts src/agent/codex.test.ts src/agent/opencode.test.ts
git commit -m "fix(agent): honor abort signal in codex and opencode headless runs"
```

---

### Task 3: Wire claude + antigravity adapters through `makeDefaultSpawn`

**Files:**
- Modify: `src/agent/claude.ts` (`makeDefaultSpawn` line 75-86, `runHeadless` line 300)
- Modify: `src/agent/antigravity.ts` (`makeDefaultSpawn` line 104-115, `runHeadless` line 231)
- Test: `src/agent/claude.test.ts` (makeDefaultSpawn block lines 13-80), `src/agent/antigravity.test.ts`

**Interfaces:**
- Consumes: `spawnHeadlessCli` from `./headlessSpawn.js`.
- Produces: `makeDefaultSpawn(spawnImpl: SpawnImpl): SpawnHeadless` still returns a `SpawnHeadless`; the returned function now accepts the optional 4th opts argument and delegates to `spawnHeadlessCli(..., spawnImpl)`.

- [ ] **Step 1: Replace `makeDefaultSpawn` bodies**

In `claude.ts`:

```ts
import { spawnHeadlessCli, type HeadlessSpawnOptions } from './headlessSpawn.js';
```

Widen the `SpawnHeadless` type (line ~57):

```ts
export type SpawnHeadless = (
  command: string,
  args: string[],
  cwd: string,
  opts?: HeadlessSpawnOptions,
) => Promise<HeadlessSpawnResult>;
```

Replace `makeDefaultSpawn` (lines 75-86):

```ts
export function makeDefaultSpawn(spawnImpl: SpawnImpl): SpawnHeadless {
  return (command, args, cwd, opts) =>
    spawnHeadlessCli(command, args, cwd, opts, spawnImpl);
}
```

The doc comment above it stays true: `stdio: ['ignore', 'pipe', 'pipe']` still closes stdin — now enforced inside `spawnHeadlessCli`.

In `runHeadless` (line 300):

```ts
const r = await this.spawnHeadless(CLAUDE_BIN, args, opts.cwd, {
  signal: opts.signal,
});
```

Make the IDENTICAL changes in `antigravity.ts` (type at line 96, `makeDefaultSpawn` at line 104, spawn call at line 231, using `AGY_BIN`).

- [ ] **Step 2: Update the `makeDefaultSpawn` tests for the new option shape**

The existing claude.test.ts `makeDefaultSpawn` block asserts `stdio[0] === 'ignore'` — keep that. Add an assertion that `detached` is set, by widening the captured options check:

```ts
const detached = (seenOptions as { detached?: boolean } | undefined)?.detached;
expect(detached).toBe(true);
```

Add a signal-forwarding test to `claude.test.ts` and `antigravity.test.ts` exactly as in Task 2 Step 2 (fixtures: claude needs `{"session_id":"s1","result":"ok"}` JSON on stdout; agy needs bare prose `ok`).

- [ ] **Step 3: Run the adapter suites, verify they pass**

Run: `npx vitest run src/agent/claude.test.ts src/agent/antigravity.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/agent/claude.ts src/agent/antigravity.ts src/agent/claude.test.ts src/agent/antigravity.test.ts
git commit -m "fix(agent): honor abort signal in claude and antigravity headless runs"
```

---

### Task 4: End-to-end verification

**Files:**
- Test: `src/agent/instrumentedAdapter.test.ts` (already covers failed-call recording — verify no change needed), `src/workflow/uat/tester.test.ts` (interrupted-on-abort path)

- [ ] **Step 1: Verify the interrupted path still records and stops**

Run: `npx vitest run src/agent/instrumentedAdapter.test.ts src/workflow/uat/tester.test.ts src/workflow/review/findingsLane.test.ts src/workflow/classify/analyze.test.ts src/workflow/stages/ship.test.ts`
Expected: PASS — the caller-side `opts.signal?.aborted` checks already handle a rejected adapter promise, so abort now kills the child AND yields `interrupted` (tester) / `stopped` (findings lane), which the existing tests pin.

- [ ] **Step 2: Typecheck and full suite**

Run: `npm run typecheck`
Expected: clean.

Run: `npm test`
Expected: all green (306 files baseline; +2 files from Task 1; no other count changes).

- [ ] **Step 3: Commit any residual fix (if the full run surfaced one)**

```bash
git add -A
git commit -m "fix(agent): tighten headless run bounds after end-to-end verification"
```

---

## Self-Review

**1. Spec coverage (ticket 869efxycx — memory leak + CPU spike from a leaked headless agent child):**
- Timeout kills a hung core → CPU spike bounded (Task 1 `timeoutMs`, wired in Tasks 2-3).
- Abort kill (Stop) reaps the group including grandchildren → the leaked `node` child with `/dev/null` stdin can no longer outlive its gate (Task 1 `signal` + `detached` group kill).
- Bounded output → host no longer buffers megabytes with O(n²) string concat (Task 1 `BoundedOutput`).
- All four adapters covered (Tasks 2-3); no surface left with the old unbounded spawner.

**2. Placeholder scan:** No TBDs; every step carries real code; the two adapter-parser fixtures reference the existing fixture patterns in each test file rather than invented shapes.

**3. Type consistency:** `HeadlessSpawnOptions`, `HeadlessSpawnResult`, `spawnHeadlessCli` names and shapes are identical across Tasks 1-3; the widened `SpawnHeadless` 4th parameter is the same `opts?: HeadlessSpawnOptions` in all four adapters; `makeDefaultSpawn` keeps its existing signature so claude/antigravity tests compile unchanged.
