# [FIX] Input in fix session didn't trigger "Needs you" — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make opencode interactive sessions actually deliver hook events so a session stopped on a permission/question ask turns the ticket amber "Needs you" on the dashboard and the ticket list.

**Architecture:** The bug is in the opencode adapter's launch command, not in the needs-you derivation. `needsUser` (`model/ticketGlyph.ts`), the amber glyph, the pause glyph, the rail, the sidebar badge and the attention set all work once `agent_state = 'waiting'` flows in. For opencode, that state can only arrive via the generated `karst-bridge.js` plugin (`.opencode/plugins/`) POSTing to the hook endpoint — and the interactive launch passes `--pure`, which disables ALL external plugin loading in opencode (verified in opencode source: `flags.pure ? [] : plugin_origins` in the server plugin host and `Flag.OPENCODE_PURE ? [] : pluginOrigins` in the TUI host, plus an empirical run: a marker plugin in `.opencode/plugins/` never loads under `--pure`). Real-world proof: the registry has 21 opencode launch intents but zero opencode `session_id`s captured (vs 55 claude + 17 codex) and zero interactive usage samples — opencode sessions produce no hooks at all, so a permission ask can never set `waiting`.

**Tech Stack:** TypeScript, vitest, opencode plugin API (Bun).

## Global Constraints

- `agent_state` is the single liveness signal; only `setAgentState` writes it (single-writer discipline).
- The hook event vocabulary reaching dispatch stays closed: the bridge normalizes provider events to karst's own names (`permission.asked` already exists; `question.asked`/`question.v2.asked` normalize to it — do NOT invent a new dispatch event).
- Headless `opencode run` KEEPS `--pure` (gate isolation; headless runs need no hooks) — only the interactive launch changes.
- The generated bridge file stays at `.opencode/plugins/karst-bridge.js` (already excluded from git by `/\.opencode/plugins/karst-*/` in `KARST_EXCLUDE_RULES`).
- Strict TDD: write the failing test, watch it fail, implement, watch it pass.
- Conventional commits; `npm run typecheck` and `npx vitest run <touched files>` before commit.

---

### Task 1: Stop launching interactive opencode sessions with `--pure`

**Files:**
- Modify: `src/agent/opencode.ts` (`buildInteractiveCommand`, lines ~511-532)
- Test: `src/agent/opencode.test.ts`

**Interfaces:**
- Consumes: `InteractiveCommandOpts.hookChannel` (already present).
- Produces: an interactive command WITHOUT `--pure` in `args`, still writing `karst-bridge.js` and returning it in `ownedPaths`. Later tasks rely on `cmd.args` containing no `--pure`.

- [ ] **Step 1: Write the failing test**

In `src/agent/opencode.test.ts`, update the "materializes a karst-bridge plugin…" test (`it('materializes a karst-bridge plugin that POSTs session.idle/permission.asked to the hook endpoint')`): replace the `--pure` assertion with the opposite — the flag must be ABSENT because it disables the plugin host that IS the hook channel:

```ts
// `--pure` would disable the plugin host entirely — the very host that loads
// the karst-bridge below. The flag must never be passed on an interactive
// launch, or opencode sessions can produce no hook events at all (869eg458d).
expect(cmd.args).not.toContain('--pure');
```

(Keep the existing `expect(existsSync(pluginPath)).toBe(true)` and body-content assertions.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/agent/opencode.test.ts -t "materializes a karst-bridge plugin"`
Expected: FAIL — `cmd.args` currently contains `'--pure'`.

- [ ] **Step 3: Write minimal implementation**

In `src/agent/opencode.ts` `buildInteractiveCommand`, delete the `--pure` push and replace the comment with the reason it must never return:

```ts
if (opts.hookChannel) {
  // The generated plugin is the ONLY hook authority karst introduces — and
  // `--pure` disables ALL external plugin loading in opencode, including the
  // auto-discovered `.opencode/plugins/karst-bridge.js` this very call just
  // wrote. An interactive session launched with `--pure` can therefore never
  // deliver a single hook event (no SessionStart, no permission.asked, no
  // usage), which is how a permission ask in an opencode fix session failed to
  // surface "Needs you" (869eg458d). Never pass it here. Headless `run` keeps
  // `--pure` on purpose: gate processes need no hooks and stay isolated from
  // the user's own plugins.
  const pluginPath = writeKarstBridge(opts.cwd, opts.hookChannel.endpointUrl);
  ownedPaths = [pluginPath];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/agent/opencode.test.ts`
Expected: PASS (the no-hookChannel test already asserts `not.toContain('--pure')`).

- [ ] **Step 5: Commit**

```bash
git add src/agent/opencode.ts src/agent/opencode.test.ts
git commit -m "fix(opencode): drop --pure from interactive launch so the karst-bridge plugin can load"
```

---

### Task 2: Treat opencode question asks as wait signals in the bridge

**Files:**
- Modify: `src/agent/opencode.ts` (`renderHookBridge`'s `KarstBridge.event` handler, lines ~435-452)
- Test: `src/agent/opencode.test.ts` (the `loadBridge` receiver block)

**Interfaces:**
- Consumes: the bridge event payload shape `{ event: { id, type, properties } }` from opencode.
- Produces: `permission.asked` posts (the established wait signal) for `question.asked` / `question.v2.asked` events. Dispatch already maps `permission.asked` → `waiting`; nothing else changes.

- [ ] **Step 1: Write the failing test**

Add to the `OpencodeAdapter` bridge describe block in `src/agent/opencode.test.ts` (mirror the existing `permission.asked posts no usage` test — same `receiver(1)` + `loadBridge` harness):

```ts
it('posts permission.asked for a question.asked — a question is the same wait signal', async () => {
  const worktree = makeWorktree();
  const r = await receiver(1);
  try {
    const bridge = await loadBridge(worktree, r.endpointUrl);
    await bridge.event({
      event: {
        id: 'evt-q1',
        type: 'question.asked',
        properties: { sessionID: 'ses_1', cwd: '/wt' },
      },
    });
    const bodies = await Promise.race([
      r.received,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('plugin posted no lifecycle payload')), 2_000),
      ),
    ]);
    expect(bodies).toEqual([
      { hook_event_name: 'permission.asked', cwd: '/wt', session_id: 'ses_1' },
    ]);
  } finally {
    await r.close();
  }
});
```

Add a second case for `question.v2.asked` using `it.each` or a second identical block with `type: 'question.v2.asked'`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/agent/opencode.test.ts -t "question"`
Expected: FAIL — the bridge ignores `question.*`, so nothing posts and the receiver times out.

- [ ] **Step 3: Write minimal implementation**

In `src/agent/opencode.ts` `renderHookBridge`, widen the wait-signal branch:

```ts
} else if (
  type === 'permission.asked' ||
  type === 'permission.v2.asked' ||
  type === 'question.asked' ||
  type === 'question.v2.asked'
) {
  // A question is the same "blocked on the user" signal as a permission:
  // the agent stopped and only a human can continue it. Normalized to
  // karst's own closed wait vocabulary (permission.asked) so dispatch
  // needs no new event.
  post('permission.asked', input, directory, worktree);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/agent/opencode.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/agent/opencode.ts src/agent/opencode.test.ts
git commit -m "feat(opencode): bridge question asks as the same wait signal as permission asks"
```

---

### Task 3: The dashboard Now line must say the agent is waiting, not running

**Files:**
- Modify: `src/model/nowLine.ts` (`buildNowLine` signature + top of the switch), `src/ui/dashboard/state.ts` (the `buildNowLine` call site)
- Test: `src/model/nowLine.test.ts`, `src/ui/dashboard/state.test.ts`

**Interfaces:**
- Consumes: `ticket.agentState === 'waiting'` at the `state.ts` call site; new optional ctx field `agentWaiting?: boolean` on `buildNowLine`'s ctx.
- Produces: for any stage with `ctx.agentWaiting === true`, `{ text: 'Now: the agent is waiting — it asked for your input.', action?: <session action when provided> }`, evaluated BEFORE the stage switch (the live question outranks stage narration, exactly like `railNeeds`).

- [ ] **Step 1: Write the failing tests**

In `src/model/nowLine.test.ts`:

```ts
it('says the agent is waiting when it asked for input — impl narration must not claim it is running', () => {
  expect(buildNowLine(cell({ stageKey: 'impl' }), { agentWaiting: true })).toEqual({
    text: 'Now: the agent is waiting — it asked for your input.',
  });
});

it('keeps the session button beside the waiting line', () => {
  expect(
    buildNowLine(cell({ stageKey: 'fix' }), {
      agentWaiting: true,
      sessionAction: { kind: 'open', label: 'Open', detail: 'session is live · jump to terminal' },
    }),
  ).toEqual({
    text: 'Now: the agent is waiting — it asked for your input.',
    action: { kind: 'session', label: 'Open session', detail: 'session is live · jump to terminal' },
  });
});
```

In `src/ui/dashboard/state.test.ts`, extend the existing `'puts needs-you on impl when the agent is the one waiting'` test (it already sets `agent_state='waiting'`):

```ts
expect(state.now.text).toBe('Now: the agent is waiting — it asked for your input.');
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/model/nowLine.test.ts src/ui/dashboard/state.test.ts`
Expected: FAIL — the impl/fix lines still narrate "running"/"resumed".

- [ ] **Step 3: Write minimal implementation**

In `src/model/nowLine.ts`, extend the ctx type and add the branch at the top of `buildNowLine` (after the `!cell` guard, before the switch):

```ts
// A live agent asked a question or permission: the ticket is blocked on the
// user RIGHT NOW, so the sentence must say so — claiming the agent is running
// beside an amber "Needs you" rail is the contradiction this branch prevents.
// Mirrors railNeeds' precedence: the live question outranks stage narration.
if (ctx.agentWaiting) {
  const line: NowLine = {
    text: 'Now: the agent is waiting — it asked for your input.',
  };
  if (session) line.action = session;
  return line;
}
```

In `src/ui/dashboard/state.ts`, pass the flag at the call site:

```ts
now: buildNowLine(currentStage, {
  fixAttempts,
  agentWaiting: (ticket.agentState ?? 'none') === 'waiting',
  sessionAction: sessionAction(ticket, resolvedProvider),
  mergeGate,
}),
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/model/nowLine.test.ts src/ui/dashboard/state.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/model/nowLine.ts src/ui/dashboard/state.ts src/model/nowLine.test.ts src/ui/dashboard/state.test.ts
git commit -m "fix(dashboard): Now line says the agent is waiting when it asked for input"
```

---

### Task 4: Full verification

- [ ] **Step 1: Run the touched suites**

Run: `npx vitest run src/agent/opencode.test.ts src/model/nowLine.test.ts src/ui/dashboard/state.test.ts src/hooks/dispatch.test.ts src/model/ticketGlyph.test.ts`
Expected: all PASS.

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 3: Full test run**

Run: `npm test`
Expected: all PASS (uses the Node-ABI rebuilt sqlite via `pretest`).

- [ ] **Step 4: Commit any stragglers**

```bash
git status --short
git add -u
git commit -m "chore: verify needs-you fix for opencode sessions"
```
(Only if the status is non-empty and the diff is intended.)

---

## Self-Review

**1. Spec coverage:**
- "review stage in progress, session stopped by ask permissions → should be 'Needs you'" → Task 1 (the channel exists again) + Task 2 (wait signal) + existing `needsUser`/glyph/rail/badge plumbing (unchanged, already correct and tested).
- "yellow color, pause icon" → amber glyph + `❚❚` pause glyph already render from `needsUser`; they were unreachable only because `waiting` never arrived.
- "properly updated on dashboard and tickets list" → rail + badge + facets update from the same `needsUser`; the Now line contradiction is fixed in Task 3.
- No gaps.

**2. Placeholder scan:** none — every step carries concrete code.

**3. Type consistency:** `agentWaiting?: boolean` is threaded consistently from `state.ts` into `buildNowLine`; `permission.asked` is the existing dispatch event; `question.asked`/`question.v2.asked` are the opencode event names verified in the opencode schema (`packages/schema/src/question.ts`).
