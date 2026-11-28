import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runGit, type GitRunner } from '../../integrations/git.js';
import type { Store } from '../../store/db.js';
import type { BaselineEntry } from '../gates/baselineReview.js';
import type { precheckBaselines } from '../gates/baselinePrecheck.js';
import { runUatBaselinePrecheck } from './uatBaselinePrecheck.js';

/**
 * The changed-path list on a REAL repo, in another project's layout: the
 * working tree is compared to the merge-base (not HEAD), an uncommitted edit
 * and an untracked new file both reach the prompt, and a changed baseline image
 * stays out — the tracked list first, then the untracked one.
 */
const git: GitRunner = (args, cwd) => runGit(args, cwd);

describe('runUatBaselinePrecheck — changed files on a real repo', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('sends a tracked edit then an untracked new file, and never the baseline image', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'precheck-paths-'));
    dirs.push(dir);
    const g = (...args: string[]): string =>
      execFileSync('git', args, { cwd: dir, stdio: 'pipe' }).toString().trim();
    g('init', '-q', '-b', 'develop');
    g('config', 'user.email', 't@t');
    g('config', 'user.name', 't');
    mkdirSync(join(dir, 'app/views'), { recursive: true });
    mkdirSync(join(dir, 'tests/visual/__baselines__/dark'), { recursive: true });
    writeFileSync(join(dir, 'app/views/account.tsx'), 'export const Account = 1;\n');
    writeFileSync(join(dir, 'tests/visual/__baselines__/dark/home.png'), Buffer.alloc(64, 1));
    g('add', '-A');
    g('commit', '-q', '-m', 'base');
    const mergeBase = g('rev-parse', 'HEAD');
    g('checkout', '-q', '-b', 'feat');

    // At UAT nothing is committed: the edit, the new file and the re-recorded
    // baseline are all working-tree changes.
    writeFileSync(join(dir, 'app/views/account.tsx'), 'export const Account = 2;\n');
    writeFileSync(join(dir, 'app/views/home.tsx'), 'export const Home = 1;\n');
    writeFileSync(join(dir, 'tests/visual/__baselines__/dark/home.png'), Buffer.alloc(64, 2));

    const entry: BaselineEntry = {
      repo: 'app',
      cwd: dir,
      path: 'tests/visual/__baselines__/dark/home.png',
      status: 'modified',
      newSha256: 'sha-home',
      mergeBase,
      autoApproved: false,
    };
    const seen: string[][] = [];
    const precheck: typeof precheckBaselines = async (input) => {
      seen.push([...input.changedPaths]);
      return { approved: [], sent: 0, failedBatches: 0, batches: 0 };
    };
    const outcome = await runUatBaselinePrecheck({
      store: {} as Store,
      ticketId: 1,
      pending: [entry],
      decisions: new Map(),
      ticket: { title: 't', description: '', brief: '' },
      baselineGlobs: ['tests/visual/__baselines__/**'],
      catalog: () => ({ claude: [], codex: [], antigravity: [], opencode: [], opencode2: [] }),
      git,
      precheck,
    });

    expect(seen[0]).toEqual(['app/views/account.tsx', 'app/views/home.tsx']);
    expect(seen[0]).not.toContain('tests/visual/__baselines__/dark/home.png');
    expect(outcome.approved).toEqual([]);
  });
});
