import { createHash } from 'node:crypto';
import { mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openRecoveryRound } from '../store/recoveryRoundsWrite.js';
import { recordFixRoundManifest } from '../store/fixRoundHeads.js';
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

describe('makeReviewArtifactsBinding — operator manifest', () => {
  const setup = (round: string | null, current: string) => {
    const dir = mkdtempSync(join(tmpdir(), 'karst-manifest-'));
    const path = join(dir, 'karst.yml');
    writeFileSync(path, current);
    const registry = openStore(':memory:');
    const id = ticket(registry, { intent: 'I' });
    if (round !== null) {
      const r = openRecoveryRound(registry, { ticketId: id, sourceStage: 'review', sourceProcessId: 'review', sourceStageRunId: null, sourceProcessRunId: null, triggerKind: 'gate-failure', triggerDetail: 't', maxRounds: 10, startedAt: '2026-01-01T00:00:00Z' });
      recordFixRoundManifest(registry, r.id, path, createHash('sha256').update(round).digest('hex'));
    }
    const b = makeReviewArtifactsBinding({
      registry, artifactsRoot: '/a', manifest: () => undefined, fallbackProjectId: () => undefined,
      manifestPath: () => path, createStore: fakeFactory({}).createStore,
    });
    return { b, id, path };
  };
  it('carries path and content when the sha differs from the first fix round', async () => {
    const { b, id, path } = setup('old: 1', 'onSkip: reask');
    const a = await b(id);
    expect(a?.operatorManifest).toEqual({ path, content: 'onSkip: reask', changed: true });
  });
  it('is not changed when the sha equals the recorded one, or no round recorded one and the file predates the ticket', async () => {
    const same = setup('same: 1', 'same: 1');
    utimesSync(same.path, new Date('2000-01-01'), new Date('2000-01-01'));
    expect((await same.b(same.id))?.operatorManifest).toBeUndefined();
    const none = setup(null, 'x: 1');
    utimesSync(none.path, new Date('2000-01-01'), new Date('2000-01-01'));
    expect((await none.b(none.id))?.operatorManifest).toBeUndefined();
  });
  it('still returns the manifest for a ticket with no intent, spec or plan', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'karst-manifest-'));
    const path = join(dir, 'karst.yml');
    writeFileSync(path, 'k: 2');
    const registry = openStore(':memory:');
    const id = ticket(registry);
    const r = openRecoveryRound(registry, { ticketId: id, sourceStage: 'review', sourceProcessId: 'review', sourceStageRunId: null, sourceProcessRunId: null, triggerKind: 'gate-failure', triggerDetail: 't', maxRounds: 10, startedAt: '2026-01-01T00:00:00Z' });
    recordFixRoundManifest(registry, r.id, path, 'other-sha');
    const b = makeReviewArtifactsBinding({ registry, artifactsRoot: '/a', manifest: () => undefined, fallbackProjectId: () => undefined, manifestPath: () => path, createStore: fakeFactory({}).createStore });
    expect(await b(id)).toEqual({ intent: null, spec: null, plan: null, operatorManifest: { path, content: 'k: 2', changed: true } });
  });
  it('gives no manifest for no path, an unreadable path, or a mismatching round without a sha', async () => {
    const registry = openStore(':memory:');
    const id = ticket(registry, { intent: 'I' });
    const mk = (manifestPath?: () => string | null) =>
      makeReviewArtifactsBinding({ registry, artifactsRoot: '/a', manifest: () => undefined, fallbackProjectId: () => undefined, manifestPath, createStore: fakeFactory({}).createStore });
    expect(await mk()(id)).not.toHaveProperty('operatorManifest');
    expect(await mk(() => '')(id)).not.toHaveProperty('operatorManifest');
    expect(await mk(() => '/nonexistent/karst.yml')(id)).not.toHaveProperty('operatorManifest');
    // a first round without a recorded sha is skipped; the later round's sha is the base
    const open = () => openRecoveryRound(registry, { ticketId: id, sourceStage: 'review', sourceProcessId: 'review', sourceStageRunId: null, sourceProcessRunId: null, triggerKind: 'gate-failure', triggerDetail: 't', maxRounds: 10, startedAt: '2026-01-01T00:00:00Z' });
    open();
    const dir = mkdtempSync(join(tmpdir(), 'karst-manifest-'));
    const path = join(dir, 'karst.yml');
    writeFileSync(path, 'z: 1');
    recordFixRoundManifest(registry, open().id, path, 'old');
    expect((await mk(() => path)(id))?.operatorManifest?.changed).toBe(true);
  });
  it('counts an impl-stage change (no round yet) when the file is newer than the ticket', async () => {
    const { b, id, path } = setup(null, 'new: 1');
    // The file is written before the ticket row: pin its mtime past the ticket, so the test does not race the clock.
    const later = new Date(Date.now() + 60_000);
    utimesSync(path, later, later);
    expect((await b(id))?.operatorManifest).toEqual({ path, content: 'new: 1', changed: true });
  });
  it('keeps an impl-stage change visible after a fix round recorded the changed sha', async () => {
    const { b, id, path } = setup('new: 1', 'new: 1');
    expect((await b(id))?.operatorManifest?.changed).toBe(true);
  });
});
