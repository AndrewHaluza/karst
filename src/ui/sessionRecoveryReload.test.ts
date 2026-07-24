import { describe, expect, it, vi } from 'vitest';
import {
  planSessionRecovery,
  recoverSession,
  recoveryOutcomeDisposition,
  resumeRestoredSession,
  SerializedStateWriter,
  SessionRecoveryLifecycle,
} from './sessionRecovery.js';

describe('recovery interrupted by another window reload', () => {
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
        { resume: [ticket.id], idle: [] },
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

  it('abandons genuine early-close and timeout recovery failures', () => {
    expect(recoveryOutcomeDisposition({ kind: 'closed' })).toBe('abandon');
    expect(recoveryOutcomeDisposition({ kind: 'timed-out' })).toBe('abandon');
  });
});
