# Batch Live Gate-Console Output Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `GateConsole` posts one `onOutput` and logs one `[gate]` debug line per flush, not per stdout chunk.

**Architecture:** `append` still sanitizes and computes the per-gate header, but appends to a per-(ticket, stage) buffer. The buffer flushes on a 150 ms timer, when it reaches 16 KB, when a different gate speaks, on `reset`, and on an explicit `flush` called when the driver run ends. `extension.ts` calls `flush` in `driveTicket`'s `finally`.

**Tech Stack:** TypeScript (ESM, `.js` import suffixes), vitest fake timers.

**Spec:** ticket PERF-BATCH-LIVE-GATE-CONSOLE context brief (D219); `docs/arch/debug-logging.md` `arch:DBG-02`, `DBG-03`.

## Global Constraints

- Webview `stage-output` message shape unchanged.
- Debug content never logged; length only (DBG-03). Prefix stays `[gate]`.
- `append`/`flush` never throw; post failure keeps the `live post failed` debug line.
- Host-agnostic: no `vscode` import; `setTimeout`/`clearTimeout` only.
- Mutation gate >= 85 for `src/extension/**` only; this file is under `src/workflow`, but keep tests tight anyway.

---

### Task 1: Buffered GateConsole

**Files:**
- Modify: `src/workflow/gates/gateConsole.ts`
- Test: `src/workflow/gates/gateConsole.test.ts`

**Interfaces:**
- Produces: `GateConsole.flush(ticketId: number, stage: GateStage): void`, `GateConsole.dispose(): void`; exported consts `GATE_CONSOLE_FLUSH_MS = 150`, `GATE_CONSOLE_MAX_BUFFER = 16_384`. `append` and `reset` signatures unchanged.

- [ ] **Step 1: Update tests.** Existing tests assert a post per `append`; make `sink()` call `console.flush(...)` where needed. Add `vi.useFakeTimers()` in `beforeEach`, `vi.useRealTimers()` in `afterEach`. Replace the file with:

```ts
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { GATE_CONSOLE_FLUSH_MS, GATE_CONSOLE_MAX_BUFFER, GateConsole } from './gateConsole.js';

function sink() {
  const posted: { ticketId: number; stage: string; text: string }[] = [];
  const debugLines: string[] = [];
  const console = new GateConsole({
    onOutput: (ticketId, stage, text) => posted.push({ ticketId, stage, text }),
    debug: (m) => debugLines.push(m),
  });
  return { console, posted, debugLines };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('GateConsole', () => {
  it('batches chunks inside the window into one post and one debug line', () => {
    const { console, posted, debugLines } = sink();
    console.append(7, 'uat', 'visual', { stream: 'stdout', text: 'a\n' });
    console.append(7, 'uat', 'visual', { stream: 'stderr', text: 'b\n' });
    console.append(7, 'uat', 'visual', { stream: 'stdout', text: 'c\n' });
    expect(posted).toEqual([]);
    vi.advanceTimersByTime(GATE_CONSOLE_FLUSH_MS);
    expect(posted).toEqual([{ ticketId: 7, stage: 'uat', text: '\n$ visual\na\nb\nc\n' }]);
    expect(debugLines).toEqual(['[gate] console uat ticket 7: visual +6 chars in 3 chunks']);
  });

  it('does not flush before the window elapses', () => {
    const { console, posted } = sink();
    console.append(7, 'uat', 'unit', { stream: 'stdout', text: 'a' });
    vi.advanceTimersByTime(GATE_CONSOLE_FLUSH_MS - 1);
    expect(posted).toEqual([]);
  });

  it('flushes the old gate before the new gate header', () => {
    const { console, posted } = sink();
    console.append(7, 'uat', 'unit', { stream: 'stdout', text: 'a' });
    console.append(7, 'uat', 'lint', { stream: 'stdout', text: 'b' });
    expect(posted.map((p) => p.text)).toEqual(['\n$ unit\na']);
    console.flush(7, 'uat');
    expect(posted.map((p) => p.text)).toEqual(['\n$ unit\na', '\n$ lint\nb']);
  });

  it('flush posts the pending buffer synchronously and cancels the timer', () => {
    const { console, posted } = sink();
    console.append(7, 'uat', 'unit', { stream: 'stdout', text: 'a' });
    console.flush(7, 'uat');
    expect(posted).toHaveLength(1);
    vi.advanceTimersByTime(GATE_CONSOLE_FLUSH_MS * 2);
    expect(posted).toHaveLength(1);
  });

  it('flush with nothing pending posts nothing', () => {
    const { console, posted, debugLines } = sink();
    console.flush(7, 'uat');
    expect(posted).toEqual([]);
    expect(debugLines).toEqual([]);
  });

  it('flushes early once the buffer reaches the size cap', () => {
    const { console, posted } = sink();
    console.append(7, 'uat', 'unit', { stream: 'stdout', text: 'x'.repeat(GATE_CONSOLE_MAX_BUFFER) });
    expect(posted).toHaveLength(1);
    vi.advanceTimersByTime(GATE_CONSOLE_FLUSH_MS);
    expect(posted).toHaveLength(1);
  });

  it('keeps the header once per gate across flushes', () => {
    const { console, posted } = sink();
    console.append(7, 'uat', 'unit', { stream: 'stdout', text: 'a' });
    vi.advanceTimersByTime(GATE_CONSOLE_FLUSH_MS);
    console.append(7, 'uat', 'unit', { stream: 'stdout', text: 'b' });
    vi.advanceTimersByTime(GATE_CONSOLE_FLUSH_MS);
    expect(posted.map((p) => p.text)).toEqual(['\n$ unit\na', 'b']);
  });

  it('strips control sequences that would hijack the console', () => {
    const { console, posted } = sink();
    console.append(7, 'review', 'lint', { stream: 'stdout', text: '\x1b]0;pwned\x07\x1b[2Jok\x1b[32mgreen\x1b[0m' });
    console.flush(7, 'review');
    expect(posted[0]!.text).toBe('\n$ lint\nok\x1b[32mgreen\x1b[0m');
  });

  it('drops a chunk that sanitizes to nothing — no header, no post, no timer', () => {
    const { console, posted } = sink();
    console.append(7, 'uat', 'unit', { stream: 'stdout', text: '\x1b[2J' });
    vi.advanceTimersByTime(GATE_CONSOLE_FLUSH_MS);
    expect(posted).toEqual([]);
  });

  it('keeps each ticket/stage buffer independent', () => {
    const { console, posted } = sink();
    console.append(7, 'uat', 'unit', { stream: 'stdout', text: 'a' });
    console.append(8, 'uat', 'unit', { stream: 'stdout', text: 'b' });
    console.append(7, 'review', 'unit', { stream: 'stdout', text: 'c' });
    vi.advanceTimersByTime(GATE_CONSOLE_FLUSH_MS);
    expect(posted.map((p) => [p.ticketId, p.stage, p.text])).toEqual([
      [7, 'uat', '\n$ unit\na'],
      [8, 'uat', '\n$ unit\nb'],
      [7, 'review', '\n$ unit\nc'],
    ]);
  });

  it('reset flushes pending output, then re-headers the next chunk', () => {
    const { console, posted } = sink();
    console.append(7, 'uat', 'unit', { stream: 'stdout', text: 'a' });
    console.reset(7, 'uat');
    expect(posted.map((p) => p.text)).toEqual(['\n$ unit\na']);
    console.append(7, 'uat', 'unit', { stream: 'stdout', text: 'b' });
    console.flush(7, 'uat');
    expect(posted.map((p) => p.text)).toEqual(['\n$ unit\na', '\n$ unit\nb']);
  });

  it('never throws when the live sink does, and logs the failure', () => {
    const debugLines: string[] = [];
    const console = new GateConsole({
      onOutput: () => {
        throw new Error('panel gone');
      },
      debug: (m) => debugLines.push(m),
    });
    console.append(1, 'uat', 'unit', { stream: 'stdout', text: 'a' });
    expect(() => console.flush(1, 'uat')).not.toThrow();
    expect(debugLines.some((l) => l.includes('live post failed (panel gone)'))).toBe(true);
  });

  it('dispose cancels timers without posting', () => {
    const { console, posted } = sink();
    console.append(7, 'uat', 'unit', { stream: 'stdout', text: 'a' });
    console.dispose();
    vi.advanceTimersByTime(GATE_CONSOLE_FLUSH_MS * 2);
    expect(posted).toEqual([]);
  });
});
```

- [ ] **Step 2: Run, expect FAIL** (missing exports/`flush`): `npx vitest run src/workflow/gates/gateConsole.test.ts`

- [ ] **Step 3: Implement.** Replace the class body of `gateConsole.ts` (keep the header doc comment, add a paragraph about batching):

```ts
export const GATE_CONSOLE_FLUSH_MS = 150;
export const GATE_CONSOLE_MAX_BUFFER = 16_384;

interface Pending {
  readonly ticketId: number;
  readonly stage: GateStage;
  readonly gateName: string;
  text: string;
  chars: number;
  chunks: number;
  timer: ReturnType<typeof setTimeout> | undefined;
}

export class GateConsole {
  /** The gate whose output was last buffered, per (ticketId, stage). */
  private readonly currentGate = new Map<string, string>();
  private readonly pending = new Map<string, Pending>();

  constructor(private readonly options: GateConsoleOptions) {}

  private key(ticketId: number, stage: GateStage): string {
    return `${ticketId}:${stage}`;
  }

  /**
   * Receive one raw chunk of a running gate's output: sanitize it, prefix a
   * header the first time a given gate speaks, and buffer it. The buffer is
   * posted as ONE live append per flush (timer, size cap, gate change, reset,
   * or `flush` at run end). Never throws.
   */
  append(ticketId: number, stage: GateStage, gateName: string, chunk: GateOutputChunk): void {
    const clean = sanitizeAgentOutput(chunk.text);
    if (clean.length === 0) return;
    const key = this.key(ticketId, stage);
    if (this.pending.get(key)?.gateName !== gateName) this.flushKey(key);
    const header = this.currentGate.get(key) === gateName ? '' : `\n$ ${gateName}\n`;
    this.currentGate.set(key, gateName);
    const entry = this.pending.get(key) ?? { ticketId, stage, gateName, text: '', chars: 0, chunks: 0, timer: undefined };
    entry.text += `${header}${clean}`;
    entry.chars += clean.length;
    entry.chunks += 1;
    this.pending.set(key, entry);
    if (entry.text.length >= GATE_CONSOLE_MAX_BUFFER) {
      this.flushKey(key);
    } else if (entry.timer === undefined) {
      entry.timer = setTimeout(() => this.flushKey(key), GATE_CONSOLE_FLUSH_MS);
    }
  }

  /** Post any buffered output now (call when a gate run ends). */
  flush(ticketId: number, stage: GateStage): void {
    this.flushKey(this.key(ticketId, stage));
  }

  /** Flush, then forget which gate is current, so the next chunk re-headers. */
  reset(ticketId: number, stage: GateStage): void {
    this.flush(ticketId, stage);
    this.currentGate.delete(this.key(ticketId, stage));
  }

  /** Cancel every pending timer; buffered output is discarded. */
  dispose(): void {
    for (const entry of this.pending.values()) clearTimeout(entry.timer);
    this.pending.clear();
  }

  private flushKey(key: string): void {
    const entry = this.pending.get(key);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.pending.delete(key);
    const { ticketId, stage, gateName } = entry;
    this.options.debug?.(
      `[gate] console ${stage} ticket ${ticketId}: ${gateName} +${entry.chars} chars in ${entry.chunks} chunks`,
    );
    try {
      this.options.onOutput?.(ticketId, stage, entry.text);
    } catch (error) {
      this.options.debug?.(
        `[gate] console ${stage} ticket ${ticketId}: live post failed (${error instanceof Error ? error.message : String(error)})`,
      );
    }
  }
}
```

- [ ] **Step 4: Run, expect PASS:** `npx vitest run src/workflow/gates/gateConsole.test.ts`

- [ ] **Step 5: Commit**
```bash
git add src/workflow/gates/gateConsole.ts src/workflow/gates/gateConsole.test.ts docs/superpowers/plans/2026-10-21-batch-live-gate-console.md
git commit -m "perf: batch live gate-console output per flush"
```

### Task 2: Flush at run end

**Files:**
- Modify: `src/extension.ts` (`driveTicket`, ~line 3575 `reset` calls and its `finally`)

**Interfaces:**
- Consumes: `GateConsole.flush(ticketId, stage)`.

- [ ] **Step 1:** Read the `finally` block of `driveTicket` in `src/extension.ts` (after the `driveTicketRun` try). Add, as the first statements of that `finally`:
```ts
      gateConsole.flush(ticketId, 'uat');
      gateConsole.flush(ticketId, 'review');
```
so the last lines land before the driver releases the ticket and the verdict refresh.
- [ ] **Step 2:** If `context.subscriptions` is in scope near `gateConsole`'s construction, add `context.subscriptions.push({ dispose: () => gateConsole.dispose() });`. If not in scope, skip (timers are short-lived).
- [ ] **Step 3:** `npm run -s typecheck` — expect clean.
- [ ] **Step 4:** `npx vitest related src/extension.ts src/workflow/gates/gateConsole.ts` — expect PASS (`src/extension/ops/ratchet.test.ts` must still pass; this adds only binding calls).
- [ ] **Step 5:** Commit: `git commit -am "perf: flush gate console when the driver run ends"`.

## Self-Review

- Timer flush (150 ms), size cap (16 KB), gate-switch flush, finish flush, one `onOutput` + one debug line per flush, failure path, dispose: Tasks 1–2.
- Webview contract untouched: `onOutput(ticketId, stage, text)` same shape.
- Names consistent: `flush`, `dispose`, `GATE_CONSOLE_FLUSH_MS`, `GATE_CONSOLE_MAX_BUFFER`.

## Implementation note

`extension.ts` is under a line-count ratchet (`ratchet.test.ts`), so Task 2 uses `GateConsole.flushTicket(ticketId)` in `finally` and `resetTicket(ticketId)` at run start (each covers `uat` + `review`), net zero lines.
