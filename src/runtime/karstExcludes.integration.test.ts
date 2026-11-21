import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  KARST_EXCLUDE_RULES,
  ensureKarstExcluded,
  ensureKarstExcludedAsync,
} from './karstExcludes.js';

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
}

/** How many times `rule` appears as its own line in the exclude file. */
function ruleCount(contents: string, rule: string): number {
  return contents.split('\n').filter((line) => line.trim() === rule).length;
}

/**
 * The baseline checkout (`<repo>/.karst/baseline/<service>`) and its logs are
 * written into the USER's repository, not a ticket worktree, so the same
 * `.git/info/exclude` rules ticket worktrees get must be ensured there too.
 * Without them `git status` shows `?? .karst/` and a `git add -A` stages the
 * checkout.
 */
describe('the karst exclude rules as .git/info/exclude', () => {
  let repo: string;
  let excludePath: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'karst-excludes-'));
    git(repo, 'init', '-q', '-b', 'develop');
    git(repo, 'config', 'user.email', 't@k.local');
    git(repo, 'config', 'user.name', 't');
    excludePath = join(repo, '.git', 'info', 'exclude');
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it('async: hides the baseline checkout and its logs from git status', async () => {
    await ensureKarstExcludedAsync(repo);

    const exclude = readFileSync(excludePath, 'utf8');
    expect(exclude).toMatch(/^\/\.karst\/$/m);

    mkdirSync(join(repo, '.karst', 'baseline', 'backend'), { recursive: true });
    mkdirSync(join(repo, '.karst', 'logs'), { recursive: true });
    writeFileSync(join(repo, '.karst', 'logs', 'backend.baseline.log'), 'log\n');

    expect(git(repo, 'status', '--porcelain')).not.toMatch(/\.karst/);
  });

  it('async: is additive and idempotent — a second write adds no duplicate rule', async () => {
    writeFileSync(excludePath, '# the user\'s own rule\n/scratch/\n');

    await ensureKarstExcludedAsync(repo);
    await ensureKarstExcludedAsync(repo);

    const exclude = readFileSync(excludePath, 'utf8');
    expect(exclude).toContain("/scratch/");
    for (const rule of KARST_EXCLUDE_RULES) {
      expect(ruleCount(exclude, rule), `duplicate or missing rule ${rule}`).toBe(1);
    }
  });

  it('async: appends only the rules an older write is missing', async () => {
    writeFileSync(excludePath, '/.karst/\n');

    await ensureKarstExcludedAsync(repo);

    const exclude = readFileSync(excludePath, 'utf8');
    for (const rule of KARST_EXCLUDE_RULES) {
      expect(ruleCount(exclude, rule)).toBe(1);
    }
  });

  it('sync: is additive and idempotent, the same as the async variant', () => {
    ensureKarstExcluded(repo);
    ensureKarstExcluded(repo);

    const exclude = readFileSync(excludePath, 'utf8');
    for (const rule of KARST_EXCLUDE_RULES) {
      expect(ruleCount(exclude, rule)).toBe(1);
    }
  });
});
