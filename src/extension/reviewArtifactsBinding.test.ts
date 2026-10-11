import { describe, it, expect } from 'vitest';
import type { Manifest } from '../manifest/types.js';
import { openStore, type Store } from '../store/db.js';
import { updateTicketFields } from '../store/tickets.js';
import { createTicketFlow } from '../workflow/stages/create.js';
import { makeReviewArtifactsBinding } from './reviewArtifactsBinding.js';

type Files = Record<string, { kind: string; text: string }>;

function fakeFactory(files: Files) {
  const opened: { artifactsRoot: string; projectId: number }[] = [];
  const createStore = (opts: { artifactsRoot: string; projectId: number }) => {
    opened.push(opts);
    return {
      listArtifacts: async () => Object.keys(files).map((path) => ({ path, revisions: 1, latestSha: `sha-${path}` })),
      history: async (_t: number, path: string) =>
        files[path] ? [{ sha: `sha-${path}`, at: '', trailers: { kind: files[path].kind } }] : [],
      show: async (_t: number, _sha: string, path: string) => Buffer.from(files[path]!.text),
    };
  };
  return { opened, createStore };
}

function ticket(registry: Store, opts: { intent?: string; approach?: string; projectId?: number } = {}): number {
  const id = createTicketFlow(registry, { key: 'T-1', title: 't' }).id;
  updateTicketFields(registry, id, { ...(opts.intent ? { intent: opts.intent } : {}), ...(opts.approach ? { approach: opts.approach } : {}) });
  if (opts.projectId !== undefined) registry.db.prepare('UPDATE tickets SET project_id = ? WHERE id = ?').run(opts.projectId, id);
  return id;
}

const manifestWith = (approaches: unknown[]) => () => ({ approaches }) as unknown as Manifest;
const specPlan: Files = {
  'app/spec.md': { kind: 'spec', text: 'SPECBODY' },
  'app/plan.md': { kind: 'plan', text: 'PLANBODY' },
};

describe('makeReviewArtifactsBinding', () => {
  it('opens the store of the ticket project under the artifacts root, preferring it over the fallback', async () => {
    const registry = openStore(':memory:');
    const id = ticket(registry, { intent: 'I', projectId: 5 });
    const { opened, createStore } = fakeFactory(specPlan);
    const load = makeReviewArtifactsBinding({ registry, artifactsRoot: '/root', manifest: () => undefined, fallbackProjectId: () => 9, createStore });
    const a = await load(id);
    expect(opened.at(-1)).toEqual({ artifactsRoot: '/root', projectId: 5 });
    expect(a?.intent).toBe('I');
    expect(a?.plan).toContain('PLANBODY');
    expect(a?.plan).toContain('app/plan.md');
  });
  it('falls back to the current project when the ticket has none', async () => {
    const registry = openStore(':memory:');
    const id = ticket(registry, { intent: 'I' });
    const { opened, createStore } = fakeFactory(specPlan);
    await makeReviewArtifactsBinding({ registry, artifactsRoot: '/root', manifest: () => undefined, fallbackProjectId: () => 9, createStore })(id);
    expect(opened.at(-1)?.projectId).toBe(9);
  });
  it('no project anywhere → intent only, no store opened', async () => {
    const registry = openStore(':memory:');
    const id = ticket(registry, { intent: 'I' });
    const { opened, createStore } = fakeFactory(specPlan);
    const a = await makeReviewArtifactsBinding({ registry, artifactsRoot: '/root', manifest: () => undefined, fallbackProjectId: () => undefined, createStore })(id);
    expect(opened).toEqual([]);
    expect(a).toEqual({ intent: 'I', spec: null, plan: null });
  });
  it('no intent and no artifacts → undefined', async () => {
    const registry = openStore(':memory:');
    const id = ticket(registry);
    const load = makeReviewArtifactsBinding({ registry, artifactsRoot: '/r', manifest: () => undefined, fallbackProjectId: () => undefined, createStore: fakeFactory({}).createStore });
    expect(await load(id)).toBeUndefined();
  });
  it('an approach that checks intent-spec itself drops the spec; the built-in speckit default does not', async () => {
    const registry = openStore(':memory:');
    const { createStore } = fakeFactory(specPlan);
    const bind = (approach: string, approaches: unknown[]) =>
      makeReviewArtifactsBinding({ registry, artifactsRoot: '/r', manifest: manifestWith(approaches), fallbackProjectId: () => 1, createStore })(
        ticket(registry, { intent: 'I', approach }),
      );
    expect((await bind('mine', [{ id: 'mine', label: 'M', checks: ['intent-spec'] }]))?.spec).toBeNull();
    expect((await bind('speckit', [{ id: 'speckit', label: 'S' }]))?.spec).toContain('SPECBODY');
    expect((await bind('other', [{ id: 'mine', label: 'M', checks: ['intent-spec'] }]))?.spec).toContain('SPECBODY');
  });
  it('a ticket with no approach runs with no self-checked edges', async () => {
    const registry = openStore(':memory:');
    const id = ticket(registry, { intent: 'I' });
    const load = makeReviewArtifactsBinding({
      registry, artifactsRoot: '/r', manifest: manifestWith([{ id: '', label: 'blank', checks: ['intent-spec'] }]), fallbackProjectId: () => 1, createStore: fakeFactory(specPlan).createStore,
    });
    expect((await load(id))?.spec).toContain('SPECBODY');
  });
  it('a missing manifest or a manifest without approaches still loads the artifacts', async () => {
    const registry = openStore(':memory:');
    const { createStore } = fakeFactory(specPlan);
    for (const manifest of [() => undefined, () => ({}) as unknown as Manifest]) {
      const id = ticket(registry, { intent: 'I', approach: 'speckit' });
      const a = await makeReviewArtifactsBinding({ registry, artifactsRoot: '/r', manifest, fallbackProjectId: () => 1, createStore })(id);
      expect(a?.spec).toContain('SPECBODY');
    }
  });
});
