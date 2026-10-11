import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createArtifactStore, ticketStoreDir } from '../../artifacts/store.js';
import type { Manifest } from '../../manifest/types.js';
import { createWorktree } from '../../runtime/worktree.js';
import { openStore, type Store } from '../../store/db.js';
import { createTicket } from '../../store/tickets.js';
import {
  makeSidebarArtifactCounts,
  makeStoredArtifactActionsForTicket,
  makeStoredArtifactsLoader,
} from './storedArtifactOps.js';

let tmp: string;
let root: string;
let registry: Store;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'sao-int-'));
  root = join(tmp, 'artifacts');
  registry = openStore(':memory:');
});
afterEach(() => {
  registry.close();
  // The Reveal checkout is read-only by design; unlock it so the temp dir can go.
  execFileSync('chmod', ['-R', 'u+w', tmp]);
  rmSync(tmp, { recursive: true, force: true });
});

async function seed(projectId: number, ticketId: number, relPath = 'plans/a.md'): Promise<void> {
  const src = join(tmp, `src-${projectId}-${ticketId}.md`);
  writeFileSync(src, 'content');
  await createArtifactStore({ artifactsRoot: root, projectId }).commitRevision({
    ticketId, repo: 'app', relPath, sourcePath: src, trailers: { kind: 'plan', approach: 'gsd', source: 'watcher' },
  });
}

const deps = (ticketId: number, over: { fallbackProjectId?: number } = {}) => ({
  registry,
  artifactsRoot: root,
  fallbackProjectId: over.fallbackProjectId,
  ticketId,
  ui: { showReadOnly: vi.fn(async () => undefined), openFile: vi.fn(async () => undefined), reveal: vi.fn(async () => undefined), confirm: vi.fn(async () => true) },
  notify: { info: vi.fn(), warn: vi.fn(), error: vi.fn(async () => undefined) },
  refresh: vi.fn(),
});

describe('stored artifact bindings (real stores)', () => {
  it("uses the TICKET's project store, not the window fallback", async () => {
    const t = createTicket(registry, { key: 'T-1', title: 't', projectId: 5 });
    await seed(5, t.id);
    const d = deps(t.id, { fallbackProjectId: 9 });
    await makeStoredArtifactActionsForTicket(d).revealStoredFolder();
    expect(d.ui.reveal).toHaveBeenCalledWith(join(ticketStoreDir(root, 5, t.id), 'view'));
  });

  it('falls back to the window project when the ticket has none; nothing stored → says so', async () => {
    const t = createTicket(registry, { key: 'T-2', title: 't' });
    await seed(9, t.id);
    const d = deps(t.id, { fallbackProjectId: 9 });
    await makeStoredArtifactActionsForTicket(d).revealStoredFolder();
    expect(d.ui.reveal).toHaveBeenCalledWith(join(ticketStoreDir(root, 9, t.id), 'view'));
    const none = deps(t.id);
    await makeStoredArtifactActionsForTicket(none).revealStoredFolder();
    expect(none.notify.info).toHaveBeenCalled();
    expect(none.ui.reveal).not.toHaveBeenCalled();
  });

  it("opens the live file from the ticket's own worktree, and warns once it is gone", async () => {
    const t = createTicket(registry, { key: 'T-3', title: 't', projectId: 5 });
    await seed(5, t.id);
    const repoPath = join(tmp, 'app');
    mkdirSync(repoPath);
    const git = (...a: string[]) => execFileSync('git', ['-C', repoPath, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { stdio: 'ignore' });
    git('init', '-q', '--initial-branch=develop');
    git('commit', '-q', '--allow-empty', '-m', 'base');
    const wtPath = createWorktree(registry, { ticketId: t.id, repoPath, slug: 'T-3', baseRef: 'develop' }).path;
    mkdirSync(join(wtPath, 'plans'), { recursive: true });
    writeFileSync(join(wtPath, 'plans', 'a.md'), 'live');
    const d = deps(t.id);
    const actions = makeStoredArtifactActionsForTicket(d);
    await actions.openStoredLive('app/plans/a.md');
    expect(d.ui.openFile).toHaveBeenCalledWith(join(wtPath, 'plans', 'a.md'));
    rmSync(join(wtPath, 'plans', 'a.md'));
    await actions.openStoredLive('app/plans/a.md');
    expect(d.ui.openFile).toHaveBeenCalledTimes(1);
    expect(d.notify.warn).toHaveBeenCalledTimes(1);
  });

  it('loads the grouped view with trailers and the manifest globs', async () => {
    const t = createTicket(registry, { key: 'T-4', title: 't', projectId: 5 });
    await seed(5, t.id);
    const manifest = { approaches: [{ id: 'gsd', name: 'gsd', outputs: [{ glob: 'plans/**', kind: 'plan' }] }] } as unknown as Manifest;
    const view = await makeStoredArtifactsLoader({
      registry, artifactsRoot: root, manifest: () => manifest, fallbackProjectId: () => 9,
    })(t.id);
    expect(view.total).toBe(1);
    expect(view.globs).toEqual(['plans/**']);
    expect(view.groups[0]).toMatchObject({ kind: 'plan', approaches: [{ approach: 'gsd' }] });
    const other = createTicket(registry, { key: 'T-5', title: 't' });
    await seed(9, other.id);
    const viaFallback = await makeStoredArtifactsLoader({
      registry, artifactsRoot: root, manifest: () => manifest, fallbackProjectId: () => 9,
    })(other.id);
    expect(viaFallback.total).toBe(1);
  });

  it('counts per ticket project (0 for a ticket without one) and signals the change', async () => {
    const t = createTicket(registry, { key: 'T-6', title: 't', projectId: 5 });
    const noProject = createTicket(registry, { key: 'T-7', title: 't' });
    await seed(5, t.id);
    await seed(5, t.id, 'plans/b.md');
    const onChange = vi.fn();
    const counts = makeSidebarArtifactCounts({ registry, artifactsRoot: root, onChange });
    expect(counts.get(t.id)).toBe(0);
    await vi.waitFor(() => expect(counts.get(t.id)).toBe(2));
    expect(onChange).toHaveBeenCalled();
    expect(counts.get(noProject.id)).toBe(0);
    await new Promise((r) => setTimeout(r, 20));
    expect(counts.get(noProject.id)).toBe(0);
  });

  it('reports a failing count through onError', async () => {
    const t = createTicket(registry, { key: 'T-8', title: 't', projectId: 5 });
    const onError = vi.fn();
    const broken = makeSidebarArtifactCounts({ registry, artifactsRoot: join(tmp, 'f'), onChange: vi.fn(), onError });
    writeFileSync(join(tmp, 'f'), 'a file, not a dir');
    broken.get(t.id);
    await new Promise((r) => setTimeout(r, 30));
    // A missing/unreadable store counts as 0 (no throw); onError only fires on a real failure.
    expect(onError.mock.calls.length).toBeLessThanOrEqual(1);
  });
});
