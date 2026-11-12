import { describe, expect, it } from 'vitest';
import { openStore, type Store } from '../../store/db.js';
import { createTicket } from '../../store/tickets.js';
import { recordGateRun } from '../../store/gateRuns.js';
import { getGateSnapshot, setGateSnapshot } from '../../store/ticketGates.js';
import { manifest, repo, svc, uat, review } from '../../manifest/fixtures.js';
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

const repos = {
  api: repo({ repoPath: '/repo/api', service: svc() }),
  web: repo({ repoPath: '/repo/web', service: svc() }),
};
// Declared gates only: a discovered gate is never snapshotted (a branch can add its own script).
const declaredManifest = () =>
  manifest(repos, {
    uat: uat({ gates: [{ name: 'test', kind: 'script', script: 'test' }] }),
    review: review({ gates: [{ name: 'lint', kind: 'script', script: 'lint' }] }),
  });
const twoRepoManifest = declaredManifest;

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
    await takeGateSnapshot(deps(store), id);
    expect(getGateSnapshot(store, id)?.uat?.length).toBeGreaterThanOrEqual(1);
  });

  it('does not list a gate the manifest has not got yet', async () => {
    const { store, id } = seed(['/repo/api']);
    await takeGateSnapshot(deps(store), id);
    expect(getGateSnapshot(store, id)?.review).not.toContain('layer-rules');
  });

  it('writes nothing when a declared gate script cannot be probed (io-error)', async () => {
    const { store, id } = seed(['/repo/api']);
    const probe = (): ScriptProbe => ({ kind: 'io-error', message: 'EIO' });
    expect(await takeGateSnapshot(deps(store, { probe }), id)).toBe(false);
    expect(getGateSnapshot(store, id)).toBeNull();
  });

  it('writes nothing at spin for a ticket that already ran gates (a pre-snapshot ticket keeps every gate)', async () => {
    const { store, id } = seed(['/repo/api']);
    recordGateRun(store, { ticketId: id, stageKey: 'review', attempt: 1, runAt: 't', gates: [{ gateName: 'lint (api)', exitCode: 0 }] });
    expect(await takeGateSnapshot(deps(store), id, { onlyIfMissing: true })).toBe(false);
    expect(getGateSnapshot(store, id)).toBeNull();
  });

  it('retakes the snapshot after a rebase even for a ticket that already ran gates', async () => {
    const { store, id } = seed(['/repo/api']);
    recordGateRun(store, { ticketId: id, stageKey: 'review', attempt: 1, runAt: 't', gates: [{ gateName: 'lint (api)', exitCode: 0 }] });
    expect(await takeGateSnapshot(deps(store, { manifest: declaredManifest }), id)).toBe(true);
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
    const ok = await takeGateSnapshot(deps(store, { manifest: () => manifest(repos) }), id);
    expect(ok).toBe(false);
    expect(getGateSnapshot(store, id)).toEqual({ uat: ['old'], review: ['old'] });
  });

  it('leaves a gate out of the snapshot when the cut lacks its script, and keeps it when the cut has it', async () => {
    const { store, id } = seed([]);
    store.db.prepare('INSERT INTO worktrees (ticket_id, repo, path, branch, base_ref) VALUES (?, ?, ?, ?, ?)').run(id, '/repo/api', '/wt/repo/api', 'karst/K-1', 'develop');
    const branchLacks = () => ({ kind: 'ok', scripts: {} }) as ScriptProbe;
    await takeGateSnapshot(deps(store, { probe: branchLacks, cutDefines: async (_c, _r, script) => script === 'lint' }), id);
    expect(getGateSnapshot(store, id)).toEqual({ uat: [], review: ['lint'] });
  });

  it('does not overwrite a snapshot a concurrent capture wrote during the read (onlyIfMissing)', async () => {
    const { store, id } = seed([]);
    store.db.prepare('INSERT INTO worktrees (ticket_id, repo, path, branch, base_ref) VALUES (?, ?, ?, ?, ?)').run(id, '/repo/api', '/wt/repo/api', 'karst/K-1', 'develop');
    const cutDefines = async () => {
      setGateSnapshot(store, id, { uat: ['first'], review: ['first'] });
      return true;
    };
    expect(await takeGateSnapshot(deps(store, { cutDefines }), id, { onlyIfMissing: true })).toBe(false);
    expect(getGateSnapshot(store, id)).toEqual({ uat: ['first'], review: ['first'] });
  });

  it('keeps the old snapshot of a stage that resolved no declared gate (a retake)', async () => {
    const { store, id } = seed(['/repo/api']);
    setGateSnapshot(store, id, { uat: ['old'], review: ['old'] });
    const reviewOnly = () => manifest(repos, { review: review({ gates: [{ name: 'lint', kind: 'script', script: 'lint' }] }) });
    await takeGateSnapshot(deps(store, { manifest: reviewOnly }), id);
    expect(getGateSnapshot(store, id)).toEqual({ uat: ['old'], review: ['lint'] });
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
