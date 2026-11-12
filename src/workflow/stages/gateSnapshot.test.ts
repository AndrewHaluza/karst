import { describe, expect, it } from 'vitest';
import { openStore } from '../../store/db.js';
import { createTicket } from '../../store/tickets.js';
import { getGateSnapshot, setStageGateSnapshot } from '../../store/ticketGates.js';
import { manifest, repo, svc, review as reviewConfig } from '../../manifest/fixtures.js';
import type { ScriptProbe } from '../gates/probe.js';
import { captureGateSnapshot, collectGateSnapshot } from './gateSnapshot.js';

const m = () =>
  manifest({
    api: repo({ repoPath: '/repo/api', service: svc() }),
    web: repo({ repoPath: '/repo/web', service: svc() }),
  });
const trees = [
  { repo: '/repo/api', path: '/wt/api', baseRef: null },
  { repo: '/repo/web', path: '/wt/web', baseRef: null },
];
const probe = (cwd: string): ScriptProbe =>
  cwd.endsWith('/web') ? { kind: 'ok', scripts: { e2e: 'pw' } } : { kind: 'ok', scripts: { test: 'vitest' } };

const declared = (script: string) =>
  manifest(
    { api: repo({ repoPath: '/repo/api', service: svc() }) },
    { review: reviewConfig({ gates: [{ name: 'layer-rules', kind: 'script', script }] }) },
  );
const apiTree = [{ repo: '/repo/api', path: '/wt/api', baseRef: null }];

describe('collectGateSnapshot', () => {
  it('lists the manifest-declared gates of every worktree', () => {
    const snap = collectGateSnapshot(declared('lint:layers'), apiTree, () => ({ kind: 'ok', scripts: { 'lint:layers': 'x' } }));
    expect(snap.review).toEqual(['layer-rules']);
  });

  it('leaves out a discovered gate: the ticket own branch can add a package.json script', () => {
    const snap = collectGateSnapshot(m(), trees, probe);
    expect(snap).toEqual({ uat: [], review: [] });
  });

  it('leaves out a declared script gate the worktree cannot run yet, so a later rebase can add it', () => {
    const snap = collectGateSnapshot(declared('lint:layers'), apiTree, () => ({ kind: 'ok', scripts: { test: 'vitest' } }));
    expect(snap.review).toEqual([]);
  });

  it('throws on an unreadable package.json, so a transient fault never writes a partial snapshot', () => {
    expect(() => collectGateSnapshot(declared('lint:layers'), apiTree, () => ({ kind: 'io-error', message: 'EIO' }))).toThrow('EIO');
  });

  it('ignores a worktree that matches no manifest entry', () => {
    const snap = collectGateSnapshot(declared('lint:layers'), [{ repo: '/elsewhere', path: '/wt/x', baseRef: null }], probe);
    expect(snap).toEqual({ uat: [], review: [] });
  });
});

describe('captureGateSnapshot', () => {
  const seed = () => {
    const store = openStore(':memory:');
    return { store, id: createTicket(store, { key: 'K-1', title: 'T', source: 'manual' }).id };
  };

  it('writes both stages for a ticket with none', () => {
    const { store, id } = seed();
    captureGateSnapshot(store, id, declared('lint:layers'), apiTree, () => ({ kind: 'ok', scripts: { 'lint:layers': 'x' } }));
    expect(getGateSnapshot(store, id)?.review).toEqual(['layer-rules']);
  });

  it('never overwrites a stage that already has a snapshot', () => {
    const { store, id } = seed();
    setStageGateSnapshot(store, id, 'review', ['kept']);
    captureGateSnapshot(store, id, declared('lint:layers'), apiTree, () => ({ kind: 'ok', scripts: { 'lint:layers': 'x' } }));
    expect(getGateSnapshot(store, id)?.review).toEqual(['kept']);
  });

  it('writes nothing when no gate resolves', () => {
    const { store, id } = seed();
    captureGateSnapshot(store, id, m(), trees, () => ({ kind: 'absent' }));
    expect(getGateSnapshot(store, id)).toBeNull();
  });

  it('swallows a failed read, logs it, and leaves the snapshot unset', () => {
    const { store, id } = seed();
    const debug: string[] = [];
    const broken = { ...m(), repositories: undefined } as unknown as ReturnType<typeof m>;
    expect(() => captureGateSnapshot(store, id, broken, trees, probe, (x) => debug.push(x))).not.toThrow();
    expect(getGateSnapshot(store, id)).toBeNull();
    expect(debug.join('\n')).toContain('not captured');
  });
});
