import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createWorktree } from '../runtime/worktree.js';
import { openStore, type Store } from '../store/db.js';
import { createTicket } from '../store/tickets.js';
import { addArtifactForTicket } from './forTicket.js';
import { createArtifactStore } from './store.js';

let tmp: string;
let registry: Store;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'art-forticket-'));
  registry = openStore(':memory:');
});
afterEach(() => {
  registry.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe('addArtifactForTicket', () => {
  it('keys the stored file by the repo BASENAME, not the registry\'s repo path', async () => {
    const ticket = createTicket(registry, { key: 'T-1', title: 't', projectId: 4 });
    const repoPath = join(tmp, 'app');
    mkdirSync(repoPath);
    const git = (...a: string[]) =>
      execFileSync('git', ['-C', repoPath, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { stdio: 'ignore' });
    git('init', '-q', '--initial-branch=develop');
    git('commit', '-q', '--allow-empty', '-m', 'base');
    const wt = createWorktree(registry, { ticketId: ticket.id, repoPath, slug: 'T-1', baseRef: 'develop' }).path;
    mkdirSync(join(wt, 'scripts'));
    writeFileSync(join(wt, 'scripts', 'dev.sh'), 'echo hi');

    const added = await addArtifactForTicket(registry, join(tmp, 'artifacts'), ticket.id, 'scripts/dev.sh', 'script');

    expect(added).toMatchObject({ repo: 'app', relPath: 'scripts/dev.sh' });
    const listed = await createArtifactStore({ artifactsRoot: join(tmp, 'artifacts'), projectId: 4 }).listArtifacts(ticket.id);
    expect(listed.map((a) => a.path)).toEqual(['app/scripts/dev.sh']);
  });
});
