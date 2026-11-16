import { describe, it, expect, vi } from 'vitest';
import {
  CANCEL_GRAPH_ACTION,
  graphOwnedChangeMessage,
  graphOwnedMessage,
  showGraphOwnedNotice,
  type GraphOwnedNoticeDeps,
} from './graphOwnedNotice.js';
import type { CancelGraphRunResult } from './cancel.js';

const NONE = { livePlanners: 0, liveNodes: 0 };

describe('graphOwnedMessage', () => {
  it('names the run, the status and a dead planner for a planning run', () => {
    expect(graphOwnedMessage('T1107', { graphRunId: 17, status: 'planning' }, NONE)).toBe(
      'Ticket T1107: graph run 17 is planning; its planner has no live session. No new session started.',
    );
  });

  it('says the planner is alive but detached when a planner process lives', () => {
    const text = graphOwnedMessage('T1', { graphRunId: 3, status: 'planning' }, { livePlanners: 1, liveNodes: 0 });
    expect(text).toContain('graph run 3 is planning');
    expect(text).toContain('planner is alive, but its session is not attached');
  });

  it('describes the node state for running and draining runs', () => {
    expect(graphOwnedMessage('T1', { graphRunId: 4, status: 'running' }, NONE)).toContain('none of its nodes has a live session');
    expect(graphOwnedMessage('T1', { graphRunId: 4, status: 'draining' }, { livePlanners: 0, liveNodes: 1 })).toContain(
      '1 node process is alive',
    );
    expect(graphOwnedMessage('T1', { graphRunId: 4, status: 'running' }, { livePlanners: 0, liveNodes: 2 })).toContain(
      '2 node processes are alive',
    );
  });

  it('describes blocked, marker-wait and other statuses', () => {
    expect(graphOwnedMessage('T1', { graphRunId: 5, status: 'blocked' }, NONE)).toContain('parked until you resume or cancel');
    expect(graphOwnedMessage('T1', { graphRunId: 5, status: 'completed-awaiting-impl-marker' }, NONE)).toContain(
      'waits for the implementation marker',
    );
    expect(graphOwnedMessage('T1', { graphRunId: 5, status: 'other' }, NONE)).toContain('coordinator owns the next step');
  });
});

describe('graphOwnedChangeMessage', () => {
  it('says the change applies to the next launch', () => {
    const text = graphOwnedChangeMessage('T1107', { graphRunId: 17, status: 'planning' });
    expect(text).toContain('applies to the next launch, not to graph run 17');
  });
});

function makeDeps(over: Partial<GraphOwnedNoticeDeps> = {}) {
  const cancelled: CancelGraphRunResult = {
    outcome: 'cancelled',
    graphRunId: 17,
    killed: 1,
    counts: { plannerRuns: 1, nodeRuns: 0, leases: 0, processRuns: 1 },
  };
  const deps = {
    warn: vi.fn(async () => CANCEL_GRAPH_ACTION as string | undefined),
    confirm: vi.fn(async () => true),
    cancel: vi.fn(async () => cancelled),
    refresh: vi.fn(),
    inform: vi.fn(),
    logError: vi.fn(),
    ...over,
  };
  return deps;
}

const input = { ticketLabel: 'T1107', run: { graphRunId: 17, status: 'planning' }, liveness: NONE };

describe('showGraphOwnedNotice', () => {
  it('offers Cancel graph in the warning', async () => {
    const deps = makeDeps();
    await showGraphOwnedNotice(deps, input);
    expect(deps.warn).toHaveBeenCalledWith(expect.stringContaining('graph run 17 is planning'), CANCEL_GRAPH_ACTION);
  });

  it('cancels, refreshes and reports after a confirm', async () => {
    const deps = makeDeps();
    await showGraphOwnedNotice(deps, input);
    expect(deps.confirm).toHaveBeenCalledOnce();
    expect(deps.cancel).toHaveBeenCalledWith(17);
    expect(deps.refresh).toHaveBeenCalledOnce();
    expect(deps.inform).toHaveBeenCalledWith(expect.stringContaining('was cancelled'));
  });

  it('changes nothing when the warning is dismissed', async () => {
    const deps = makeDeps({ warn: vi.fn(async () => undefined) });
    await showGraphOwnedNotice(deps, input);
    expect(deps.confirm).not.toHaveBeenCalled();
    expect(deps.cancel).not.toHaveBeenCalled();
    expect(deps.refresh).not.toHaveBeenCalled();
  });

  it('changes nothing when the modal confirm is declined', async () => {
    const deps = makeDeps({ confirm: vi.fn(async () => false) });
    await showGraphOwnedNotice(deps, input);
    expect(deps.cancel).not.toHaveBeenCalled();
    expect(deps.refresh).not.toHaveBeenCalled();
  });

  it.each([
    [{ outcome: 'refused-live-process', graphRunId: 17, killed: 0, refusals: [] } as CancelGraphRunResult, 'NOT cancelled'],
    [{ outcome: 'already-terminal', graphRunId: 17, status: 'closed' } as CancelGraphRunResult, 'already ended (closed)'],
    [{ outcome: 'raced', graphRunId: 17, killed: 0 } as CancelGraphRunResult, 'changed state'],
  ])('reports the cancel outcome %#', async (result, text) => {
    const deps = makeDeps({ cancel: vi.fn(async () => result) });
    await showGraphOwnedNotice(deps, input);
    expect(deps.inform).toHaveBeenCalledWith(expect.stringContaining(text));
  });

  it('logs a thrown cancel and does not refresh', async () => {
    const boom = new Error('boom');
    const deps = makeDeps({ cancel: vi.fn(async () => { throw boom; }) });
    await showGraphOwnedNotice(deps, input);
    expect(deps.logError).toHaveBeenCalledWith(expect.stringContaining('run 17'), boom);
    expect(deps.refresh).not.toHaveBeenCalled();
  });
});
