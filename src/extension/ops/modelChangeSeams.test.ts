import { describe, expect, it, vi } from 'vitest';
import type { Manifest } from '../../manifest/types.js';
import { harness, NOW, testManifest } from '../../approaches/graph/driverHarness.js';
import { createGraphRun, graphRunAgentIdentity, setGraphRunAgentIdentity } from '../../store/graph/graphRuns.js';
import { resolveRunIdentities, serializeRunIdentities } from '../../approaches/graph/runIdentity.js';
import { makeModelChangeSeams } from './modelChangeSeams.js';

const manifestOf = (model: string): Manifest =>
  testManifest({
    activeAgentPreset: 'p',
    agentPresets: { p: { label: 'P', slots: { graphExpert: { provider: 'claude', model } } } },
  });

function setup(live: Manifest | undefined) {
  const h = harness();
  const id = createGraphRun(h.db, { ticketId: h.ticketId, stageAttempt: 1, approachId: 'karst-graph-engineering', now: NOW });
  setGraphRunAgentIdentity(h.db, id, serializeRunIdentities(resolveRunIdentities(manifestOf('claude-opus-5'), h.config)), NOW);
  const warn = vi.fn(async () => 'Switch to new models' as string | undefined);
  const refresh = vi.fn();
  const seams = makeModelChangeSeams({
    db: () => h.db, transaction: (fn) => fn(), manifest: () => live, graphConfigOf: () => h.config,
    label: (t) => `T${t}`, warn, refresh, debug: vi.fn(), now: () => NOW,
  });
  return { h, id, seams, warn, refresh };
}

describe('makeModelChangeSeams', () => {
  it('asks against the live manifest and switches on the Switch answer', async () => {
    const { h, id, seams, warn, refresh } = setup(manifestOf('claude-sonnet-5'));
    const before = graphRunAgentIdentity(h.db, id);
    expect(await seams.ask({ ticketId: h.ticketId })).toBe(1);
    expect(warn).toHaveBeenCalledOnce();
    expect(graphRunAgentIdentity(h.db, id)).not.toBe(before);
    expect(refresh).toHaveBeenCalledWith(h.ticketId);
  });

  it('switchRun runs the same switch', () => {
    const { seams, id } = setup(manifestOf('claude-sonnet-5'));
    expect(seams.switchRun(id)).toBe('switched');
    expect(seams.switchRun(id)).toBe('unchanged');
  });

  it('stamps the switch with the real clock when no clock is injected', () => {
    const h = harness();
    const id = createGraphRun(h.db, { ticketId: h.ticketId, stageAttempt: 1, approachId: 'karst-graph-engineering', now: NOW });
    setGraphRunAgentIdentity(h.db, id, serializeRunIdentities(resolveRunIdentities(manifestOf('claude-opus-5'), h.config)), NOW);
    const seams = makeModelChangeSeams({
      db: () => h.db, transaction: (fn) => fn(), manifest: () => manifestOf('claude-sonnet-5'), graphConfigOf: () => h.config,
      label: (t) => `T${t}`, warn: vi.fn(), refresh: vi.fn(), debug: vi.fn(),
    });
    expect(seams.switchRun(id)).toBe('switched');
    const at = (h.db.prepare('SELECT updated_at AS at FROM approach_graph_runs WHERE id = ?').get(id) as { at: string } | undefined)?.at;
    expect(at === undefined || at !== NOW).toBe(true);
  });

  it('differenceOf names the difference, then is undefined once switched or unloaded', () => {
    const { seams, id } = setup(manifestOf('claude-sonnet-5'));
    expect(seams.differenceOf(id)).toContain('→');
    seams.switchRun(id);
    expect(seams.differenceOf(id)).toBeUndefined();
    expect(setup(undefined).seams.differenceOf(1)).toBeUndefined();
  });

  it('does nothing before the manifest is loaded', async () => {
    const { seams, id, warn } = setup(undefined);
    expect(await seams.ask({})).toBe(0);
    expect(seams.switchRun(id)).toBe('not-found');
    expect(warn).not.toHaveBeenCalled();
  });
});
