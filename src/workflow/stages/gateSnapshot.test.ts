import { describe, expect, it } from 'vitest';
import { openStore } from '../../store/db.js';
import { createTicket } from '../../store/tickets.js';
import { getGateSnapshot, setStageGateSnapshot } from '../../store/ticketGates.js';
import { manifest, repo, svc } from '../../manifest/fixtures.js';
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

describe('collectGateSnapshot', () => {
  it('unions the gates of every worktree, with no diff probe', () => {
    expect(collectGateSnapshot(m(), trees, probe).uat).toEqual(expect.arrayContaining(['test', 'e2e']));
  });

  it('ignores a worktree that matches no manifest entry', () => {
    const snap = collectGateSnapshot(m(), [{ repo: '/elsewhere', path: '/wt/x', baseRef: null }], probe);
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
    captureGateSnapshot(store, id, m(), trees, probe);
    expect(getGateSnapshot(store, id)?.uat).toEqual(expect.arrayContaining(['test', 'e2e']));
  });

  it('never overwrites a stage that already has a snapshot', () => {
    const { store, id } = seed();
    setStageGateSnapshot(store, id, 'uat', ['kept']);
    captureGateSnapshot(store, id, m(), trees, probe);
    expect(getGateSnapshot(store, id)?.uat).toEqual(['kept']);
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
