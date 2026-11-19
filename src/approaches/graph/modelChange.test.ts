/**
 * T1258: detect a settings change against each live graph run's identity
 * snapshot, ask Keep or Switch, and switch in one transaction.
 */
import { describe, it, expect, vi } from 'vitest';
import type { Manifest } from '../../manifest/types.js';
import { harness, NOW, testManifest, type Harness } from './driverHarness.js';
import { createGraphRun, graphRunAgentIdentity, setGraphRunAgentIdentity } from '../../store/graph/graphRuns.js';
import { parseRunIdentities, resolveRunIdentities, serializeRunIdentities } from './runIdentity.js';
import {
  agentSettingsChanged,
  runModelDifference,
  askModelChange,
  findModelChanges,
  modelChangeMessage,
  switchGraphRunModels,
} from './modelChange.js';

function manifestWith(active: 'p1' | 'p2'): Manifest {
  return testManifest({
    activeAgentPreset: active,
    agentPresets: {
      p1: { label: 'One', slots: { graphExpert: { provider: 'claude', model: 'claude-opus-5', effort: 'high' }, graphWorker: { provider: 'claude', model: 'claude-sonnet-5' } } },
      p2: { label: 'Two', slots: { graphExpert: { provider: 'codex', model: 'gpt-5.6' }, graphWorker: { provider: 'codex', model: 'gpt-5.6-mini' } } },
    },
  });
}

let attempt = 0;
function runWith(h: Harness, preset: 'p1' | 'p2' | null, status: string, ticketId = h.ticketId): number {
  const id = createGraphRun(h.db, { ticketId, stageAttempt: ++attempt, approachId: 'karst-graph-engineering', now: NOW });
  if (preset) setGraphRunAgentIdentity(h.db, id, serializeRunIdentities(resolveRunIdentities(manifestWith(preset), h.config)), NOW);
  h.db.prepare('UPDATE approach_graph_runs SET status = ? WHERE id = ?').run(status, id);
  return id;
}

const depsOf = (h: Harness, manifest: Manifest) => ({
  db: h.db,
  transaction: <T,>(fn: () => T): T => fn(),
  manifest,
  graphConfigOf: () => h.config,
  now: () => NOW,
  debug: vi.fn(),
});

describe('findModelChanges', () => {
  it('reports a running run whose snapshot differs from the new settings', () => {
    const h = harness();
    const id = runWith(h, 'p1', 'running');
    const found = findModelChanges(depsOf(h, manifestWith('p2')));
    expect(found.map((c) => c.graphRunId)).toEqual([id]);
    expect(found[0]!.summary.from).toContain('claude/claude-opus-5');
    expect(found[0]!.summary.to).toContain('codex/gpt-5.6');
  });

  it('reports nothing when the identity is unchanged', () => {
    const h = harness();
    runWith(h, 'p1', 'running');
    expect(findModelChanges(depsOf(h, manifestWith('p1')))).toEqual([]);
  });

  it('skips terminal runs and a pre-migration run', () => {
    const h = harness();
    runWith(h, 'p1', 'closed');
    runWith(h, 'p1', 'cancelled');
    runWith(h, null, 'running');
    expect(findModelChanges(depsOf(h, manifestWith('p2')))).toEqual([]);
  });

  it('limits the scan to one ticket when asked', () => {
    const h = harness();
    runWith(h, 'p1', 'running');
    expect(findModelChanges(depsOf(h, manifestWith('p2')), { ticketId: h.ticketId + 99 })).toEqual([]);
  });
});

describe('switchGraphRunModels', () => {
  it('replaces the snapshot with the live identity and logs it', () => {
    const h = harness();
    const id = runWith(h, 'p1', 'running');
    const deps = depsOf(h, manifestWith('p2'));
    expect(switchGraphRunModels(deps, id)).toBe('switched');
    expect(parseRunIdentities(graphRunAgentIdentity(h.db, id))?.roles.expert?.provider).toBe('codex');
    expect(deps.debug).toHaveBeenCalledWith(expect.stringContaining(`graph run ${id}`));
    expect(findModelChanges(deps)).toEqual([]);
  });

  it('does not stop a session: the run status is untouched', () => {
    const h = harness();
    const id = runWith(h, 'p1', 'draining');
    switchGraphRunModels(depsOf(h, manifestWith('p2')), id);
    expect((h.db.prepare('SELECT status FROM approach_graph_runs WHERE id = ?').get(id) as { status: string }).status).toBe('draining');
  });

  it('refuses a terminal run, an unknown run and an unchanged run', () => {
    const h = harness();
    const closed = runWith(h, 'p1', 'closed');
    const same = runWith(h, 'p1', 'running');
    expect(switchGraphRunModels(depsOf(h, manifestWith('p2')), closed)).toBe('terminal');
    expect(switchGraphRunModels(depsOf(h, manifestWith('p2')), 9999)).toBe('not-found');
    expect(switchGraphRunModels(depsOf(h, manifestWith('p1')), same)).toBe('unchanged');
  });

  it('switches a pre-migration run too (stores the live identity)', () => {
    const h = harness();
    const id = runWith(h, null, 'running');
    expect(switchGraphRunModels(depsOf(h, manifestWith('p2')), id)).toBe('switched');
    expect(graphRunAgentIdentity(h.db, id)).not.toBeNull();
  });
});

describe('modelChangeMessage', () => {
  const change = (id: number, t: number) => ({
    graphRunId: id, ticketId: t, approachId: 'a', status: 'running',
    summary: { from: 'expert claude/opus', to: 'expert codex/gpt', difference: 'expert: claude/opus → codex/gpt' },
  });
  const label = (t: number) => `T${t}`;

  it('words one run per the brief', () => {
    const m = modelChangeMessage(label, [change(4, 7)]);
    expect(m.message).toBe('Ticket T7: graph run 4 uses expert claude/opus. The new settings give expert codex/gpt.');
    expect(m.actions).toEqual({ switch: 'Switch to new models', keep: 'Keep current models' });
  });

  it('lists several runs in one message with Switch all / Keep all', () => {
    const m = modelChangeMessage(label, [change(4, 7), change(5, 8)]);
    expect(m.message).toContain('Ticket T7: graph run 4');
    expect(m.message).toContain('Ticket T8: graph run 5');
    expect(m.actions).toEqual({ switch: 'Switch all', keep: 'Keep all' });
  });
});

describe('askModelChange', () => {
  const base = (h: Harness, manifest: Manifest, answer: string | undefined) => {
    const warn = vi.fn(async () => answer);
    return { deps: { ...depsOf(h, manifest), label: (t: number) => `T${t}`, warn, refresh: vi.fn() }, warn };
  };

  it('asks nothing when no run differs', async () => {
    const h = harness();
    runWith(h, 'p1', 'running');
    const { deps, warn } = base(h, manifestWith('p1'), undefined);
    expect(await askModelChange(deps)).toBe(0);
    expect(warn).not.toHaveBeenCalled();
  });

  it('Switch replaces the snapshot and refreshes', async () => {
    const h = harness();
    const id = runWith(h, 'p1', 'running');
    const { deps } = base(h, manifestWith('p2'), 'Switch to new models');
    await askModelChange(deps);
    expect(parseRunIdentities(graphRunAgentIdentity(h.db, id))?.roles.expert?.provider).toBe('codex');
    expect(deps.refresh).toHaveBeenCalledWith(h.ticketId);
  });

  it.each([['Keep current models'], [undefined]])('Keep or dismiss (%s) changes nothing', async (answer) => {
    const h = harness();
    const id = runWith(h, 'p1', 'running');
    const before = graphRunAgentIdentity(h.db, id);
    const { deps } = base(h, manifestWith('p2'), answer);
    await askModelChange(deps);
    expect(graphRunAgentIdentity(h.db, id)).toBe(before);
  });

  it('two runs give one warning; Switch all switches both', async () => {
    const h = harness();
    const a = runWith(h, 'p1', 'running');
    const b = runWith(h, 'p1', 'blocked');
    const { deps, warn } = base(h, manifestWith('p2'), 'Switch all');
    expect(await askModelChange(deps)).toBe(2);
    expect(warn).toHaveBeenCalledTimes(1);
    for (const id of [a, b]) expect(parseRunIdentities(graphRunAgentIdentity(h.db, id))?.roles.expert?.provider).toBe('codex');
  });
});

describe('agentSettingsChanged', () => {
  it('is true for a changed active preset, preset slot or approach profile', () => {
    const base = manifestWith('p1');
    expect(agentSettingsChanged(base, manifestWith('p2'))).toBe(true);
    const slot = { ...base, agentPresets: { ...base.agentPresets, p1: { ...base.agentPresets!.p1!, slots: { graphWorker: { provider: 'codex', model: 'x' } } } } } as Manifest;
    expect(agentSettingsChanged(base, slot)).toBe(true);
    const profile = {
      ...base,
      approaches: [{ id: 'a', graph: { profiles: { worker: { provider: 'claude', model: 'm' } } } }],
    } as unknown as Manifest;
    expect(agentSettingsChanged(base, profile)).toBe(true);
  });

  it('is false for an unrelated change', () => {
    const base = manifestWith('p1');
    expect(agentSettingsChanged(base, { ...base, defaultModel: 'other' } as Manifest)).toBe(false);
    expect(agentSettingsChanged(base, { ...base })).toBe(false);
  });
});

describe('runModelDifference', () => {
  it('names the difference for a live run whose snapshot differs', () => {
    const h = harness();
    const id = runWith(h, 'p1', 'running');
    expect(runModelDifference(depsOf(h, manifestWith('p2')), id)).toContain('→');
  });

  it('is undefined when equal, terminal, pre-migration or unknown', () => {
    const h = harness();
    const same = runWith(h, 'p1', 'running');
    const closed = runWith(h, 'p1', 'closed');
    const legacy = runWith(h, null, 'running');
    const deps = depsOf(h, manifestWith('p2'));
    expect(runModelDifference(depsOf(h, manifestWith('p1')), same)).toBeUndefined();
    expect(runModelDifference(deps, closed)).toBeUndefined();
    expect(runModelDifference(deps, legacy)).toBeUndefined();
    expect(runModelDifference(deps, 9999)).toBeUndefined();
  });
});
