import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { defaultGitRunner } from '../integrations/git.js';
import type { Manifest } from '../manifest/types.js';
import { createWorktree } from '../runtime/worktree.js';
import { openStore, type Store } from '../store/db.js';
import { openImplementationRun } from '../store/implementationRuns.js';
import { listPhaseMarks } from '../store/phaseMarks.js';
import { createTicket } from '../store/tickets.js';
import { wireArtifactCapture, type ArtifactCaptureWiring } from './artifactCaptureWiring.js';

const sh = (cwd: string, ...args: string[]): void => {
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd, stdio: 'ignore' });
};
const put = (root: string, rel: string, body: string): void => {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), body);
};

/**
 * The agent's PostToolUse hook is its own capture path (`@arch:APP-09`). Rule B
 * must be reached from it too, or a phase proven by an edit the hook captured
 * would stay unmarked until a sweep. Real git and a real artifact store: this is
 * the end-to-end proof, not a mock.
 */
describe('artifact capture wiring — hook path (real capture)', () => {
  let tmp: string;
  let repo: string;
  let store: Store;
  let wiring: ArtifactCaptureWiring;
  let ticketId: number;
  let wtPath: string;
  const manifest = { approaches: [{ id: 'superpowers' }] } as unknown as Manifest;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'karst-wire-'));
    repo = join(tmp, 'app');
    mkdirSync(repo);
    sh(repo, 'init', '-q', '--initial-branch=develop');
    put(repo, 'README.md', 'base');
    sh(repo, 'add', '-A');
    sh(repo, 'commit', '-q', '-m', 'base');
    store = openStore(':memory:');
    ticketId = createTicket(store, { key: 'T-1', title: 't' }).id;
    store.db.prepare("UPDATE tickets SET stage_current = 'impl' WHERE id = ?").run(ticketId);
    wtPath = createWorktree(store, { ticketId, repoPath: repo, slug: 'T-1', baseRef: 'develop' }).path;
    openImplementationRun(store, {
      ticketId, attempt: 0, provider: 'claude', startedAt: '2026-08-01T11:00:00.000Z',
    });
    wiring = wireArtifactCapture({
      store,
      globalStorageRoot: join(tmp, 'gs'),
      projectId: () => 7,
      manifest: () => manifest,
      git: defaultGitRunner,
      debug: () => {},
      phasesOf: () => [{ name: 'plan', outputKind: 'plan' }, { name: 'implement' }],
      fsWatch: (() => ({ on: () => {}, close: () => {} })) as never,
    });
  });

  afterEach(() => {
    wiring.dispose();
    store.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('writes the host phase mark when a PostToolUse capture commits the plan', async () => {
    put(wtPath, 'docs/superpowers/plans/a.md', '# plan\n');

    wiring.onHookEvent(ticketId, {
      hook_event_name: 'PostToolUse',
      cwd: wtPath,
      file_path: join(wtPath, 'docs/superpowers/plans/a.md'),
    });

    await vi.waitFor(() =>
      expect(listPhaseMarks(store, ticketId).map((m) => [m.phaseName, m.source, m.attempt])).toEqual([
        ['implement', 'host', 0],
      ]),
    );
  });
});
