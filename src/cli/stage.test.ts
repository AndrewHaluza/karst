import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  parseStageArgs,
  runStageCommand,
  composeStageCommand,
  assertMarkerNotWhileWaiting,
} from './stage.js';
import type { Store } from '../store/db.js';
import { openStore } from '../store/db.js';
import { createTicketFlow } from '../workflow/stages/create.js';
import { transition } from '../workflow/machine.js';
import {
  recordSessionLaunchIntent,
  confirmSessionLaunchIntent,
} from '../store/sessionLaunchIntents.js';
import { listImplementationTimeline } from '../store/implementationRuns.js';
import { listProcessRuns } from '../store/processRuns.js';
import { getTicket, setAgentState } from '../store/tickets.js';
import {
  openRecoveryRound,
  beginLiveFixExecution,
  listRecoveryRounds,
} from '../store/recoveryRounds.js';

describe('composeStageCommand', () => {
  it('bakes in the impl-done marker and quotes paths, leaving the ticket key for $ARGUMENTS', () => {
    expect(composeStageCommand('/ext/dist/cli/main.js', '/store/karst.db')).toBe(
      'node "/ext/dist/cli/main.js" stage impl pass --db "/store/karst.db" --ticket',
    );
  });

  it('quotes paths containing spaces', () => {
    expect(composeStageCommand('/a b/cli.js', '/c d/x.db')).toBe(
      'node "/a b/cli.js" stage impl pass --db "/c d/x.db" --ticket',
    );
  });

  it('bakes in whichever stage the ticket sits at, so a fix resume fires "fix pass"', () => {
    expect(composeStageCommand('/ext/cli.js', '/store/karst.db', 'fix')).toBe(
      'node "/ext/cli.js" stage fix pass --db "/store/karst.db" --ticket',
    );
  });

  it('carries the manifest so the marker lands on the right project board', () => {
    expect(
      composeStageCommand('/ext/cli.js', '/store/karst.db', 'impl', '/repo/.karst/karst.yml'),
    ).toBe(
      'node "/ext/cli.js" stage impl pass --db "/store/karst.db" --manifest "/repo/.karst/karst.yml" --ticket',
    );
  });

  it('omits the manifest flag when no path is given', () => {
    expect(composeStageCommand('/ext/cli.js', '/db.db', 'impl')).not.toContain('--manifest');
  });
});

describe('parseStageArgs', () => {
  it('parses "stage impl pass" into a passed verdict', () => {
    expect(parseStageArgs(['stage', 'impl', 'pass'])).toEqual({
      stage: 'impl',
      verdict: { kind: 'passed' },
    });
  });

  it('parses "stage fix pass" — the resume boundary', () => {
    expect(parseStageArgs(['stage', 'fix', 'pass'])).toEqual({
      stage: 'fix',
      verdict: { kind: 'passed' },
    });
  });

  // The marker CLI exists for the two boundaries an agent works at (§5.4). A gate
  // verdict must come from an exit code, never from the agent saying so — the CLI
  // refusing gate keys is what makes that structural rather than conventional.
  it.each(['uat', 'review', 'ship', 'scope', 'done'])('rejects the gated stage "%s"', (stage) => {
    expect(() => parseStageArgs(['stage', stage, 'pass'])).toThrow(/impl, fix/);
  });

  it('names the rejected key so a misfired marker is diagnosable', () => {
    expect(() => parseStageArgs(['stage', 'ship', 'pass'])).toThrow(/ship/);
  });

  it('rejects an unknown stage key', () => {
    expect(() => parseStageArgs(['stage', 'nope', 'pass'])).toThrow();
  });

  // Neither marker stage has a `failed` edge, so every `fail` that parsed would
  // throw in the machine anyway. Rejecting here names the mistake, not the graph.
  it('rejects "fail" — the marker CLI records passes only', () => {
    expect(() => parseStageArgs(['stage', 'impl', 'fail'])).toThrow(/pass/);
  });

  it('rejects "fail" with a reason', () => {
    expect(() => parseStageArgs(['stage', 'fix', 'fail', 'lint broke'])).toThrow(/pass/);
  });

  it('rejects an unknown verdict word', () => {
    expect(() => parseStageArgs(['stage', 'impl', 'maybe'])).toThrow();
  });

  it('rejects a missing verdict', () => {
    expect(() => parseStageArgs(['stage', 'impl'])).toThrow();
  });
});

describe('assertMarkerNotWhileWaiting', () => {
  it('refuses the marker while the agent is waiting for user input', () => {
    expect(() => assertMarkerNotWhileWaiting('waiting')).toThrow(/waiting for your input/);
  });

  it('accepts a running agent — the normal state while the marker fires', () => {
    expect(() => assertMarkerNotWhileWaiting('running')).not.toThrow();
  });

  it('accepts an idle agent — a finished session the marker may close', () => {
    expect(() => assertMarkerNotWhileWaiting('idle')).not.toThrow();
  });

  it('accepts no agent at all', () => {
    expect(() => assertMarkerNotWhileWaiting(null)).not.toThrow();
    expect(() => assertMarkerNotWhileWaiting(undefined)).not.toThrow();
  });
});

describe('runStageCommand', () => {
  it('routes the impl marker through markImplementDone, carrying the completion premutate', () => {
    const transition = vi.fn().mockReturnValue('uat');
    const store = {} as Store;
    const next = runStageCommand(store, 42, ['stage', 'impl', 'pass'], transition);
    expect(transition).toHaveBeenCalledWith(
      store,
      42,
      'impl',
      { kind: 'passed' },
      expect.any(Function),
    );
    expect(next).toBe('uat');
  });

  it('routes the fix marker through markFixDone, carrying the recovery completion premutate', () => {
    const transition = vi.fn().mockReturnValue('uat');
    const store = {} as Store;
    const next = runStageCommand(store, 42, ['stage', 'fix', 'pass'], transition);
    expect(transition).toHaveBeenCalledWith(
      store,
      42,
      'fix',
      { kind: 'passed' },
      expect.any(Function),
    );
    expect(next).toBe('uat');
  });

  it('refuses the impl marker while the agent is waiting for user input', () => {
    const store = openStore(':memory:');
    try {
      const id = createTicketFlow(store, { key: 'T-1', title: 't' }).id;
      transition(store, id, 'scope', { kind: 'passed' });
      setAgentState(store, id, 'waiting');

      expect(() => runStageCommand(store, id, ['stage', 'impl', 'pass'])).toThrow(
        /waiting for your input/,
      );
      expect(getTicket(store, id).stageCurrent).toBe('impl');
    } finally {
      store.close();
    }
  });

  it('refuses the fix marker while the agent is waiting for user input', () => {
    const store = openStore(':memory:');
    try {
      const id = createTicketFlow(store, { key: 'T-1', title: 't' }).id;
      transition(store, id, 'scope', { kind: 'passed' });
      transition(store, id, 'impl', { kind: 'passed' });
      transition(store, id, 'uat', { kind: 'failed', reason: 'exit 1' });
      setAgentState(store, id, 'waiting');

      expect(() => runStageCommand(store, id, ['stage', 'fix', 'pass'])).toThrow(
        /waiting for your input/,
      );
      expect(getTicket(store, id).stageCurrent).toBe('fix');
    } finally {
      store.close();
    }
  });

  it('fires the real marker path: closes the active segment and Session process run, passes the run, advances to UAT', () => {
    const store = openStore(':memory:');
    try {
      const id = createTicketFlow(store, { key: 'T-1', title: 't' }).id;
      transition(store, id, 'scope', { kind: 'passed' });
      recordSessionLaunchIntent(store, {
        ticketId: id, launchId: 'launch-1', purpose: 'implementation',
        provider: 'claude', model: 'opus', reason: 'initial', sessionOrigin: 'new',
        at: '2026-08-01T10:00:00.000Z',
      });
      confirmSessionLaunchIntent(store, 'launch-1', {
        ticketId: id, provider: 'claude', providerSessionId: 'claude-session-1',
        at: '2026-08-01T10:01:00.000Z',
      });
      const before = listImplementationTimeline(store, id)!;

      const next = runStageCommand(store, id, ['stage', 'impl', 'pass']);

      expect(next).toBe('uat');
      expect(getTicket(store, id).stageCurrent).toBe('uat');
      const after = listImplementationTimeline(store, id)!;
      expect(after.run.id).toBe(before.run.id);
      expect(after.run.status).toBe('passed');
      expect(after.run.endedAt).not.toBeNull();
      expect(after.segments[0]!.status).toBe('closed');
      expect(after.segments[0]!.endedAt).not.toBeNull();
      expect(listProcessRuns(store, id)[0]!.status).toBe('passed');
      expect(listProcessRuns(store, id)[0]!.endedAt).not.toBeNull();
    } finally {
      store.close();
    }
  });

  it('a refused stale marker changes none of the run, segment or process run', () => {
    const store = openStore(':memory:');
    try {
      const id = createTicketFlow(store, { key: 'T-1', title: 't' }).id;
      transition(store, id, 'scope', { kind: 'passed' });
      recordSessionLaunchIntent(store, {
        ticketId: id, launchId: 'launch-1', purpose: 'implementation',
        provider: 'claude', model: 'opus', reason: 'initial', sessionOrigin: 'new',
        at: '2026-08-01T10:00:00.000Z',
      });
      confirmSessionLaunchIntent(store, 'launch-1', {
        ticketId: id, provider: 'claude', providerSessionId: 'claude-session-1',
        at: '2026-08-01T10:01:00.000Z',
      });
      runStageCommand(store, id, ['stage', 'impl', 'pass']);
      const passed = listImplementationTimeline(store, id)!;

      // The ticket already left impl — the stale marker is refused, and the
      // refusal names the gate stage it is actually waiting at instead of the
      // machine's bare mismatch.
      expect(() => runStageCommand(store, id, ['stage', 'impl', 'pass'])).toThrow(
        /already at stage 'uat'/,
      );
      expect(() => runStageCommand(store, id, ['stage', 'impl', 'pass'])).toThrow(
        /gate exit codes/,
      );

      const after = listImplementationTimeline(store, id)!;
      expect(after.run).toEqual(passed.run);
      expect(after.segments).toEqual(passed.segments);
      expect(listProcessRuns(store, id)[0]!.status).toBe('passed');
    } finally {
      store.close();
    }
  });

  it('fires the real fix marker path: passes the linked Fix process run and moves the round to revalidating', () => {
    const store = openStore(':memory:');
    try {
      const id = createTicketFlow(store, { key: 'T-1', title: 't' }).id;
      transition(store, id, 'scope', { kind: 'passed' });
      transition(store, id, 'impl', { kind: 'passed' });
      const round = openRecoveryRound(store, {
        ticketId: id, sourceStage: 'uat', sourceProcessId: 'gates',
        sourceStageRunId: null, sourceProcessRunId: null,
        triggerKind: 'gate-failure', triggerDetail: 'exit 1', maxRounds: 3,
        startedAt: '2026-08-01T10:00:00.000Z',
      });
      // The failing verdict the round was opened by parked the ticket at fix.
      transition(store, id, 'uat', { kind: 'failed', reason: 'exit 1' });
      const fixRun = beginLiveFixExecution(store, {
        ticketId: id, roundId: round.id, provider: 'claude', model: 'opus',
        startedAt: '2026-08-01T10:01:00.000Z',
      });

      const next = runStageCommand(store, id, ['stage', 'fix', 'pass']);

      expect(next).toBe('uat');
      expect(getTicket(store, id).stageCurrent).toBe('uat');
      expect(listProcessRuns(store, id)[0]!.status).toBe('passed');
      expect(listProcessRuns(store, id)[0]!.id).toBe(fixRun.id);
      expect(listRecoveryRounds(store, id)[0]).toMatchObject({
        status: 'revalidating',
        fixProcessRunId: fixRun.id,
      });
    } finally {
      store.close();
    }
  });

  it('a rejected stale fix marker mutates neither the process run nor the round', () => {
    const store = openStore(':memory:');
    try {
      const id = createTicketFlow(store, { key: 'T-1', title: 't' }).id;
      transition(store, id, 'scope', { kind: 'passed' });
      transition(store, id, 'impl', { kind: 'passed' });
      const round = openRecoveryRound(store, {
        ticketId: id, sourceStage: 'uat', sourceProcessId: 'gates',
        sourceStageRunId: null, sourceProcessRunId: null,
        triggerKind: 'gate-failure', triggerDetail: 'exit 1', maxRounds: 3,
        startedAt: '2026-08-01T10:00:00.000Z',
      });
      // The failing verdict the round was opened by parked the ticket at fix.
      transition(store, id, 'uat', { kind: 'failed', reason: 'exit 1' });
      beginLiveFixExecution(store, {
        ticketId: id, roundId: round.id, provider: 'claude',
        startedAt: '2026-08-01T10:01:00.000Z',
      });
      const beforeRounds = listRecoveryRounds(store, id);
      const beforeRuns = listProcessRuns(store, id);

      // The ticket already left fix — the stale marker is refused.
      transition(store, id, 'fix', { kind: 'passed' });
      expect(() => runStageCommand(store, id, ['stage', 'fix', 'pass'])).toThrow(
        /already at stage 'uat'/,
      );

      expect(listRecoveryRounds(store, id)).toEqual(beforeRounds);
      expect(listProcessRuns(store, id)).toEqual(beforeRuns);
    } finally {
      store.close();
    }
  });

  it('a stale impl marker at fix names the fix marker instead of the bare mismatch', () => {
    const store = openStore(':memory:');
    try {
      const id = createTicketFlow(store, { key: 'T-1', title: 't' }).id;
      transition(store, id, 'scope', { kind: 'passed' });
      transition(store, id, 'impl', { kind: 'passed' });
      transition(store, id, 'uat', { kind: 'failed', reason: 'exit 1' });

      // The user finished a fix session but fired the seeded impl marker — the
      // most common self-inflicted refusal, and the one the report asked to
      // read as instruction, not as a machine error.
      expect(() => runStageCommand(store, id, ['stage', 'impl', 'pass'])).toThrow(
        /already at stage 'fix'/,
      );
      expect(() => runStageCommand(store, id, ['stage', 'impl', 'pass'])).toThrow(
        /'stage fix pass', not 'stage impl pass'/,
      );
    } finally {
      store.close();
    }
  });

  it('a stale fix marker at impl names the impl marker', () => {
    const store = openStore(':memory:');
    try {
      const id = createTicketFlow(store, { key: 'T-1', title: 't' }).id;
      transition(store, id, 'scope', { kind: 'passed' });

      expect(() => runStageCommand(store, id, ['stage', 'fix', 'pass'])).toThrow(
        /already at stage 'impl'/,
      );
      expect(() => runStageCommand(store, id, ['stage', 'fix', 'pass'])).toThrow(
        /'stage impl pass'/,
      );
    } finally {
      store.close();
    }
  });

  it('a marker fired at a done ticket is refused as done, never as a stage mismatch', () => {
    const store = openStore(':memory:');
    try {
      const id = createTicketFlow(store, { key: 'T-1', title: 't' }).id;
      transition(store, id, 'scope', { kind: 'passed' });
      transition(store, id, 'impl', { kind: 'passed' });
      transition(store, id, 'uat', { kind: 'passed' });
      transition(store, id, 'review', { kind: 'passed' });
      transition(store, id, 'ship', { kind: 'passed' });

      expect(() => runStageCommand(store, id, ['stage', 'impl', 'pass'])).toThrow(
        /already at stage 'done'/,
      );
      expect(() => runStageCommand(store, id, ['stage', 'impl', 'pass'])).toThrow(/no marker to fire/);
    } finally {
      store.close();
    }
  });

  it('uses the caller-supplied ticket snapshot for the stale-stage refusal, without reading the store', () => {
    const store = {} as Store;
    const transition = vi.fn().mockReturnValue('uat');
    // The test seam hands a ticket with a divergent stageCurrent and no `db` —
    // the refusal must come from the snapshot, not from a store read that would
    // throw on a stub.
    expect(() =>
      runStageCommand(store, 42, ['stage', 'impl', 'pass'], transition, {
        agentState: 'running',
        stageCurrent: 'fix',
      }),
    ).toThrow(/stage fix pass/);
    expect(transition).not.toHaveBeenCalled();
  });

  it('does not refuse a marker that matches the ticket snapshot', () => {
    const transition = vi.fn().mockReturnValue('uat');
    const store = {} as Store;
    expect(() =>
      runStageCommand(store, 42, ['stage', 'impl', 'pass'], transition, {
        agentState: 'running',
        stageCurrent: 'impl',
      }),
    ).not.toThrow();
    expect(transition).toHaveBeenCalled();
  });
});
