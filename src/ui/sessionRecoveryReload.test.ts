import { describe, expect, it, vi } from 'vitest';
import {
  planSessionRecovery,
  recoverSession,
  recoveryOutcomeDisposition,
  resumeRestoredSession,
  SerializedStateWriter,
  SessionRecoveryLifecycle,
  shouldApplySessionHookState,
} from './sessionRecovery.js';
import {
  SessionManager,
  type FakeTerminal,
  type RestoredSession,
} from './session.js';
import type { AgentAdapter } from '../agent/adapter.js';
import { dispatchHook } from '../hooks/dispatch.js';
import { openStore } from '../store/db.js';
import {
  createTicket,
  getTicket,
  setAgentState,
} from '../store/tickets.js';

describe('recovery interrupted by another window reload', () => {
  it('rejects late hooks from a disposed duplicate and the closed adopted generation', () => {
    const store = openStore(':memory:');
    const ticket = createTicket(store, { key: 'A', title: 'adopted' });
    const worktree = '/repo/.karst/worktrees/adopted';
    store.db
      .prepare(
        `INSERT INTO worktrees (ticket_id, repo, path, branch, base_ref, deps_mode)
         VALUES (?, 'app', ?, 'karst/adopted', 'main', 'inherited')`,
      )
      .run(ticket.id, worktree);
    const launchA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const launchB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const restored = [launchA, launchB].map((launchId) => {
      const terminal: FakeTerminal = {
        name: `Karst: #${ticket.id}`,
        cwd: worktree,
        shellPath: 'agent',
        shellArgs: [],
        env: {},
        shown: 0,
        shownPreserveFocus: [],
        sent: [],
        disposed: false,
        show: () => {},
        sendText: () => {},
        dispose: () => {
          terminal.disposed = true;
          terminal.disposeHandler?.();
        },
        onDidClose: (handler) => {
          terminal.disposeHandler = handler;
        },
      };
      return { ticketId: ticket.id, launchId, terminal } satisfies RestoredSession;
    });
    const lifecycle = new SessionRecoveryLifecycle();
    const sessions = new SessionManager(
      {
        createTerminal: () => {
          throw new Error('restored adoption must not relaunch');
        },
        restoredSessions: () => restored,
      },
      () => {
        throw new Error('restored adoption must not allocate a launch');
      },
      (ticketId) => setAgentState(store, ticketId, 'idle'),
      undefined,
      (ticketId, launchId) => lifecycle.sessionClosed(ticketId, launchId),
      (ticketId, launchId) => lifecycle.adoptLaunch(ticketId, launchId),
    );
    const applyHook = (
      hook_event_name: string,
      launchId: string,
      session_id?: string,
    ): void => {
      dispatchHook(
        store,
        { hook_event_name, launchId, session_id, cwd: worktree },
        undefined,
        (ticketId, payload) =>
          shouldApplySessionHookState(
            sessions,
            lifecycle,
            ticketId,
            payload,
          ),
      );
    };

    try {
      expect(sessions.reconcileRestoredSessions(() => 'resume')).toEqual({
        resume: [ticket.id],
        idle: [],
      });
      applyHook('SessionStart', launchA, 'session-A');
      expect(getTicket(store, ticket.id).sessionId).toBe('session-A');

      expect(restored[1]!.terminal.disposed).toBe(true);
      applyHook('SessionStart', launchB, 'session-B');
      expect(getTicket(store, ticket.id).sessionId).toBe('session-A');

      restored[0]!.terminal.dispose();
      expect(sessions.isOpen(ticket.id)).toBe(false);
      expect(getTicket(store, ticket.id).agentState).toBe('idle');
      applyHook('PostToolUse', launchA);
      expect(getTicket(store, ticket.id).agentState).toBe('idle');
    } finally {
      store.close();
    }
  });

  it('keeps the interruption result while the open command is still settling', async () => {
    let finishOpen!: () => void;
    const lifecycle = new SessionRecoveryLifecycle(100);
    const recovery = resumeRestoredSession(
      { isOpen: () => false },
      lifecycle,
      7,
      () =>
        new Promise<void>((resolve) => {
          finishOpen = resolve;
        }),
    );

    lifecycle.shutdown();
    finishOpen();

    await expect(recovery).resolves.toEqual({ kind: 'interrupted' });
  });

  it('keeps the interruption result when teardown rejects the pending open command', async () => {
    let rejectOpen!: (error: Error) => void;
    const lifecycle = new SessionRecoveryLifecycle(100);
    const recovery = resumeRestoredSession(
      { isOpen: () => false },
      lifecycle,
      7,
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectOpen = reject;
        }),
    );

    lifecycle.shutdown();
    rejectOpen(new Error('extension host stopped'));

    await expect(recovery).resolves.toEqual({ kind: 'interrupted' });
  });

  it('overrides hook readiness when teardown starts before the open command settles', async () => {
    let finishOpen!: () => void;
    let open = false;
    let disposals = 0;
    const lifecycle = new SessionRecoveryLifecycle(100);
    const recovery = recoverSession(
      {
        isOpen: () => open,
        disposeSession: () => {
          open = false;
          disposals++;
        },
      },
      lifecycle,
      7,
      () => {
        open = true;
        return new Promise<void>((resolve) => {
          finishOpen = resolve;
        });
      },
    );

    lifecycle.sessionStarted(7, lifecycle.currentLaunchId(7));
    lifecycle.shutdown();
    finishOpen();

    await expect(recovery).resolves.toEqual({ kind: 'interrupted' });
    expect(disposals).toBe(1);
  });

  it('preserves the claim for one deduplicated retry on the next activation', async () => {
    vi.useFakeTimers();
    try {
      const ticket = {
        id: 7,
        agentState: 'running',
        canResume: true,
        hasWorktree: true,
      };
      const owned = new Set([ticket.id]);
      let persistedOwnership = [...owned];
      const ownershipWriter = new SerializedStateWriter<number[]>(
        async (snapshot) => {
          persistedOwnership = [...snapshot];
        },
      );
      let agentState = ticket.agentState;
      let open = false;
      let disposals = 0;
      const sessions = {
        isOpen: () => open,
        disposeSession: () => {
          open = false;
          disposals++;
        },
      };

      const firstLifecycle = new SessionRecoveryLifecycle(100);
      const firstRecovery = recoverSession(
        sessions,
        firstLifecycle,
        ticket.id,
        async () => {
          open = true;
          await ownershipWriter.enqueue([...owned]);
        },
      ).then(async (outcome) => {
        if (recoveryOutcomeDisposition(outcome) === 'abandon') {
          agentState = 'idle';
          owned.delete(ticket.id);
          await ownershipWriter.enqueue([...owned]);
        }
        return outcome;
      });
      firstLifecycle.shutdown();
      const interrupted = await firstRecovery;
      await ownershipWriter.flush();

      expect(interrupted).toEqual({ kind: 'interrupted' });
      expect(disposals).toBe(1);
      expect(agentState).toBe('running');
      expect([...owned]).toEqual([7]);
      expect(persistedOwnership).toEqual([7]);
      expect(vi.getTimerCount()).toBe(0);

      const nextActivation = planSessionRecovery(
        [{ ...ticket, agentState }],
        persistedOwnership,
        { resume: [], idle: [] },
      );
      expect(nextActivation).toEqual({
        resume: [7],
        idle: [],
        discard: [],
      });

      const secondLifecycle = new SessionRecoveryLifecycle(100);
      const retry = recoverSession(
        sessions,
        secondLifecycle,
        nextActivation.resume[0]!,
        async () => {
          open = true;
        },
      );
      secondLifecycle.sessionStarted(
        ticket.id,
        secondLifecycle.currentLaunchId(ticket.id),
      );

      await expect(retry).resolves.toEqual({ kind: 'opened' });
      expect(recoveryOutcomeDisposition(await retry)).toBe('ready');
      expect(disposals).toBe(1);
      expect([...owned]).toEqual([7]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('preserves an interrupted retry claim when terminal cleanup throws', async () => {
    vi.useFakeTimers();
    try {
      const cleanupError = new Error('cleanup failed during reload');
      const terminals: FakeTerminal[] = [];
      const cleanup = vi.fn(() => {
        throw cleanupError;
      });
      const sessions = new SessionManager(
        {
          createTerminal: (opts) => {
            const terminal: FakeTerminal = {
              ...opts,
              shown: 0,
              shownPreserveFocus: [],
              sent: [],
              disposed: false,
              show: () => {},
              sendText: () => {},
              dispose: () => {
                terminal.disposed = true;
              },
              onDidClose: (handler) => {
                terminal.disposeHandler = handler;
              },
            };
            terminals.push(terminal);
            return terminal;
          },
        },
        (ticketId) => ({
          endpointUrl: `http://127.0.0.1:1/hooks/${ticketId}`,
          configDir: '/tmp',
          launchId: lifecycle.currentLaunchId(ticketId),
        }),
        undefined,
        cleanup,
      );
      const adapter: AgentAdapter = {
        buildInteractiveCommand: () => ({
          command: 'agent',
          args: [],
          env: {},
        }),
        runHeadless: () => Promise.reject(new Error('not used')),
        requiredBinary: 'agent',
        capabilities: { lifecycleEvents: true, resume: true },
      };
      const ticket = {
        id: 7,
        agentState: 'running',
        canResume: true,
        hasWorktree: true,
      };
      const owned = new Set([ticket.id]);
      let agentState = ticket.agentState;
      const reportedErrors: unknown[] = [];
      const lifecycle = new SessionRecoveryLifecycle(100);

      const interrupted = recoverSession(
        sessions,
        lifecycle,
        ticket.id,
        async () => {
          sessions.openSession(adapter, ticket.id, '/wt/a');
        },
      ).then((outcome) => {
        const disposition = recoveryOutcomeDisposition(outcome);
        if (disposition === 'retry-next-activation') {
          if (outcome.kind === 'interrupted' && outcome.cleanupError) {
            reportedErrors.push(outcome.cleanupError);
          }
        } else if (disposition === 'abandon') {
          agentState = 'idle';
          owned.delete(ticket.id);
        }
        return outcome;
      });
      lifecycle.shutdown();

      await expect(interrupted).resolves.toEqual({
        kind: 'interrupted',
        cleanupError,
      });
      expect(sessions.isOpen(ticket.id)).toBe(false);
      expect(terminals[0]!.disposed).toBe(true);
      expect(reportedErrors).toEqual([cleanupError]);
      expect(agentState).toBe('running');
      expect([...owned]).toEqual([7]);

      const nextActivation = planSessionRecovery(
        [{ ...ticket, agentState }],
        [...owned],
        { resume: [], idle: [] },
      );
      expect(nextActivation.resume).toEqual([7]);

      const nextLifecycle = new SessionRecoveryLifecycle(100);
      const retrySessions = {
        isOpen: () => true,
        disposeSession: () => {},
      };
      const retry = recoverSession(
        retrySessions,
        nextLifecycle,
        nextActivation.resume[0]!,
        async () => undefined,
      );
      nextLifecycle.sessionStarted(
        ticket.id,
        nextLifecycle.currentLaunchId(ticket.id),
      );
      await expect(retry).resolves.toEqual({ kind: 'opened' });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('abandons genuine early-close and timeout recovery failures', () => {
    expect(recoveryOutcomeDisposition({ kind: 'closed' })).toBe('abandon');
    expect(recoveryOutcomeDisposition({ kind: 'timed-out' })).toBe('abandon');
  });
});
