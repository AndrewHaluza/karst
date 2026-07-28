# Codex Hook Bridge Reliability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make generated Codex lifecycle hooks complete deterministically, preserve their Karst endpoint side effects, and distinguish expected endpoint races from genuine invocation errors.

**Architecture:** Keep the generated standalone CommonJS bridge in Karst's configuration directory. Exercise that generated artifact as a subprocess against a real loopback server, then narrow its failure handling so successful responses and stale endpoints exit 0 while malformed Codex input and invalid bridge configuration exit 1 with sanitized diagnostics.

**Tech Stack:** TypeScript, Node.js CommonJS bridge, Node `http`, Vitest.

## Global Constraints

- Preserve the existing Codex event mappings and ticket-state behavior.
- Keep the bridge outside ticket worktrees.
- Keep `--dangerously-bypass-hook-trust` scoped to Karst-generated hook definitions by clearing inherited session hooks first.
- Never persist `cwd`, `session_id`, tool input, or response content in diagnostics.
- Follow strict RED→GREEN and run the full test, typecheck, and build gates before completion.

---

### Task 1: Bridge subprocess contract

**Files:**
- Modify: `src/agent/codex.test.ts`
- Modify: `src/agent/codex.ts`

**Interfaces:**
- Consumes: `CodexAdapter.buildInteractiveCommand(opts)` to generate `codex/bridge.cjs`.
- Produces: a generated bridge that reads one Codex JSON object from stdin and posts `{ hook_event_name, cwd, session_id, message? }` to its configured endpoint.

- [ ] **Step 1: Add a real bridge subprocess helper and round-trip tests**

In `src/agent/codex.test.ts`, import asynchronous `spawn` and `createServer`. Add a helper that starts the generated bridge, writes a literal JSON payload to stdin, captures stderr, and resolves its exit code. Add a loopback server helper that records parsed request bodies and returns an empty 204 response.

Add separate tests for `SessionStart` and `PostToolUse`. Use complete representative Codex inputs:

```ts
{
  hook_event_name: 'SessionStart',
  session_id: 'thread-1',
  cwd: '/wt',
  transcript_path: '/tmp/rollout.jsonl',
  model: 'gpt-5.6-sol',
  permission_mode: 'bypassPermissions',
  source: 'startup',
}
```

```ts
{
  hook_event_name: 'PostToolUse',
  session_id: 'thread-1',
  cwd: '/wt',
  transcript_path: '/tmp/rollout.jsonl',
  model: 'gpt-5.6-sol',
  permission_mode: 'bypassPermissions',
  turn_id: 'turn-1',
  tool_name: 'Bash',
  tool_use_id: 'call-1',
  tool_input: { command: 'git status --short' },
  tool_response: { output: '' },
}
```

Assert exit code 0, empty stderr, and literal normalized request bodies. This catches a bridge that exits before delivery, forwards sensitive event-specific fields, or fails under hook-trust bypass payloads.

- [ ] **Step 2: Run the focused tests to characterize current behavior**

Run:

```bash
npx vitest run src/agent/codex.test.ts -t "delivers a Codex"
```

Expected: the tests demonstrate whether the current generated bridge completes both real round trips. If they pass, retain them as characterization coverage and continue to the failing error-classification test in Step 3; production changes still remain gated by that RED test.

- [ ] **Step 3: Add failing tests for genuine invocation errors**

Execute the generated bridge with malformed JSON and with a valid JSON object missing `session_id`. Assert both processes exit with code 1, write no stderr, and append only symbolic outcomes to `hook-failures.jsonl`:

```ts
expect(result.exitCode).toBe(1);
expect(result.stderr).toBe('');
expect(diagnostic).toContain('"outcome":"invalid-json"');
expect(diagnostic).not.toContain('/wt');
expect(diagnostic).not.toContain('thread-1');
```

Also execute it with a valid hook payload but no endpoint argument and expect `invalid-endpoint` plus exit code 1. These tests catch the current blanket `process.exit(0)` behavior that silently suppresses genuine integration defects.

- [ ] **Step 4: Run the error tests and verify RED**

Run:

```bash
npx vitest run src/agent/codex.test.ts -t "rejects malformed|rejects missing|required endpoint"
```

Expected: FAIL because the current bridge exits 0 for malformed JSON, missing required fields, and an invalid endpoint.

- [ ] **Step 5: Implement classified completion in the generated bridge**

In `CODEX_HOOK_BRIDGE`, replace blanket process-level success handlers with one idempotent completion function:

```js
let finished = false;
function finish(exitCode, outcome) {
  if (finished) return;
  finished = true;
  if (outcome) logFailure(outcome);
  process.exit(exitCode);
}
```

Apply these outcomes:

- stdin beyond 64 KiB: `finish(1, 'input-too-large')`
- malformed JSON: `finish(1, 'invalid-json')`
- missing/wrongly typed common fields: `finish(1, 'invalid-input')`
- invalid endpoint URL: `finish(1, 'invalid-endpoint')`
- unsupported event: `finish(0)`
- response `end`: `finish(0)`
- request error: `finish(0, 'request-error')`
- request timeout: destroy the request; the request error path records the outcome and exits 0
- uncaught exception: `finish(1, 'uncaught-exception')`
- unhandled rejection: `finish(1, 'unhandled-rejection')`

Attach the successful completion to the response lifecycle:

```js
req.on('response', (res) => {
  res.resume();
  res.on('end', () => finish(0));
});
```

Do not include exception messages or input values in the diagnostic record.

- [ ] **Step 6: Run focused tests and verify GREEN**

Run:

```bash
npx vitest run src/agent/codex.test.ts
```

Expected: all Codex adapter tests pass, including successful delivery, stale endpoint diagnostics, and genuine input failures.

- [ ] **Step 7: Run mutation checks**

Temporarily reason through these mutations and confirm an existing assertion would fail for each:

- remove `req.end(payload)` → round-trip test fails to receive a request
- forward `tool_input` → literal `PostToolUse` body assertion fails
- change malformed JSON to exit 0 → malformed-input assertion fails
- include raw stdin in diagnostics → privacy assertions fail
- remove `--dangerously-bypass-hook-trust` or `hooks={}` → launch-argument assertions fail

No production mutation is retained.

- [ ] **Step 8: Commit the bridge change**

```bash
git add src/agent/codex.ts src/agent/codex.test.ts
git commit -m "fix: make Codex hook bridge failures deterministic"
```

### Task 2: Verification and completion

**Files:**
- Verify: `src/agent/codex.ts`
- Verify: `src/agent/codex.test.ts`

**Interfaces:**
- Consumes: the completed bridge behavior from Task 1.
- Produces: fresh evidence that the extension remains compatible and the ticket can advance.

- [ ] **Step 1: Run the complete automated test suite**

Run:

```bash
npm test
```

Expected: Vitest exits 0 with no failed tests.

- [ ] **Step 2: Run static type verification**

Run:

```bash
npm run typecheck
```

Expected: TypeScript exits 0 with no diagnostics.

- [ ] **Step 3: Build the extension**

Run:

```bash
npm run build
```

Expected: the extension and mirrored runtime assets build successfully.

- [ ] **Step 4: Review the final diff**

Run:

```bash
git diff HEAD^ --check
git status --short
```

Expected: no whitespace errors and no unintended files.

- [ ] **Step 5: Record implementation completion**

Run the exact ticket marker:

```bash
node "/Users/nd/.cursor/extensions/karst.karst-1.0.0/dist/cli/main.js" stage impl pass --db "/Users/nd/Library/Application Support/Cursor/User/globalStorage/karst.karst/karst.db" --manifest "/Users/nd/Work/projects/karst/.karst/karst.yml" --ticket 869e9537w
```

Expected: the marker succeeds and advances the ticket from implementation.
