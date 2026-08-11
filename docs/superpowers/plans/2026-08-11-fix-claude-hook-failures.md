# Fix Claude/Codex Hook Failures on Oversized Payloads — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop agent sessions (Claude Code and Codex) from printing hook failure errors when a hook payload exceeds karst's ingest cap.

**Architecture:** The hook endpoint (`src/hooks/endpoint.ts`) caps POST bodies at 64 KiB and answers 413, and the Codex bridge (`src/agent/codex.ts`'s embedded `bridge.cjs`) caps its stdin at 64 KiB and exits 1. Claude Code renders any non-2xx HTTP hook response as a `<hook> hook error` notice; Codex renders a non-zero hook exit as `hook exited with code 1`. Tool results ride hook payloads (`PostToolUse.tool_response` is the full tool result — "responses can be large", per the Claude Code hooks reference), so a single big tool call makes the session show a hook failure — a normal event made to look like a fault. The fix raises the ingest cap to 1 MiB and makes an over-cap body FAIL OPEN: the endpoint answers 204 and drains, the bridge exits 0 — the decline is still counted (`too-large` / `input-too-large`) so the diagnostic report keeps the evidence.

**Tech Stack:** TypeScript (ESM, `.js` import suffixes, `noUncheckedIndexedAccess`), Node `node:http` server, generated `.cjs`/`.js` bridge scripts (string templates that cannot import anything), vitest.

## Global Constraints

- The hook contract: the endpoint returns a fast 2xx so the agent never stalls or sees a failure for a normal event (T0.2 finding 2). Recording is observation-only and must never affect the contract — wrap recorder/debug calls in `try/catch` at the call site.
- Host-agnostic modules receive `debug` as an INJECTED callback, never by importing the logger.
- The ticket API (`POST /tickets`) keeps its own 64 KiB cap — ticket bodies are small (title + description); do not widen it.
- The opencode plugin (`src/agent/opencode.ts`) already fails open on oversized payloads; leave it at 64 KiB.
- Dated design docs under `docs/superpowers/plans/` and `docs/plans/00*` are a record and are NOT rewritten.
- `AGENTS.md` and `CLAUDE.md` at the repo root are identical mirrors; update both with the same sentence.
- Strict TDD (RED→GREEN); keep files small; `npm run typecheck` and `npx vitest run <file>` to verify.

---

### Task 1: Endpoint fails open on oversized hook bodies

**Files:**
- Modify: `src/hooks/endpoint.ts` (constants at :18-19, `HookEndpointOptions` :62-76, `onData` :184-190, `onEnd` :192-229, `onAborted` :177-182, deadline :146-149)
- Test: `src/hooks/endpoint.test.ts` (:207-218)

**Interfaces:**
- Consumes: `HookEndpointOptions` (existing), `HookChannelOutcome` from `../diagnostics/hookChannel.js`, `LogError`.
- Produces: `MAX_HOOK_BODY_BYTES = 1024 * 1024` (exported for tests), `MAX_TICKET_BODY_BYTES = 64 * 1024` (module-private), optional `debug?: (message: string) => void` on `HookEndpointOptions`. Oversized POSTs to `/hooks` return **204** (not 413), record `too-large`, and never dispatch.

- [ ] **Step 1: Write the failing test**

Replace the existing 413 test in `src/hooks/endpoint.test.ts`:

```ts
it('an oversized body is accepted (204), ignored, and counted as too-large', async () => {
  const recorder = createHookChannelRecorder();
  await ep.close();
  ep = await startHookEndpoint(store, 0, undefined, undefined, undefined, undefined, {
    recorder,
  });
  const id = ticketAt();
  const huge = 'x'.repeat(1024 * 1024 + 4096);
  const res = await fetch(ep.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hook_event_name: 'SessionStart', cwd: WT, pad: huge }),
  });
  await res.text().catch(() => '');
  expect(res.status).toBe(204);
  expect(getTicket(store, id).agentState).toBe('none');
  expect(recorder.snapshot().outcomes['too-large']).toBe(1);
});
```

Add a second test after it:

```ts
it('disconnects an oversized body that never finishes at the request deadline', async () => {
  await ep.close();
  ep = await startHookEndpoint(
    store,
    0,
    undefined,
    undefined,
    undefined,
    undefined,
    { requestTimeoutMs: 40 },
  );
  const id = ticketAt();
  let partial: Socket | undefined;
  await new Promise<void>((resolve, reject) => {
    partial = connect(ep.port, '127.0.0.1');
    partial.on('connect', () => {
      partial!.write(
        'POST /hooks HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 999999999\r\n\r\n' +
          'x'.repeat(1024 * 1024 + 4096),
      );
      resolve();
    });
    partial.on('error', reject);
  });

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('oversized hook socket was not disconnected')),
      1_000,
    );
    partial!.on('close', () => {
      clearTimeout(timer);
      resolve();
    });
  });
  expect(getTicket(store, id).agentState).toBe('none');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/hooks/endpoint.test.ts`
Expected: FAIL — the oversized test gets 413, not 204.

- [ ] **Step 3: Implement the endpoint change**

In `src/hooks/endpoint.ts`:

Replace the constant block:

```ts
/** Cap the accepted hook body — a local sender can't grow host memory unbounded. */
const MAX_BODY_BYTES = 64 * 1024;
```

with:

```ts
/**
 * Cap the accepted hook body. A tool result rides the hook payload
 * (PostToolUse `tool_response` is the full tool result and can legitimately be
 * large), so the cap is generous; a body over it is a normal event karst
 * declines to ingest, never a fault of the sender (see `onData`).
 */
export const MAX_HOOK_BODY_BYTES = 1024 * 1024;
/** Cap for the /tickets API — ticket bodies are small (title + description). */
const MAX_TICKET_BODY_BYTES = 64 * 1024;
```

Update the `onData` handler:

```ts
let body = '';
let settled = false;
/** True once a body crossed the cap — the 204 was sent, the rest is drained. */
let oversized = false;
```

and:

```ts
function onData(chunk: Buffer | string): void {
  if (oversized) return;
  body += chunk.toString();
  if (body.length > MAX_HOOK_BODY_BYTES) {
    oversized = true;
    body = '';
    observe('too-large');
    try {
      options.debug?.(
        `[hooks] declined oversized hook body (>${MAX_HOOK_BODY_BYTES} bytes)`,
      );
    } catch {
      // Diagnostics are best-effort.
    }
    try {
      res.writeHead(204);
      res.end();
    } catch {
      // Socket already gone — nothing to answer.
    }
    req.resume();
  }
}
```

Update the deadline so a drained-but-unfinished request cannot leak:

```ts
const deadline = setTimeout(() => {
  if (settled || oversized) {
    // The response was already sent (a 2xx, or the 204 of a declined oversized
    // body); a sender that still holds the socket is disconnected here so a
    // slow upload cannot leak the connection.
    if (!req.destroyed) req.destroy();
    return;
  }
  observe('timeout');
  finish(408, true);
}, requestTimeoutMs);
```

Update `onAborted` so a declined request's disconnect is not counted as `aborted`:

```ts
function onAborted(): void {
  if (settled) return;
  settled = true;
  if (oversized) {
    // The 204 was already sent; the sender's socket went away (or the drain
    // deadline disconnected it). Nothing was left to answer — record nothing.
    cleanup();
    return;
  }
  observe('aborted');
  cleanup();
}
```

Update `onEnd` to settle a declined request once the drain finishes:

```ts
function onEnd(): void {
  if (settled) return;
  if (oversized) {
    settled = true;
    cleanup();
    return;
  }
  // ... existing parse + dispatch + finish(204) unchanged ...
}
```

Update the `ticketApi` call to use the ticket cap and add the debug option to `HookEndpointOptions`:

```ts
maxBodyBytes: MAX_TICKET_BODY_BYTES,
```

```ts
export interface HookEndpointOptions {
  requestTimeoutMs?: number;
  /** Observation only ... (unchanged) */
  recorder?: HookChannelRecorder;
  /** Debug callback (host binds `logger.debug`) — best-effort, never affects the contract. */
  debug?: (message: string) => void;
  /** Ticket-creation API ... (unchanged) */
  ticketApi?: TicketApiOptions;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/hooks/endpoint.test.ts`
Expected: PASS — oversized body → 204 + `too-large` counted; stalled oversized sender → socket closed at the deadline; all existing endpoint tests still pass.

- [ ] **Step 5: Commit**

```bash
git add src/hooks/endpoint.ts src/hooks/endpoint.test.ts
git commit -m "fix: hook endpoint fails open on oversized hook bodies"
```

---

### Task 2: Codex bridge fails open on oversized hook input

**Files:**
- Modify: `src/agent/codex.ts` (bridge template, `process.stdin.on('data', ...)` at :169-174)
- Modify: `src/agent/hookFailureLog.ts` (doc comment on `HOOK_BRIDGE_OUTCOMES` :24-27)
- Test: `src/agent/codex.test.ts` (add after the "fails open with diagnostics when the endpoint aborts its response" test at :611)

**Interfaces:**
- Consumes: `materializeBridge(configDir)` and `runBridge(...)` test helpers (existing); `spawn` + `resolveNodeExecutable` (existing).
- Produces: The bridge exits **0** (was 1) with outcome `input-too-large` recorded when stdin exceeds 1 MiB — a Codex session never renders a hook failure for a big tool output.

- [ ] **Step 1: Write the failing test**

Add to `src/agent/codex.test.ts`:

```ts
it('fails open on an oversized hook input, recording the decline', async () => {
  const configDir = makeWorktree();
  const bridgePath = materializeBridge(configDir);
  const diagnosticsPath = join(configDir, 'codex', 'hook-failures.jsonl');
  const oversized = JSON.stringify({
    hook_event_name: 'PostToolUse',
    session_id: 'thread-1',
    cwd: '/wt',
    tool_output: 'x'.repeat(1024 * 1024),
  });

  // The bridge exits while the parent is still writing stdin, so the EPIPE
  // error on this side is expected and must not fail the test.
  const result = await new Promise<{ exitCode: number; stderr: string }>(
    (resolve, reject) => {
      const child = spawn(
        resolveNodeExecutable(),
        [bridgePath, 'http://127.0.0.1:4567/hooks', diagnosticsPath],
        { stdio: ['pipe', 'ignore', 'pipe'] },
      );
      let stderr = '';
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => {
        stderr += chunk;
      });
      child.on('error', reject);
      child.on('close', (code) => resolve({ exitCode: code ?? 1, stderr }));
      child.stdin.on('error', () => {});
      child.stdin.end(oversized);
    },
  );

  expect(result).toEqual({ exitCode: 0, stderr: '' });
  const diagnostics = readFileSync(diagnosticsPath, 'utf8');
  expect(diagnostics).toContain('"outcome":"input-too-large"');
  expect(diagnostics).not.toContain('/wt');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/agent/codex.test.ts -t "oversized hook input"`
Expected: FAIL — exit code is 1, not 0.

- [ ] **Step 3: Implement the bridge change**

In `src/agent/codex.ts`, inside the `CODEX_HOOK_BRIDGE` template:

```js
process.stdin.on('data', (chunk) => {
  input += chunk;
  // A tool output rides the hook input and can legitimately be large; the
  // bridge only needs the small fields, so an oversized input is DECLINED,
  // never a failure — exit 0 keeps the agent from rendering a hook error,
  // and the decline is logged for the diagnostic report. Mirrors the hook
  // endpoint's oversized-body contract (MAX_HOOK_BODY_BYTES = 1 MiB).
  if (input.length > 1024 * 1024) finish(0, 'input-too-large');
});
```

In `src/agent/hookFailureLog.ts`, update the doc comment:

```ts
/**
 * Outcomes the bridge writes. `request-error` is the expected IDE-lifecycle race
 * (the endpoint went away) and exits 0; `input-too-large` is a normal event the
 * bridge declined (tool outputs ride hook inputs) and ALSO exits 0. Every other
 * outcome exits 1 and is what the agent renders as `PostToolUse hook (failed) —
 * hook exited with code 1`.
 *
 * `http-error` and `request-error` carry a bounded detail suffix ... (unchanged)
 */
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/agent/codex.test.ts`
Expected: PASS — oversized input → exit 0 + `input-too-large` recorded; all existing bridge tests still pass.

- [ ] **Step 5: Commit**

```bash
git add src/agent/codex.ts src/agent/codex.test.ts src/agent/hookFailureLog.ts
git commit -m "fix: codex hook bridge fails open on oversized hook input"
```

---

### Task 3: Wire the endpoint debug callback and record the invariant

**Files:**
- Modify: `src/extension.ts` (endpoint options at :2562-2576)
- Modify: `AGENTS.md` and `CLAUDE.md` (hook bullet — identical wording in both)

**Interfaces:**
- Consumes: `logger` (already in scope in `activate`, see `logError` at :472 and the `debug: (message) => logger.debug(message)` pattern at :562).
- Produces: The endpoint's oversized-decline decision appears in the Karst output channel under `debug: true`; the invariant is recorded in the repo's binding docs.

- [ ] **Step 1: Add the debug binding**

In `src/extension.ts` at the `startHookEndpoint` options object:

```ts
{
  recorder: hookChannelRecorder,
  debug: (message) => logger.debug(message),
  ticketApi: { ... },
}
```

- [ ] **Step 2: Record the invariant**

Append to the "A hook failure has two halves..." bullet in `AGENTS.md` and `CLAUDE.md` (identical files):

"**An oversized hook body is a normal event, never a fault of the sender.** Tool results ride hook payloads (Claude Code's `PostToolUse.tool_response` is the full tool result — "responses can be large"), so a body over the 1 MiB ingest cap (`MAX_HOOK_BODY_BYTES`, mirrored in the Codex bridge) is DECLINED, not errored: the endpoint answers 204 and drains, the bridge exits 0 — the agent must never render a hook failure for a payload that merely exceeded the cap; both sides still count the decline (`too-large` / `input-too-large`) for the report. The ticket API keeps its own 64 KiB cap; ticket bodies are small."

- [ ] **Step 3: Verify**

Run: `npm run typecheck`
Expected: PASS (no type errors anywhere).

Run: `npx vitest run src/hooks/endpoint.test.ts src/agent/codex.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/extension.ts AGENTS.md CLAUDE.md
git commit -m "docs: record oversized-hook-body fail-open invariant and wire debug logging"
```

---

### Task 4: Full verification

- [ ] **Step 1: Run the full test suite**

Run: `npm test`
Expected: PASS (all suites).

- [ ] **Step 2: Run the build**

Run: `npm run build`
Expected: PASS (compile + webview asset copy).

- [ ] **Step 3: Review the diff for the no-placeholder checklist**

Run: `git diff origin/develop --stat` — the change touches only: `src/hooks/endpoint.ts`, `src/hooks/endpoint.test.ts`, `src/agent/codex.ts`, `src/agent/codex.test.ts`, `src/agent/hookFailureLog.ts`, `src/extension.ts`, `AGENTS.md`, `CLAUDE.md`.
Verify no `docs/plans/` or `docs/superpowers/plans/` files were touched (they are a record, never rewritten).
