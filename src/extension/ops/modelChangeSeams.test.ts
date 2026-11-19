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
    db: () => h.db, transaction: (fn) => fn(), manifest: () => live, graphConfigOf: () => h.config, ticketLaunchFieldsOf: () => ({ agentPreset: null, provider: null, model: null, effort: null }),
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

  it('stamps the switch with the real clock when no clock is injected', async () => {
    const h = harness();
    const id = createGraphRun(h.db, { ticketId: h.ticketId, stageAttempt: 1, approachId: 'karst-graph-engineering', now: NOW });
    setGraphRunAgentIdentity(h.db, id, serializeRunIdentities(resolveRunIdentities(manifestOf('claude-opus-5'), h.config)), NOW);
    const seams = makeModelChangeSeams({
      db: () => h.db, transaction: (fn) => fn(), manifest: () => manifestOf('claude-sonnet-5'), graphConfigOf: () => h.config, ticketLaunchFieldsOf: () => ({ agentPreset: null, provider: null, model: null, effort: null }),
      label: (t) => `T${t}`, warn: vi.fn(async () => 'Switch to new models'), refresh: vi.fn(), debug: vi.fn(),
    });
    expect(await seams.ask({})).toBe(1);
    const at = (h.db.prepare('SELECT updated_at AS at FROM approach_graph_runs WHERE id = ?').get(id) as { at: string } | undefined)?.at;
    expect(at).toBeDefined();
    expect(at).not.toBe(NOW);
  });

  it('does nothing before the manifest is loaded', async () => {
    const { seams, warn } = setup(undefined);
    expect(await seams.ask({})).toBe(0);
    expect(warn).not.toHaveBeenCalled();
  });
});
