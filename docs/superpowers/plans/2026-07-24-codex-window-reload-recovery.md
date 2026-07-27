# Codex Window Reload Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace a stale editor-restored Karst terminal with exactly one clean terminal that resumes the persisted Codex session after every window reload.

**Architecture:** Extend the host-agnostic terminal seam with an opaque Karst ticket marker and restored-terminal discovery. `SessionManager` will reconcile restored handles into deduplicated recovery candidates, while the VS Code adapter reads/writes the marker through `TerminalOptions.env`; activation validates persisted ticket state and invokes the existing `karst.openSession` path once per resumable ticket.

**Tech Stack:** TypeScript, VS Code Extension API, Vitest, SQLite-backed ticket state

## Global Constraints

- Preserve the existing `AgentAdapter`, `TerminalHost`, and injected-interface architecture; `src/ui/session.ts` must not import `vscode`.
- Use the stored agent session ID and existing `shouldResumeSession` rule; do not add schema or persistence formats.
- Never dispose an untagged or ambiguously identified terminal.
- Never put ticket content, prompts, credentials, or the Codex session ID in the terminal marker.
- Repeated reloads must replace one stale terminal with one resumed terminal without accumulating duplicates.
- Any failed or non-resumable recovery must leave a clear idle/Resume state and log the reason.

---

### Task 1: Host-Agnostic Restored Terminal Reconciliation

**Files:**
- Modify: `src/ui/session.ts`
- Test: `src/ui/session.test.ts`

**Interfaces:**
- Consumes: existing `SessionTerminal`, `TerminalHost`, and `SessionManager.openSession(...)`.
- Produces: `KARST_TICKET_ENV`, `TerminalHost.restoredSessions?(): RestoredSession[]`, `SessionManager.reconcileRestoredSessions(canResume): RestoredRecoveryResult`, and `CreateTerminalOpts.env`.

- [ ] **Step 1: Write failing tests for identity propagation and one-shot recovery**

Add fake-host support for restored terminals and tests equivalent to:

```ts
it('tags a new terminal with only its ticket id', () => {
  mgr.openSession(adapter, 7, '/wt/a', undefined, 'secret prompt', undefined, undefined, 'secret-session');
  expect(terminals[0]!.env).toEqual({ KARST_TICKET_ID: '7' });
  expect(JSON.stringify(terminals[0]!.env)).not.toContain('secret');
});

it('disposes duplicate restored handles and returns one resumable ticket', () => {
  const restored = [fakeRestored(7), fakeRestored(7)];
  const result = mgr.reconcileRestoredSessions((id) => id === 7);
  expect(result).toEqual({ resume: [7], idle: [] });
  expect(restored.every((terminal) => terminal.disposed)).toBe(true);
});

it('disposes a tagged non-resumable terminal into recoverable idle state', () => {
  const restored = [fakeRestored(8)];
  expect(mgr.reconcileRestoredSessions(() => false)).toEqual({ resume: [], idle: [8] });
  expect(restored[0]!.disposed).toBe(true);
});

it('ignores untagged terminals', () => {
  expect(mgr.reconcileRestoredSessions(() => true)).toEqual({ resume: [], idle: [] });
  expect(unrelated.disposed).toBe(false);
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npx vitest run src/ui/session.test.ts`

Expected: FAIL because `env`, restored-session discovery, and `reconcileRestoredSessions` do not exist.

- [ ] **Step 3: Implement the minimal host-agnostic contract**

Add these shapes and behavior:

```ts
export const KARST_TICKET_ENV = 'KARST_TICKET_ID';

export interface RestoredSession {
  ticketId: number;
  terminal: SessionTerminal;
}

export interface RestoredRecoveryResult {
  resume: number[];
  idle: number[];
}

export interface CreateTerminalOpts {
  // existing fields...
  env: Record<string, string>;
}

export interface TerminalHost {
  createTerminal(opts: CreateTerminalOpts): SessionTerminal;
  restoredSessions?(): RestoredSession[];
}
```

`openSession` passes `{ ...cmd.env, [KARST_TICKET_ENV]: String(ticketId) }` to the host. `reconcileRestoredSessions` obtains the optional restored list, deduplicates by numeric ticket ID, disposes every tagged restored handle, and places each unique ID in `resume` or `idle` according to `canResume`. It must not insert restored terminals into the live map because their reported UI is the object being replaced.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run: `npx vitest run src/ui/session.test.ts`

Expected: PASS with all session manager tests green.

- [ ] **Step 5: Commit the host-agnostic slice**

```bash
git add src/ui/session.ts src/ui/session.test.ts
git commit -m "fix: reconcile restored agent terminals"
```

### Task 2: VS Code Activation Recovery

**Files:**
- Modify: `src/extension.ts`
- Modify: `src/store/tickets.ts` only if an existing imported writer is needed; do not add a direct SQL mutation.
- Test: `src/ui/session.test.ts`

**Interfaces:**
- Consumes: `KARST_TICKET_ENV`, `SessionManager.reconcileRestoredSessions`, `getTicket`, `setAgentState`, `shouldResumeSession`, and the registered `karst.openSession` command.
- Produces: VS Code `TerminalOptions.env` tagging/discovery and activation-time automatic resume.

- [ ] **Step 1: Add the reload-cycle regression test**

Simulate two extension-host lifetimes over one fake terminal host:

```ts
it('repeated reloads leave one responsive replacement per ticket', () => {
  const first = new SessionManager(host, channelFor);
  first.openSession(adapter, 7, '/wt/a', undefined, 'seed', undefined, undefined, 'session-7');

  host.restoreCreatedTerminals();
  const second = new SessionManager(host, channelFor);
  expect(second.reconcileRestoredSessions(() => true).resume).toEqual([7]);
  second.openSession(adapter, 7, '/wt/a', undefined, 'continue', undefined, undefined, 'session-7');
  expect(second.nudge(7, 'still responsive')).toBe(true);

  host.restoreCreatedTerminals();
  const third = new SessionManager(host, channelFor);
  expect(third.reconcileRestoredSessions(() => true).resume).toEqual([7]);
  expect(host.liveTerminals()).toHaveLength(0);
});
```

- [ ] **Step 2: Run the regression test and verify RED**

Run: `npx vitest run src/ui/session.test.ts`

Expected: FAIL until the fake reload lifecycle and production host discovery are wired.

- [ ] **Step 3: Wire the VS Code terminal adapter**

In `makeTerminalHost()`:

```ts
createTerminal(opts) {
  const terminal = vscode.window.createTerminal({
    // existing options...
    env: opts.env,
  });
  return wrapTerminal(terminal);
},
restoredSessions() {
  return vscode.window.terminals.flatMap((terminal) => {
    const env = terminal.creationOptions.env;
    const raw = env?.[KARST_TICKET_ENV];
    if (typeof raw !== 'string' || !/^[1-9]\d*$/.test(raw)) return [];
    return [{ ticketId: Number(raw), terminal: wrapTerminal(terminal) }];
  });
}
```

Extract the existing VS Code terminal wrapper locally so created and restored terminals share `show`, `sendText`, `dispose`, and close-listener behavior.

- [ ] **Step 4: Reconcile after command registration**

After `karst.openSession` is registered, reconcile once:

```ts
const restored = sessions.reconcileRestoredSessions((ticketId) => {
  try {
    const ticket = getTicket(localStore, ticketId);
    return ticket.projectId === currentProject()?.id &&
      shouldResumeSession({
        sessionId: ticket.sessionId,
        stageCurrent: ticket.stageCurrent as StageKey,
      });
  } catch {
    return false;
  }
});

for (const ticketId of restored.idle) {
  setAgentState(localStore, ticketId, 'idle');
  logger.warn(`session recovery: ticket ${ticketId} has no resumable session`);
}
for (const ticketId of restored.resume) {
  void vscode.commands.executeCommand('karst.openSession', ticketId).then(
    undefined,
    (error) => {
      setAgentState(localStore, ticketId, 'idle');
      logError(`session recovery failed for ticket ${ticketId}`, error);
    },
  );
}
```

Scope resolution must use the ticket's project identity. If the concrete `Ticket` shape does not expose `projectId`, derive the allowed IDs from `listTickets(localStore, { projectId: currentProject()?.id })` before calling the predicate. Refresh the sidebar/dashboard after idle fallback.

- [ ] **Step 5: Run focused tests and typecheck**

Run: `npx vitest run src/ui/session.test.ts`

Expected: PASS.

Run: `npm run typecheck`

Expected: exit 0 with no TypeScript errors.

- [ ] **Step 6: Commit activation recovery**

```bash
git add src/extension.ts src/ui/session.ts src/ui/session.test.ts
git commit -m "fix: resume Codex sessions after window reload"
```

### Task 3: Review and Verification

**Files:**
- Review: all changes since the design commit
- Modify: only files required to address review findings

**Interfaces:**
- Consumes: completed restored-session contract and activation integration.
- Produces: reviewed, type-safe, tested production change.

- [ ] **Step 1: Request a focused code review**

Give the reviewer the ticket acceptance criteria, design document, base commit `56aeb54`, and current `HEAD`. Require checks for duplicate terminals, unsafe disposal, cross-project recovery, leaked session data, event-listener cleanup, and error-state handling.

- [ ] **Step 2: Address every Critical or Important finding**

Use a fresh RED→GREEN cycle for any behavioral correction. Do not expand scope into terminal renderer repair or schema changes.

- [ ] **Step 3: Run fresh full verification**

Run:

```bash
npm test
npm run typecheck
npm run build
git diff --check
git status --short
```

Expected: all test files pass, typecheck and build exit 0, no whitespace errors, and status contains only intentional ticket changes.

- [ ] **Step 4: Record the implementation marker**

Run the exact ticket-provided `karst stage impl pass` command only after all verification gates pass.
