import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeGraphOwnedBinding, type GraphOwnedBindingDeps } from './graphOwnedBinding.js';
import { CANCEL_GRAPH_ACTION, graphOwnedChangeMessage } from '../approaches/graph/graphOwnedNotice.js';
import { cancelGraphRun } from '../approaches/graph/cancel.js';
import type { GraphDb } from '../store/graph/transitions.js';

vi.mock('../approaches/graph/cancel.js', () => ({
  cancelGraphRun: vi.fn(async (_deps: unknown, graphRunId: number) => ({
    outcome: 'cancelled',
    graphRunId,
    killed: 0,
    counts: { plannerRuns: 0, nodeRuns: 0, leases: 0, processRuns: 0 },
  })),
}));
vi.mock('../approaches/graph/graphOwnedNotice.js', async (orig) => ({
  ...(await orig<typeof import('../approaches/graph/graphOwnedNotice.js')>()),
  graphRunLiveness: vi.fn(async () => ({ livePlanners: 0, liveNodes: 3 })),
}));

beforeEach(() => vi.clearAllMocks());

const RUN = { graphRunId: 17, status: 'running' };
const DB = { tag: 'db' } as unknown as GraphDb;

function make(over: Partial<GraphOwnedBindingDeps> = {}) {
  const deps = {
    db: () => DB,
    transaction: <T,>(fn: () => T) => fn(),
    facts: { isAlive: async () => true } as never,
    killTree: () => ({ outcome: 'killed' }) as never,
    activeRun: () => RUN,
    label: (id: number) => `T${id}`,
    warn: vi.fn(async () => CANCEL_GRAPH_ACTION as string | undefined),
    confirm: vi.fn(async () => true),
    inform: vi.fn(),
    refresh: vi.fn(),
    logError: vi.fn(),
    debug: vi.fn(),
    ...over,
  } satisfies GraphOwnedBindingDeps;
  return { deps, binding: makeGraphOwnedBinding(deps) };
}

describe('launchBlocked', () => {
  it('does nothing without a graph db', async () => {
    const { deps, binding } = make({ db: () => undefined });
    await binding.launchBlocked(5, RUN);
    expect(deps.warn).not.toHaveBeenCalled();
  });

  it('warns with the ticket label, the run and the live node count', async () => {
    const { deps, binding } = make({ warn: vi.fn(async () => undefined) });
    await binding.launchBlocked(5, RUN);
    expect(deps.warn).toHaveBeenCalledWith(
      'T5: no new session started because the graph run is running and 3 agents are running, but no session is attached to this window. Select Cancel graph to stop it.',
      CANCEL_GRAPH_ACTION,
    );
    expect(deps.confirm).not.toHaveBeenCalled();
    expect(cancelGraphRun).not.toHaveBeenCalled();
  });

  it('cancels the run with the user reason, then refreshes that ticket and informs', async () => {
    const tx = vi.fn(<T,>(fn: () => T) => fn());
    const { deps, binding } = make({ transaction: tx as never });
    await binding.launchBlocked(5, RUN);
    expect(deps.confirm).toHaveBeenCalledWith(expect.stringContaining('the graph run of T5'), CANCEL_GRAPH_ACTION);
    const [cancelDeps, id, reason] = vi.mocked(cancelGraphRun).mock.calls[0]!;
    expect(id).toBe(17);
    expect(reason).toBe('cancelled by user from a blocked launch');
    expect(cancelDeps.db).toBe(DB);
    expect(cancelDeps.transaction).toBe(tx);
    expect(cancelDeps.facts).toBe(deps.facts);
    expect(cancelDeps.killTree).toBe(deps.killTree);
    expect(cancelDeps.debug).toBe(deps.debug);
    expect(deps.refresh).toHaveBeenCalledWith(5);
    expect(deps.inform).toHaveBeenCalledWith(expect.stringContaining('is cancelled'));
  });

  it('logs a failed cancel and does not refresh', async () => {
    vi.mocked(cancelGraphRun).mockRejectedValueOnce(new Error('boom'));
    const { deps, binding } = make();
    await binding.launchBlocked(5, RUN);
    expect(deps.logError).toHaveBeenCalledWith('graph cancel failed for run 17', expect.any(Error));
    expect(deps.refresh).not.toHaveBeenCalled();
  });
});

describe('agentChoiceChanged', () => {
  it('asks the model-change question for the ticket and stays quiet when it was shown', async () => {
    const ask = vi.fn(async () => 1);
    const { deps, binding } = make({ modelChange: { ask } });
    await binding.agentChoiceChanged(5);
    expect(ask).toHaveBeenCalledWith({ ticketId: 5 });
    expect(deps.inform).not.toHaveBeenCalled();
  });

  it('informs when a graph run is active and no identity differs', async () => {
    const { deps, binding } = make();
    await binding.agentChoiceChanged(5);
    expect(deps.inform).toHaveBeenCalledWith(graphOwnedChangeMessage('T5', RUN));
  });

  it('stays silent without a run', async () => {
    const ask = vi.fn(async () => 0);
    const { deps, binding } = make({ activeRun: () => undefined, modelChange: { ask } });
    await binding.agentChoiceChanged(5);
    expect(deps.inform).not.toHaveBeenCalled();
    expect(ask).not.toHaveBeenCalled();
  });

  it('stays silent and skips the lookup without a db', async () => {
    const activeRun = vi.fn(() => RUN);
    const { deps, binding } = make({ db: () => undefined, activeRun });
    await binding.agentChoiceChanged(5);
    expect(activeRun).not.toHaveBeenCalled();
    expect(deps.inform).not.toHaveBeenCalled();
  });
});

describe('agentSettingsSaved', () => {
  it('asks for the runs of the window project when the identity inputs changed', async () => {
    const ask = vi.fn(async () => 2);
    const { binding } = make({ modelChange: { ask } });
    await binding.agentSettingsSaved(true, 4);
    expect(ask).toHaveBeenCalledWith({ projectId: 4 });
  });

  it('asks nothing and logs when the window has no project', async () => {
    const ask = vi.fn(async () => 2);
    const { deps, binding } = make({ modelChange: { ask } });
    await binding.agentSettingsSaved(true, undefined);
    expect(ask).not.toHaveBeenCalled();
    expect(deps.debug).toHaveBeenCalledWith(expect.stringContaining('no project'));
  });

  it('asks nothing when the identity inputs did not change', async () => {
    const ask = vi.fn(async () => 2);
    const { binding } = make({ modelChange: { ask } });
    await binding.agentSettingsSaved(false, 4);
    expect(ask).not.toHaveBeenCalled();
  });
});
