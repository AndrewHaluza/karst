import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { REFRESH_SCRIPT, hostBaseRef, refreshArgs } from './cloneRefresh.js';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' }).trim();

describe('conflict refresh with the base ref (real git)', () => {
  it('ships origin/<base> into the clone, a merge there fast-forwards back to the host', () => {
    const root = mkdtempSync(join(tmpdir(), 'karst-baseref-'));
    dirs.push(root);
    const origin = join(root, 'origin'), host = join(root, 'host'), clone = join(root, 'clone');
    execFileSync('git', ['init', '-q', '-b', 'develop', origin]);
    writeFileSync(join(origin, 'a.txt'), '1\n');
    git(origin, 'add', '.'); git(origin, 'commit', '-qm', 'base');
    execFileSync('git', ['clone', '-q', origin, host]);
    git(host, 'checkout', '-qb', 'feat/x');
    git(host, 'bundle', 'create', '-q', join(root, 'first.bundle'), 'feat/x');
    execFileSync('git', ['clone', '-q', '--branch', 'feat/x', join(root, 'first.bundle'), clone]);
    // develop moves on origin after the ticket branched
    writeFileSync(join(origin, 'b.txt'), '2\n');
    git(origin, 'add', '.'); git(origin, 'commit', '-qm', 'develop moved');

    // host side of the refresh: fetch origin/<base>, bundle branch + base
    git(host, 'fetch', 'origin', `+refs/heads/develop:${hostBaseRef('develop')}`);
    const bundle = join(root, 'in.bundle');
    git(host, 'bundle', 'create', '-q', bundle, 'feat/x', hostBaseRef('develop'));
    const run = (args: string[]) => execFileSync('sh', ['-c', REFRESH_SCRIPT, 'karst-refresh', ...args], { cwd: clone, encoding: 'utf8' });
    run(refreshArgs('feat/x', bundle, { baseRef: 'develop' }));

    expect(git(clone, 'rev-parse', 'refs/karst/base/develop')).toBe(git(origin, 'rev-parse', 'develop'));
    git(clone, 'merge', '--no-ff', '-m', 'merge develop', 'refs/karst/base/develop');
    git(clone, 'bundle', 'create', '-q', join(root, 'out.bundle'), 'feat/x');
    git(host, 'fetch', '-q', join(root, 'out.bundle'), 'refs/heads/feat/x');
    git(host, 'merge', '--ff-only', 'FETCH_HEAD');
    expect(git(host, 'log', '-1', '--format=%s')).toBe('merge develop');
  });
});
