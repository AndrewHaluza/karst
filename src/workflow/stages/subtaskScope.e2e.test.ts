import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, type Store } from '../../store/db.js';
import type { Manifest } from '../../manifest/types.js';
import { manifest as buildManifest, runnableRepo } from '../../manifest/fixtures.js';
import { createTicketFlow } from './create.js';
import { confirmScope } from './scope.js';
import { createSubtask } from './subtask.js';
import { updateTicketFields, getTicket } from '../../store/tickets.js';
import { resolveTicketBaseRef } from '../baseRef.js';
import { ticketWorktreeNames } from '../../runtime/ticketBranch.js';

/**
 * Real-git end-to-end for the sub-task cut (design NDL-70 §4), against a local
 * bare "remote" — no network, but the actual fetch/worktree semantics.
 *
 * The load-bearing claim is "same lineage, no pull": the sub-task's start point
 * is the parent's LOCAL branch head, so it sees the parent's committed-but-
 * unpushed work — even though `origin/<parentBranch>` exists and is BEHIND it.
 * A wrong implementation that pulled the parent branch would silently start the
 * sub-task behind the parent.
 */

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} in ${cwd}: ${r.stderr}`);
  return r.stdout ?? '';
}

describe('sub-task scope (real git, cut from the parent local head)', () => {
  let store: Store;
  let origin: string;
  let repo: string;
  let manifest: Manifest;
  const dirs: string[] = [];

  const tmp = (prefix: string): string => {
    const d = mkdtempSync(join(tmpdir(), prefix));
    dirs.push(d);
    return d;
  };

  beforeEach(() => {
    store = openStore(':memory:');

    origin = tmp('karst-sub-origin-');
    git(origin, 'init', '-q', '--bare', '-b', 'develop');

    repo = tmp('karst-sub-repo-');
    writeFileSync(join(repo, 'index.js'), 'x\n');
    git(repo, 'init', '-q', '-b', 'develop');
    git(repo, 'config', 'user.email', 't@k.local');
    git(repo, 'config', 'user.name', 't');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'init');
    git(repo, 'remote', 'add', 'origin', origin);
    git(repo, 'push', '-q', '-u', 'origin', 'develop');

    manifest = buildManifest(
      { frontend: runnableRepo({}, { repoPath: repo }) },
      { portRange: [4000, 4100] },
    );
  });
  afterEach(() => {
    store.close();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('cuts from the parent local head, records the parent branch, and needs no downstream changes', async () => {
    // 1. Parent scoped off develop (its worktree/branch now exist).
    const parentTicket = createTicketFlow(store, { key: 'E2E-1', title: 'parent' });
    updateTicketFields(store, parentTicket.id, { selectedRepos: ['frontend'] });
    await confirmScope(store, manifest, parentTicket.id, ['frontend'], { pullBase: false });
    const parentNames = ticketWorktreeNames(getTicket(store, parentTicket.id), manifest);
    const parentWt = join(repo, '.karst', 'worktrees', parentNames.slug);

    // origin/<parentBranch> exists but is BEHIND: pushed at the fork point...
    git(parentWt, 'push', '-q', 'origin', parentNames.branch);
    // ...then the parent commits work it has NOT pushed.
    writeFileSync(join(parentWt, 'unpushed.js'), 'parent work\n');
    git(parentWt, 'add', '.');
    git(parentWt, 'commit', '-q', '-m', 'unpushed parent work');
    const localHead = git(parentWt, 'rev-parse', 'HEAD').trim();
    const remoteHead = git(repo, 'rev-parse', `origin/${parentNames.branch}`).trim();
    expect(remoteHead).not.toBe(localHead); // the stale-remote condition is real

    // 2. The sub-task, with the pull switch LEFT ON — it must still skip.
    const child = createSubtask(store, parentTicket.id, { title: 'child', repos: ['frontend'] });
    const records = await confirmScope(store, manifest, child.id, ['frontend']);

    expect(records).toHaveLength(1);
    const childWt = records[0]!.path;
    // The cut is exactly the parent's local head.
    expect(git(childWt, 'rev-parse', 'HEAD').trim()).toBe(localHead);
    // The parent's UNPUSHED file is present; the stale remote is irrelevant.
    expect(existsSync(join(childWt, 'unpushed.js'))).toBe(true);
    // `base_ref` records the plain parent branch name.
    expect(records[0]!.baseRef).toBe(parentNames.branch);

    // 3. Downstream needs no changes: resolveTicketBaseRef reads the stored
    //    base_ref and answers the parent branch (gate targets / merge-check /
    //    ship all go through this).
    expect(resolveTicketBaseRef(store, child.id, repo, manifest)).toBe(parentNames.branch);
  });
});
