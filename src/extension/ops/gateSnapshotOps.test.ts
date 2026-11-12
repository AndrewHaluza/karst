import { describe, expect, it } from 'vitest';
import { openStore, type Store } from '../../store/db.js';
import { createTicket } from '../../store/tickets.js';
import { getGateSnapshot, setGateSnapshot } from '../../store/ticketGates.js';
import { manifest, repo, svc } from '../../manifest/fixtures.js';
import type { ScriptProbe } from '../../workflow/gates/probe.js';
import { takeGateSnapshot, type GateSnapshotDeps } from './gateSnapshotOps.js';

const SCRIPTS: ScriptProbe = { kind: 'ok', scripts: { test: 'vitest', lint: 'eslint .' } };

function seed(repos: readonly string[]): { store: Store; id: number } {
  const store = openStore(':memory:');
  const id = createTicket(store, { key: 'K-1', title: 'A ticket', source: 'manual' }).id;
  for (const r of repos) {
    store.db
      .prepare('INSERT INTO worktrees (ticket_id, repo, path, branch, base_ref) VALUES (?, ?, ?, ?, ?)')
      .run(id, r, `/wt${r}`, 'karst/K-1', null);
  }
  return { store, id };
}

const twoRepoManifest = () =>
  manifest({
    api: repo({ repoPath: '/repo/api', service: svc() }),
    web: repo({ repoPath: '/repo/web', service: svc() }),
  });

function deps(store: Store, over: Partial<GateSnapshotDeps> = {}): GateSnapshotDeps {
  return { store, manifest: twoRepoManifest, probe: () => SCRIPTS, ...over };
}

describe('takeGateSnapshot', () => {
  it('writes a snapshot for a new ticket whose worktrees have no diff against base', async () => {
    const { store, id } = seed(['/repo/api']);
    expect(await takeGateSnapshot(deps(store), id, { onlyIfMissing: true })).toBe(true);
    const snapshot = getGateSnapshot(store, id);
    expect(snapshot?.uat).toContain('test');
    expect(snapshot?.review).toContain('lint');
  });

  it('lists the gates of every worktree, so a repository changed later is not skipped as added', async () => {
    const { store, id } = seed(['/repo/api', '/repo/web']);
    const probe = (cwd: string): ScriptProbe =>
      cwd.endsWith('/web') ? { kind: 'ok', scripts: { e2e: 'pw' } } : { kind: 'ok', scripts: { test: 'vitest' } };
    await takeGateSnapshot(deps(store, { probe }), id);
    expect(getGateSnapshot(store, id)?.uat).toEqual(expect.arrayContaining(['test', 'e2e']));
  });

  it('does not list a gate the manifest has not got yet', async () => {
    const { store, id } = seed(['/repo/api']);
    await takeGateSnapshot(deps(store), id);
    expect(getGateSnapshot(store, id)?.review).not.toContain('layer-rules');
  });

  it('replaces an existing snapshot by default', async () => {
    const { store, id } = seed(['/repo/api']);
    setGateSnapshot(store, id, { uat: ['old'], review: ['old'] });
    await takeGateSnapshot(deps(store), id);
    expect(getGateSnapshot(store, id)?.uat).not.toContain('old');
  });

  it('keeps an existing snapshot when onlyIfMissing is set', async () => {
    const { store, id } = seed(['/repo/api']);
    setGateSnapshot(store, id, { uat: ['old'], review: ['old'] });
    expect(await takeGateSnapshot(deps(store), id, { onlyIfMissing: true })).toBe(false);
    expect(getGateSnapshot(store, id)).toEqual({ uat: ['old'], review: ['old'] });
  });

  it('writes nothing when no gate resolves (a failed read must not skip every gate)', async () => {
    const { store, id } = seed(['/repo/api']);
    setGateSnapshot(store, id, { uat: ['old'], review: ['old'] });
    const ok = await takeGateSnapshot(deps(store, { probe: () => ({ kind: 'absent' }) }), id);
    expect(ok).toBe(false);
    expect(getGateSnapshot(store, id)).toEqual({ uat: ['old'], review: ['old'] });
  });

  it('writes nothing when no manifest is loaded', async () => {
    const { store, id } = seed(['/repo/api']);
    expect(await takeGateSnapshot(deps(store, { manifest: () => undefined }), id)).toBe(false);
    expect(getGateSnapshot(store, id)).toBeNull();
  });

  it('resolves false and never rejects when the probe throws', async () => {
    const { store, id } = seed(['/repo/api']);
    const debug: string[] = [];
    const probe = (): ScriptProbe => { throw new Error('disk down'); };
    await expect(takeGateSnapshot(deps(store, { probe, debug: (m) => debug.push(m) }), id)).resolves.toBe(false);
    expect(debug.join('\n')).toContain('disk down');
  });

  it('resolves false and never rejects when the store read throws (fire-and-forget safe)', async () => {
    const { store, id } = seed(['/repo/api']);
    store.db.close();
    await expect(takeGateSnapshot(deps(store), id, { onlyIfMissing: true })).resolves.toBe(false);
  });
});
