import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveBaseShasOf } from './planningConstraintChecks.js';

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

describe('resolveBaseShasOf with the default git runner', () => {
  it('resolves the baseline branch sha, not HEAD, and omits an unborn or missing branch', async () => {
    const root = mkdtempSync(join(tmpdir(), 'karst-bs-'));
    dirs.push(root);
    git(root, 'init', '-q', '-b', 'main');
    git(root, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'one');
    const mainSha = git(root, 'rev-parse', 'main');
    git(root, 'checkout', '-q', '-b', 'feature');
    git(root, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'two');
    const manifest = {
      baselineBranch: 'main',
      repositories: { app: { repoPath: root }, missing: { repoPath: root, baselineBranch: 'nope' } },
    } as unknown as Parameters<typeof resolveBaseShasOf>[0];
    expect(await resolveBaseShasOf(manifest, ['app', 'missing'])).toEqual({ app: mainSha });
  });
});
