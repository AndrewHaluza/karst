import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ArtifactStore } from '../../artifacts/store.js';
import type { Manifest } from '../../manifest/types.js';
import { openStore } from '../../store/db.js';
import { createTicket } from '../../store/tickets.js';
import { makeStoredArtifactActions, makeStoredArtifactsLoader, type StoredArtifactDeps } from './storedArtifactOps.js';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
let wt: string;

beforeEach(() => {
  wt = mkdtempSync(join(tmpdir(), 'sao-'));
  mkdirSync(join(wt, 'plans'));
  writeFileSync(join(wt, 'plans', 'a.md'), 'live');
});
afterEach(() => rmSync(wt, { recursive: true, force: true }));

function setup(over: Partial<StoredArtifactDeps> = {}) {
  const store = {
    listArtifacts: vi.fn(async () => [{ path: 'app/plans/a.md', revisions: 2, latestSha: SHA_B }]),
    history: vi.fn(async () => [
      { sha: SHA_B, at: 't2', trailers: {} },
      { sha: SHA_A, at: 't1', trailers: {} },
    ]),
    show: vi.fn(async () => Buffer.from('body')),
    materializeView: vi.fn(async () => '/store/view'),
    purgeArtifacts: vi.fn(async () => undefined),
  } as unknown as ArtifactStore;
  const ui = {
    showReadOnly: vi.fn(async () => undefined),
    showPreview: vi.fn(async () => undefined),
    showDiff: vi.fn(async () => undefined),
    openFile: vi.fn(async () => undefined),
    reveal: vi.fn(async () => undefined),
    confirm: vi.fn(async () => true),
  };
  const notify = { info: vi.fn(), warn: vi.fn(), error: vi.fn(async () => undefined) };
  const refresh = vi.fn();
  const deps: StoredArtifactDeps = {
    store, ticketId: 1, worktrees: () => [{ repo: 'app', path: wt }], ui, notify, refresh, ...over,
  };
  return { actions: makeStoredArtifactActions(deps), store, ui, notify, refresh };
}

describe('storedArtifactOps', () => {
  it('opens a known markdown revision in the rendered preview', async () => {
    const { actions, ui, store } = setup();
    await actions.openStoredRevision('app/plans/a.md', SHA_A);
    expect(store.show).toHaveBeenCalledWith(1, SHA_A, 'app/plans/a.md');
    expect(ui.showPreview).toHaveBeenCalledWith(`a.md @ ${SHA_A.slice(0, 7)}`, 'body');
    expect(ui.showReadOnly).not.toHaveBeenCalled();
  });

  it('opens any other revision as read-only text', async () => {
    const { actions, ui, store } = setup();
    (store.listArtifacts as ReturnType<typeof vi.fn>).mockResolvedValue([{ path: 'app/x.json', revisions: 2, latestSha: SHA_B }]);
    await actions.openStoredRevision('app/x.json', SHA_A);
    expect(ui.showReadOnly).toHaveBeenCalledWith(`x.json @ ${SHA_A.slice(0, 7)}`, 'body', undefined);
    expect(ui.showPreview).not.toHaveBeenCalled();
  });

  it('refuses a diff when only ONE of the two revisions is known', async () => {
    const { actions, ui, store } = setup();
    await actions.diffStoredRevisions('app/plans/a.md', SHA_A, 'c'.repeat(40));
    await actions.diffStoredRevisions('app/plans/a.md', 'c'.repeat(40), SHA_B);
    expect(store.show).not.toHaveBeenCalled();
    expect(ui.showDiff).not.toHaveBeenCalled();
  });

  it('refuses an unknown artifact or revision', async () => {
    const { actions, ui, notify } = setup();
    await actions.openStoredRevision('app/other.md', SHA_A);
    expect(notify.warn).toHaveBeenLastCalledWith('That artifact is no longer available.');
    await actions.openStoredRevision('app/plans/a.md', 'c'.repeat(40));
    expect(notify.warn).toHaveBeenLastCalledWith('That revision is no longer available.');
    expect(ui.showReadOnly).not.toHaveBeenCalled();
    expect(notify.warn).toHaveBeenCalledTimes(2);
  });

  it('diffs two known revisions side by side over read-only documents', async () => {
    const { actions, ui, store } = setup();
    (store.show as ReturnType<typeof vi.fn>).mockImplementation(async (_t, sha) => Buffer.from(sha === SHA_A ? 'old' : 'new'));
    await actions.diffStoredRevisions('app/plans/a.md', SHA_A, SHA_B);
    expect(ui.showDiff).toHaveBeenCalledWith(
      `a.md ${SHA_A.slice(0, 7)} ↔ ${SHA_B.slice(0, 7)}`,
      { title: `a.md @ ${SHA_A.slice(0, 7)}`, text: 'old' },
      { title: `a.md @ ${SHA_B.slice(0, 7)}`, text: 'new' },
    );
  });

  it('says so when the two revisions are identical', async () => {
    const { actions, ui, notify } = setup();
    await actions.diffStoredRevisions('app/plans/a.md', SHA_A, SHA_B);
    expect(ui.showDiff).not.toHaveBeenCalled();
    expect(notify.info).toHaveBeenCalledWith('No differences between those revisions.');
  });

  it('opens the live worktree file when it exists, warns when gone', async () => {
    const { actions, ui, notify } = setup();
    await actions.openStoredLive('app/plans/a.md');
    expect(ui.openFile).toHaveBeenCalledWith(join(wt, 'plans', 'a.md'));
    rmSync(join(wt, 'plans', 'a.md'));
    await actions.openStoredLive('app/plans/a.md');
    expect(ui.openFile).toHaveBeenCalledTimes(1);
    expect(notify.warn).toHaveBeenCalledWith('The live file is gone from the worktree — only stored revisions remain.');
  });

  it('warns for a stored path whose repo has no worktree, and for an unknown safe path', async () => {
    const { actions, ui, notify } = setup({ worktrees: () => [{ repo: 'other', path: wt }] });
    await actions.openStoredLive('app/plans/a.md');
    expect(notify.warn).toHaveBeenLastCalledWith('The live file is gone from the worktree — only stored revisions remain.');
    const s2 = setup();
    await s2.actions.openStoredLive('app/not-stored.md');
    expect(s2.notify.warn).toHaveBeenLastCalledWith('That artifact is no longer available.');
    await s2.actions.openStoredLive('app');
    expect(s2.ui.openFile).not.toHaveBeenCalled();
    expect(ui.openFile).not.toHaveBeenCalled();
  });

  it('never resolves a live path outside the worktree', async () => {
    const { actions, ui, notify } = setup({
      store: {
        listArtifacts: async () => [{ path: 'app/../../etc/passwd', revisions: 1, latestSha: SHA_A }],
      } as unknown as ArtifactStore,
    });
    await actions.openStoredLive('app/../../etc/passwd');
    expect(ui.openFile).not.toHaveBeenCalled();
    expect(notify.warn).toHaveBeenCalledWith('That artifact is no longer available.');
  });

  it('reveals the refreshed view folder, or says nothing is stored', async () => {
    const { actions, ui, store, notify } = setup();
    await actions.revealStoredFolder();
    expect(ui.reveal).toHaveBeenCalledWith('/store/view');
    (store.materializeView as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    await actions.revealStoredFolder();
    expect(ui.reveal).toHaveBeenCalledTimes(1);
    expect(notify.info).toHaveBeenCalledWith('No artifacts are stored for this ticket yet.');
  });

  it('purges only after confirmation, then refreshes', async () => {
    const { actions, ui, store, refresh } = setup();
    ui.confirm.mockResolvedValueOnce(false);
    await actions.purgeStoredArtifacts();
    expect(store.purgeArtifacts).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
    expect(ui.confirm).toHaveBeenCalledWith('Delete every stored artifact revision for this ticket? This cannot be undone.');
    await actions.purgeStoredArtifacts();
    expect(store.purgeArtifacts).toHaveBeenCalledWith(1);
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});

describe('makeStoredArtifactsLoader', () => {
  it('names the active outputs globs for a ticket with nothing stored', async () => {
    const registry = openStore(':memory:');
    const ticketId = createTicket(registry, { key: 'T-1', title: 't' }).id;
    const manifest = {
      approaches: [{ id: 'x', name: 'x', outputs: [{ glob: 'plans/**', kind: 'plan' }, { glob: 'plans/**', kind: 'spec' }] }],
    } as unknown as Manifest;
    const load = makeStoredArtifactsLoader({
      registry, artifactsRoot: join(wt, 'artifacts'), manifest: () => manifest, fallbackProjectId: () => 3,
    });
    expect(await load(ticketId)).toEqual({ total: 0, groups: [], skips: [], globs: ['plans/**'] });
    const none = makeStoredArtifactsLoader({
      registry, artifactsRoot: join(wt, 'artifacts'), manifest: () => undefined, fallbackProjectId: () => undefined,
    });
    expect((await none(ticketId)).globs).toEqual([]);
    registry.close();
  });
});
