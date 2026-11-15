import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runGit, runGitBytes } from '../../integrations/git.js';
import type { GitRunner } from '../../integrations/git.js';
import { gateFingerprint } from './gateFingerprint.js';

const git: GitRunner = (args, cwd) => runGit(args, cwd);

describe('gateFingerprint with a real repo', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function fixture(): string {
    const dir = mkdtempSync(join(tmpdir(), 'fp-'));
    dirs.push(dir);
    const g = (...a: string[]) => execFileSync('git', a, { cwd: dir, stdio: 'pipe' });
    g('init', '-q', '-b', 'develop');
    g('config', 'user.email', 't@t');
    g('config', 'user.name', 't');
    writeFileSync(join(dir, 'a.png'), Buffer.alloc(2048, 1));
    writeFileSync(join(dir, 'b.png'), Buffer.alloc(2048, 2));
    g('add', '-A');
    g('commit', '-q', '-m', 'base');
    g('checkout', '-q', '-b', 'feat');
    return dir;
  }

  const run = (dir: string, cap = 1024 * 1024) =>
    gateFingerprint(
      {
        git,
        gitBytes: (args, cwd) => runGitBytes(args, cwd, 30_000, cap),
      },
      [{ repo: 'r', cwd: dir, baseRef: 'develop' }],
    );

  it('hashes a diff whose binary size exceeds the old byte cap, and changes with one PNG', async () => {
    const dir = fixture();
    writeFileSync(join(dir, 'a.png'), Buffer.alloc(512 * 1024, 3));
    writeFileSync(join(dir, 'b.png'), Buffer.alloc(512 * 1024, 4));
    const first = await run(dir, 4096);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(await run(dir, 4096)).toBe(first);
    writeFileSync(join(dir, 'b.png'), Buffer.alloc(512 * 1024, 5));
    expect(await run(dir, 4096)).not.toBe(first);
  });

  it('changes when an unstaged PNG edit changes again', async () => {
    const dir = fixture();
    writeFileSync(join(dir, 'a.png'), Buffer.alloc(2048, 7));
    const one = await run(dir);
    writeFileSync(join(dir, 'a.png'), Buffer.alloc(2048, 8));
    expect(await run(dir)).not.toBe(one);
  });

  it('reports the reason when the raw diff is truncated', async () => {
    const dir = fixture();
    writeFileSync(join(dir, 'a.png'), Buffer.alloc(2048, 9));
    const messages: string[] = [];
    const out = await gateFingerprint(
      { git, gitBytes: (a, c) => runGitBytes(a, c, 30_000, 10), debug: (m) => messages.push(m) },
      [{ repo: 'r', cwd: dir, baseRef: 'develop' }],
    );
    expect(out).toBeNull();
    expect(messages[0]).toContain('gate fingerprint n/a');
  });
});
