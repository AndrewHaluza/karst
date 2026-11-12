import { describe, expect, it } from 'vitest';
import { openStore } from '../../store/db.js';
import { createTicket } from '../../store/tickets.js';
import { getGateSnapshot, setStageGateSnapshot } from '../../store/ticketGates.js';
import { manifest, repo, svc, review as reviewConfig } from '../../manifest/fixtures.js';
import type { ScriptProbe } from '../gates/probe.js';
import { captureGateSnapshot, collectGateSnapshot, type CutDefines } from './gateSnapshot.js';

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
const apiTreeOnBase = [{ repo: '/repo/api', path: '/wt/api', baseRef: 'develop' }];
// The git seam: (null = unreadable) what the branch was cut with.
const git = (cutDefines: CutDefines = async () => null) => ({ cutDefines });
const branchLacks = (): ScriptProbe => ({ kind: 'ok', scripts: { test: 'vitest' } });

describe('collectGateSnapshot', () => {
  it('lists the manifest-declared gates of every worktree', async () => {
    const snap = await collectGateSnapshot(declared('lint:layers'), apiTree, () => ({ kind: 'ok', scripts: { 'lint:layers': 'x' } }));
    expect(snap.review).toEqual(['layer-rules']);
  });

  it('leaves out a discovered gate: the ticket own branch can add a package.json script', async () => {
    const snap = await collectGateSnapshot(m(), trees, probe);
    expect(snap).toEqual({ uat: null, review: null });
  });

  it('leaves out a declared script gate the cut lacks, whether or not the base has it (the T1106 incident window)', async () => {
    const seen: string[] = [];
    const snap = await collectGateSnapshot(declared('lint:layers'), apiTreeOnBase, branchLacks, undefined, git(async (cwd, ref, script) => {
      seen.push(`${cwd}|${ref}|${script}`);
      return false;
    }));
    expect(snap.review).toEqual([]);
    expect(seen).toContain('/wt/api|develop|lint:layers');
  });

  it('keeps a gate whose script the branch was cut with even when the worktree lost it (an agent edit must not hide the gate)', async () => {
    const snap = await collectGateSnapshot(declared('lint:layers'), apiTreeOnBase, branchLacks, undefined, git(async () => true));
    expect(snap.review).toEqual(['layer-rules']);
  });

  it('leaves out a gate the cut lacks, whatever the worktree holds now', async () => {
    const worktreeHas = (): ScriptProbe => ({ kind: 'ok', scripts: { 'lint:layers': 'agent added it' } });
    const snap = await collectGateSnapshot(declared('lint:layers'), apiTreeOnBase, worktreeHas, undefined, git(async () => false));
    expect(snap.review).toEqual([]);
  });

  it('falls back to the worktree files when the cut point cannot be read', async () => {
    const lacks = await collectGateSnapshot(declared('lint:layers'), apiTreeOnBase, branchLacks, undefined, git(async () => null));
    expect(lacks.review).toEqual([]);
    const has = await collectGateSnapshot(declared('lint:layers'), apiTree, () => ({ kind: 'ok', scripts: { 'lint:layers': 'x' } }), undefined, git(async () => null));
    expect(has.review).toEqual(['layer-rules']);
  });

  it('throws on an unreadable package.json, so a transient fault never writes a partial snapshot', async () => {
    await expect(collectGateSnapshot(declared('lint:layers'), apiTree, () => ({ kind: 'io-error', message: 'EIO' }))).rejects.toThrow('EIO');
  });

  it('ignores a worktree that matches no manifest entry', async () => {
    const snap = await collectGateSnapshot(declared('lint:layers'), [{ repo: '/elsewhere', path: '/wt/x', baseRef: null }], probe);
    expect(snap).toEqual({ uat: null, review: null });
  });
});

describe('captureGateSnapshot', () => {
  const seed = () => {
    const store = openStore(':memory:');
    return { store, id: createTicket(store, { key: 'K-1', title: 'T', source: 'manual' }).id };
  };

  it('writes both stages for a ticket with none', async () => {
    const { store, id } = seed();
    await captureGateSnapshot(store, id, declared('lint:layers'), apiTree, () => ({ kind: 'ok', scripts: { 'lint:layers': 'x' } }));
    expect(getGateSnapshot(store, id)?.review).toEqual(['layer-rules']);
  });

  it('never overwrites a stage that already has a snapshot', async () => {
    const { store, id } = seed();
    setStageGateSnapshot(store, id, 'review', ['kept']);
    await captureGateSnapshot(store, id, declared('lint:layers'), apiTree, () => ({ kind: 'ok', scripts: { 'lint:layers': 'x' } }));
    expect(getGateSnapshot(store, id)?.review).toEqual(['kept']);
  });

  it('writes nothing when no gate resolves', async () => {
    const { store, id } = seed();
    await captureGateSnapshot(store, id, m(), trees, () => ({ kind: 'absent' }));
    expect(getGateSnapshot(store, id)).toBeNull();
  });

  it('swallows a failed read, logs it, and leaves the snapshot unset', async () => {
    const { store, id } = seed();
    const debug: string[] = [];
    const broken = { ...m(), repositories: undefined } as unknown as ReturnType<typeof m>;
    await expect(captureGateSnapshot(store, id, broken, trees, probe, (x) => debug.push(x))).resolves.toBeUndefined();
    expect(getGateSnapshot(store, id)).toBeNull();
    expect(debug.join('\n')).toContain('not captured');
  });
});
