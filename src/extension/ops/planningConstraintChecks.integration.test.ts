import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gitCatFileBatch, missingPathWarnings } from './planningConstraintChecks.js';

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

function repo(): string {
  const root = mkdtempSync(join(tmpdir(), 'karst-paths-'));
  dirs.push(root);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'ignore' });
  git('init', '-q', '-b', 'main');
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'a.ts'), 'export {};\n');
  writeFileSync(join(root, 'src', 'with space.ts'), 'export {};\n');
  git('add', '.');
  git('-c', 'user.name=t', '-c', 'user.email=t@e', 'commit', '-q', '-m', 'init');
  return root;
}

describe('gitCatFileBatch + missingPathWarnings against a real repository', () => {
  it('reports only the path missing at main, accepts .js for .ts, and handles spaces', async () => {
    const root = repo();
    const batch = vi.fn(gitCatFileBatch);
    const w = await missingPathWarnings(
      ['src/a.ts', 'src/a.js', 'src/with space.ts', 'src/gone.ts'],
      [{ repoPath: root, baseBranch: 'main' }],
      batch,
      vi.fn(),
    );
    expect(w).toEqual(['missing path at base: src/gone.ts']);
    expect(batch).toHaveBeenCalledTimes(1);
  });
  it('resolves paths from a repoPath that is a subdirectory of the git root', async () => {
    const root = repo();
    mkdirSync(join(root, 'pkg', 'src'), { recursive: true });
    writeFileSync(join(root, 'pkg', 'src', 'b.ts'), 'export {};\n');
    execFileSync('git', ['add', '.'], { cwd: root, stdio: 'ignore' });
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@e', 'commit', '-q', '-m', 'pkg'], { cwd: root, stdio: 'ignore' });
    const w = await missingPathWarnings(
      ['src/b.ts', 'src/a.ts'],
      [{ repoPath: join(root, 'pkg'), baseBranch: 'main' }],
      gitCatFileBatch,
      vi.fn(),
    );
    expect(w).toEqual(['missing path at base: src/a.ts']);
  });
  it('rejects with the git error for a directory that is not a repository', async () => {
    const plain = mkdtempSync(join(tmpdir(), 'karst-nogit-'));
    dirs.push(plain);
    await expect(gitCatFileBatch(plain, 'HEAD^{commit}\n')).rejects.toThrow();
  });
});
