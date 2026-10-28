# MCP fix-brief ack + done-marker channel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** MCP `fix-brief {ack:true}` works first call; the fix pointer and fix brief name the done marker in the session's channel form (MCP `stage` vs `$KARST_CLI`).

**Architecture:** Root cause: `fix-brief` declares `globals: { db: true }` only, so the MCP server never injects the implicit ticket and the CLI throws `missing ticket key`. Fix = declare `ticket: true`, make the MCP encoder emit ONE `--ticket` (explicit `ticket`/`key` input wins; `globalArgv` skips the implicit one when argv already has `--ticket`). Separately, `messagePointer` gets a done-marker `follow` line per channel, and `composeFixSnapshot` passes `mcpStage` to the existing `renderDoneMarkerInstruction` when the session channel is `mcp`.

**Tech Stack:** TypeScript ESM (`.js` import suffix), vitest.

**Spec:** ticket T829 description (`karst context FIX-MCP-FIX-BRIEF-ACK-FAILS-WITH`), arch AC-34 (sandbox), AC-38.

## Global Constraints

- Files import with `.js` suffix; `noUncheckedIndexedAccess` on (use `!`/guards).
- CLI `fix-brief <key>` and `fix-brief --ticket <key>` behave exactly as before (parser `parseFixBriefArgs` untouched).
- Existing refusal wording (`MARKER_REFUSED`) unchanged.
- Sandbox pointer keeps its current `emit-ack.cjs` form; no `$KARST_CLI`/MCP text there. A sandbox pointer's marker line must use the sandbox form (`emit-marker`), see Task 2.
- Pointers go through `printable()` (ASCII only) — no em dashes/unicode in new text.
- Tests: run single files with `npx vitest run <file>`; full suite once at end. Mutation gate >= 85 for `src/extension/**` changes.
- Scope decision (ticket note): keep BOTH `ticket` and `key` inputs; explicit one wins. No input field removed, so scenarios 2-4 stand.

---

### Task 1: fix-brief takes the implicit ticket; explicit input wins

**Files:**
- Modify: `src/cli/registry.ts:442-455` (fix-brief spec)
- Modify: `src/cli/mcp/tools.ts:91-98` (`globalArgv`) and `src/cli/mcp/server.ts:66`
- Test: `src/cli/mcp/server.test.ts` (~line 90-105), `src/cli/schemaCommand.test.ts` (~line 42), `src/cli/commandInput.test.ts`, `src/cli/fixBriefCommand.test.ts`

**Interfaces:**
- Produces: `globalArgv(spec, config, argv: readonly string[] = [])` — skips `--ticket` when `argv` already contains `'--ticket'`. fix-brief `toArgv` emits at most one `--ticket <value>` (never a positional).

- [ ] **Step 1: Failing tests** in `server.test.ts` `describe('globalArgv')`:

```ts
it('fix-brief injects the implicit ticket', () => {
  expect(globalArgv(getCommandSpec('fix-brief')!, { db: '/db', ticket: 'K-1' })).toEqual(['--db', '/db', '--ticket', 'K-1']);
});
it('skips the implicit ticket when argv already carries --ticket', () => {
  const spec = getCommandSpec('fix-brief')!;
  expect(globalArgv(spec, { db: '/db', ticket: 'K-1' }, ['fix-brief', '--ticket', 'K-2'])).toEqual(['--db', '/db']);
});
```
(replace the existing line-103 expectation `['--db','/db']` with a config that has no `ticket`, or keep it — it stays valid when config.ticket is unset.) Add an `encodeToolArgv` test: `{key:'K-2', ack:true}` -> `['fix-brief','--ack','--ticket','K-2']`; `{ticket:'K-3'}` -> `['fix-brief','--ticket','K-3']`; `{key:'K-2', ticket:'K-3'}` -> `ticket` wins (`--ticket K-3`). Add an end-to-end style test (via `runCli` with the stored fix delivery as in `fixBriefCommand.test.ts`): argv `[...encode({ack:true}), ...globalArgv(spec,{db,ticket:'K-1'}, encoded)]` succeeds; explicit `key:'K-2'` returns K-2's brief. In `schemaCommand.test.ts` add `expect(JSON.parse(runSchemaCommand(['schema','fix-brief'])).globals).toMatchObject({ db: true, ticket: true })`.

- [ ] **Step 2:** `npx vitest run src/cli/mcp/server.test.ts src/cli/schemaCommand.test.ts` — expect FAIL.

- [ ] **Step 3: Implement.**

registry.ts:
```ts
    input: obj({ key: str, ticket: str, ack: bool }),
    globals: { db: true, ticket: true },
    toArgv: (input) => {
      const argv = ['fix-brief'];
      pushFlag(argv, '--ack', input.ack);
      // One ticket spelling only: the CLI refuses key + --ticket, and the MCP
      // server appends the implicit --ticket after this argv. An explicit
      // input (ticket over key) is emitted as --ticket so globalArgv can see it.
      const explicit = input.ticket !== undefined ? requireString(input, 'ticket') : input.key !== undefined ? requireString(input, 'key') : undefined;
      if (explicit !== undefined) argv.push('--ticket', explicit);
      return argv;
    },
```
tools.ts:
```ts
export function globalArgv(spec: CommandSpec, config: McpServerConfig, argv: readonly string[] = []): string[] {
  ...
  if (globals.ticket && config.ticket && !argv.includes('--ticket')) out.push('--ticket', config.ticket);
```
(rename local accumulator to avoid clashing with the new param). server.ts:66:
```ts
const encoded = encodeToolArgv(spec, value);
argv = [...encoded, ...globalArgv(spec, config, encoded)];
```
Check `server.ts` surrounding scope for existing `encoded` name; keep `argv` assignment semantics.

- [ ] **Step 4:** rerun the two files + `src/cli/commandInput.test.ts src/cli/fixBriefCommand.test.ts src/cli/composersEnvRefs.test.ts` — expect PASS. Note: other tools using `ticket: true` (stage etc.) never see `--ticket` in `toArgv`, so skip-logic is inert for them; do not change their behavior.

- [ ] **Step 5: Commit**
```bash
git add src/cli && git commit -m "fix: MCP fix-brief takes the implicit ticket; explicit key/ticket wins with a single --ticket"
```

---

### Task 2: Fix pointer carries the done-marker line per channel

**Files:**
- Modify: `src/workflow/messageDelivery.ts` (`POINTER_TEXT.fix.follow`, `messagePointer` ~line 160-176)
- Test: `src/workflow/messageDelivery.test.ts`, `src/extension/ops/fixDeliveryWiring.test.ts:97` (existing exact-string expectation must be updated)

**Interfaces:**
- Produces: `follow` becomes `(channel) => string` for fix. Fix-pointer suffixes:
  - mcp: `; when the fix is committed and checks pass, fire the done marker: call the karst MCP tool "stage" with { stage: "fix" }`
  - cli-env: `; when the fix is committed and checks pass, fire the done marker: run node "$KARST_CLI" stage fix pass --db "$KARST_DB" --ticket "$KARST_TICKET_ID"` (use the same `karstCliRefs()`/`envRef` helpers as the fetch command; omit manifest, like the pointer's fetch line)
  - sandbox: `; when the fix is committed and checks pass, fire the done marker: run node <runDir>/<core>/emit-marker.cjs <runDir>/events.ndjson fix`
- Before coding: read `renderSandboxMarkerInstruction` (grep in `src/agent/`) and copy its exact emit-marker invocation for the sandbox form; do not invent the script name.

- [ ] **Step 1: Failing tests** in `messageDelivery.test.ts`: for `fixPointer(7)`: mcp result contains `fire the done marker: call the karst MCP tool "stage" with { stage: "fix" }` and contains no `$KARST_CLI`; cli-env result contains `stage fix pass` and `"$KARST_CLI"`; sandbox result contains the emit-marker form and no `stage fix pass`; mail and notes pointers unchanged (notes keeps its informational follow). Update `fixDeliveryWiring.test.ts:97` to the new full cli-env string.
- [ ] **Step 2:** `npx vitest run src/workflow/messageDelivery.test.ts src/extension/ops/fixDeliveryWiring.test.ts` — expect FAIL.
- [ ] **Step 3: Implement.** Change `POINTER_TEXT` entries' `follow` to `(channel: DeliveryChannel) => string` (mail `() => ''`, notes `() => '; informational...'`, fix as above) and call `follow(channel)` in all three branches. Pointer is a single line; keep it one sentence.
- [ ] **Step 4:** rerun both files, plus `src/hooks/mailReply` tests and `npx vitest related src/workflow/messageDelivery.ts` — expect PASS (fix any other exact-string pointer assertions the related run flags).
- [ ] **Step 5: Commit** `fix: fix pointer names the done marker in the session's channel form`

---

### Task 3: Fix brief marker paragraph follows the channel

**Files:**
- Modify: `src/extension/ops/fixDeliveryWiring.ts:44-70` (`composeFixSnapshot`), call sites ~161/165
- Test: `src/extension/ops/fixDeliveryWiring.test.ts` (~line 65-80)

**Interfaces:**
- Consumes: existing `renderDoneMarkerInstruction(stageCommand, ticketArg, mcpStage?)` (already renders the MCP form + CLI fallback + refusal wording).
- Produces: `composeFixSnapshot(store, ticketId, literal, sandbox?, mcp = false)`; when `mcp` the marker is `renderDoneMarkerInstruction(cmd, key, 'fix')`.
- Call sites pass `deps.sessionChannel(ticketId) === 'mcp'`.

- [ ] **Step 1: Failing test:** `composeFixSnapshot(store, ticketId, LITERAL, undefined, true).body` contains `call the karst MCP tool \`stage\` with { stage: "fix" }` and still contains `MARKER_REFUSED` text (import it the way the existing test file imports shared strings, or assert the substring `is refused`); default (no mcp) body unchanged from current assertions and contains `run \`node "/ext/dist/cli.js" stage fix pass`.
- [ ] **Step 2:** `npx vitest run src/extension/ops/fixDeliveryWiring.test.ts` — FAIL.
- [ ] **Step 3: Implement** the optional param; thread `mcp` through both `composeFixSnapshot` calls (lines ~161, ~165) using `deps.sessionChannel(ticketId) === 'mcp'`. The stored snapshot is per-delivery; channel is read at compose time (same moment the pointer is chosen), which is acceptable because a session keeps its channel for its life.
- [ ] **Step 4:** rerun file — PASS. Also `npx vitest related src/extension/ops/fixDeliveryWiring.ts`.
- [ ] **Step 5: Commit** `fix: fix brief marker paragraph uses the MCP form for MCP sessions`

---

### Task 4: Verification

- [ ] `npm run -s typecheck`
- [ ] `npx vitest related src/cli/registry.ts src/cli/mcp/tools.ts src/cli/mcp/server.ts src/workflow/messageDelivery.ts src/extension/ops/fixDeliveryWiring.ts`
- [ ] `npx stryker run --mutate src/extension/ops/fixDeliveryWiring.ts` then `node scripts/mutationSummary.mjs | tail -30`; add tests for survivors (score >= 85).
- [ ] `npm run -s test:unit 2>&1 | tail -15` once.
- [ ] Doc: grep `docs/arch/cli.md` / `docs/arch/stages-and-gates.md` for fix-brief globals or pointer wording (`grep -rn "fix brief #" docs`); update any stale text in keyed blocks.

## Self-Review

- Scenarios 1-4 -> Task 1 (implicit, explicit differing, no duplicate/schema error, `key` wins). Scenarios 5-7 -> Task 2 (mcp, cli, sandbox). 8-10 -> Task 3 (refusal wording reused from `renderDoneMarkerInstruction`, untouched). 11 -> Task 1 keeps parser untouched; CLI path unaffected.
- Types: `follow(channel)`, `globalArgv(..., argv)`, `composeFixSnapshot(..., mcp)` named identically wherever referenced.
- Open item flagged for implementer: sandbox emit-marker command text must be copied from `renderSandboxMarkerInstruction`, not guessed.
