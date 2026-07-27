# Restored Session Adoption Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Re-associate editor-restored Karst terminals with their existing session slots without restarting agent processes or duplicating provider-side session records.

**Architecture:** `SessionManager` will adopt one visible restored terminal per current-project ticket into its existing one-terminal-per-ticket map and attach the ordinary close lifecycle. Activation will treat adopted tickets as already recovered and reserve the existing relaunch flow for owned hidden sessions that the editor could not restore.

**Tech Stack:** TypeScript, ESM, VS Code terminal abstraction, Vitest

## Global Constraints

- Use strict RED→GREEN TDD and observe every new regression test fail before production changes.
- Keep restoration provider-neutral; do not branch on Codex, Claude, or Antigravity.
- Preserve the existing project boundary: foreign or unknown terminals remain untouched.
- Preserve hidden-session background recovery.
- Do not change stored active or inactive ticket state merely because a visible terminal was adopted.
- Use `.js` suffixes for TypeScript ESM imports and satisfy `noUncheckedIndexedAccess`.

---

### Task 1: Adopt Restored Terminals in SessionManager

**Files:**
- Modify: `src/ui/session.ts`
- Test: `src/ui/session.test.ts`

**Interfaces:**
- Consumes: `TerminalHost.restoredSessions(): RestoredSession[]` and `RestoredSessionDisposition`.
- Produces: `SessionManager.reconcileRestoredSessions(classify): RestoredRecoveryResult`, with adopted terminals installed into `SessionManager` and returned in `resume` or `idle` according to classification.

- [ ] **Step 1: Write failing adoption tests**

Add tests that use the real `SessionManager` and fake terminals:

```ts
it('adopts one active restored terminal without creating a replacement', () => {
  const restored = fakeRestored(7);
  const { adapter } = fakeAdapter();
  const { host, terminals } = fakeHost([restored]);
  const mgr = new SessionManager(host, channelFor);

  expect(mgr.reconcileRestoredSessions(() => 'resume')).toEqual({
    resume: [7],
    idle: [],
  });
  mgr.openSession(adapter, 7, '/wt/a');

  expect(mgr.isOpen(7)).toBe(true);
  expect(restored.terminal.disposed).toBe(false);
  expect(terminals).toHaveLength(0);
});

it('adopts an inactive restored terminal and keeps it responsive', () => {
  const restored = fakeRestored(8);
  const { host } = fakeHost([restored]);
  const mgr = new SessionManager(host, channelFor);

  expect(mgr.reconcileRestoredSessions(() => 'idle')).toEqual({
    resume: [],
    idle: [8],
  });
  expect(mgr.nudge(8, 'continue')).toBe(true);
  expect(restored.terminal.sent).toEqual(['continue']);
  expect(restored.terminal.disposed).toBe(false);
});
```

Extend `fakeRestored` with `shown`, `sent`, and an invokable close handler. Add a duplicate-handle test asserting the first handle remains managed, the extra is disposed, and no terminal is created by a subsequent `openSession`.

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```bash
npx vitest run src/ui/session.test.ts
```

Expected: the active test reports a created replacement or disposed restored terminal; the inactive nudge returns `false`. These failures prove the old dispose-and-relaunch behavior is under test.

- [ ] **Step 3: Implement minimal adoption lifecycle**

Extract the existing close registration into a private method that accepts a terminal, ticket ID, optional launch ID, and optional cleanup callback:

```ts
private trackTerminal(
  ticketId: number,
  terminal: SessionTerminal,
  launchId?: string,
  cleanupOwned?: () => void,
): void
```

The handler must identity-check `this.terminals.get(ticketId) === terminal`, delete only the current handle, run cleanup only when supplied, call `onDidCloseSession` only for the current handle, and always notify `onDidCloseTerminal(ticketId, launchId)`.

Use `trackTerminal` from `openSession`. In `reconcileRestoredSessions`, classify before mutation, ignore foreign handles, adopt the first handle for a ticket with `trackTerminal(ticketId, terminal)`, dispose later duplicates, and return each ticket once in its classified bucket. Do not dispose the adopted terminal.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run:

```bash
npx vitest run src/ui/session.test.ts
```

Expected: all session manager tests pass, including normal creation, close cleanup, adoption, and duplicate-handle behavior.

- [ ] **Step 5: Commit**

```bash
git add src/ui/session.ts src/ui/session.test.ts
git commit -m "fix: adopt restored session terminals"
```

### Task 2: Exclude Adopted Sessions from Relaunch Planning

**Files:**
- Modify: `src/ui/sessionRecovery.ts`
- Test: `src/ui/sessionRecovery.test.ts`
- Modify: `src/extension.ts`

**Interfaces:**
- Consumes: `RestoredRecoveryResult` whose `resume` and `idle` entries now denote adopted visible terminals.
- Produces: `planSessionRecovery(tickets, ownedTicketIds, restored)` that relaunches only background-owned tickets not already adopted.

- [ ] **Step 1: Write failing recovery-planning tests**

Add a literal behavior test:

```ts
it('does not relaunch active or inactive tickets with adopted visible terminals', () => {
  expect(
    planSessionRecovery(
      [
        { id: 7, agentState: 'running', canResume: true, hasWorktree: true },
        { id: 8, agentState: 'idle', canResume: true, hasWorktree: true },
      ],
      [7, 8],
      { resume: [7], idle: [8] },
    ),
  ).toEqual({
    resume: [],
    idle: [],
    discard: [],
  });
});
```

Add a second test where ticket 9 is owned, active, and has no restored visible terminal; assert `resume: [9]` to protect hidden-session recovery.

- [ ] **Step 2: Run focused recovery tests and verify RED**

Run:

```bash
npx vitest run src/ui/sessionRecovery.test.ts
```

Expected: adopted ticket 7 incorrectly appears in `resume`, demonstrating the duplicate relaunch.

- [ ] **Step 3: Implement minimal recovery-plan filtering**

In `planSessionRecovery`, build an adopted-ID set from both restored arrays and remove those IDs from background `resume`, `idle`, and `discard`:

```ts
const adopted = new Set([...restored.resume, ...restored.idle]);
return {
  resume: background.resume.filter((id) => !adopted.has(id)),
  idle: background.idle.filter((id) => !adopted.has(id)),
  discard: background.discard.filter((id) => !adopted.has(id)),
};
```

Update activation comments and variable names in `src/extension.ts` to describe adoption rather than disposal/replacement. Do not set adopted inactive tickets to idle during activation; their persisted state is already authoritative and must remain unchanged.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run:

```bash
npx vitest run src/ui/sessionRecovery.test.ts src/ui/sessionRecoveryReload.test.ts src/ui/session.test.ts
```

Expected: all restoration, repeated-reload, and session tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/ui/sessionRecovery.ts src/ui/sessionRecovery.test.ts src/extension.ts
git commit -m "fix: avoid relaunching adopted sessions"
```

### Task 3: Verify Provider-Neutral Restoration and Full Regression Safety

**Files:**
- Modify if required by failing assertions: `src/ui/session.test.ts`
- Modify if required by failing assertions: `src/ui/sessionRecoveryReload.test.ts`

**Interfaces:**
- Consumes: the provider-neutral `AgentAdapter` interface and adopted `SessionManager` behavior from Tasks 1–2.
- Produces: regression evidence that adoption does not invoke provider command construction and repeated reloads retain one terminal.

- [ ] **Step 1: Add a provider-neutral repeated-reload regression test**

Use a fake adapter whose `buildInteractiveCommand` throws:

```ts
const neverLaunchAdapter: AgentAdapter = {
  buildInteractiveCommand: () => {
    throw new Error('restoration must not build an agent command');
  },
  runHeadless: () => Promise.reject(new Error('not used')),
  requiredBinary: 'any-provider',
  capabilities: { lifecycleEvents: true, resume: true },
};
```

Simulate three manager recreations. On each cycle, feed the same live tagged terminal through `restoredSessions`, reconcile it, then call `openSession(neverLaunchAdapter, 7, '/wt/a')`. Assert one live handle, zero newly created terminals, no disposal of the adopted handle, and a successful nudge after every cycle.

- [ ] **Step 2: Run the regression test and verify its behavior**

Run:

```bash
npx vitest run src/ui/session.test.ts src/ui/sessionRecoveryReload.test.ts
```

Expected: PASS after Tasks 1–2. Temporarily changing reconciliation back to `terminal.dispose()` must make the new regression fail, proving it catches the original duplication behavior.

- [ ] **Step 3: Run complete verification**

Run:

```bash
npm test
npm run typecheck
npm run build
git diff --check
```

Expected: every command exits zero with no test failures, TypeScript errors, build errors, or whitespace errors.

- [ ] **Step 4: Request code review and resolve findings**

Request review against the ticket acceptance criteria:

- active visible session is adopted exactly once;
- inactive visible session remains managed without state mutation;
- repeated reloads do not build another agent command;
- hidden active sessions still relaunch;
- behavior contains no provider-specific branch; and
- normal creation, resumption, close handling, and cleanup remain intact.

Fix all Critical and Important findings via a new RED→GREEN cycle, then repeat the complete verification commands.

- [ ] **Step 5: Commit verification test changes**

```bash
git add src/ui/session.test.ts src/ui/sessionRecoveryReload.test.ts
git commit -m "test: cover idempotent provider-neutral session adoption"
```
