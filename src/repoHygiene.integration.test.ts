import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

// 40b6ac6 accidentally committed `node_modules` as a symlink pointing at its
// own path (`/Users/nd/Work/projects/karst/node_modules`). The repo's gitignore
// carried `node_modules/`, and a trailing-slash pattern matches only REAL
// directories — git treats a symlink as a file for ignore matching — so a plain
// `git add -A` swept the link into the commit. Every checkout of develop then
// carried a self-referential `node_modules`, and any npm spawn from it died
// with `ELOOP: too many symbolic links encountered` — `./scripts/
// install-local.sh cursor` failed right after printing the `npm run build`
// banner (npm could not even spawn its script shell).
//
// The ignore patterns therefore carry NO trailing slash (they then match a
// real directory AND a symlink of that name), and the tests below pin both the
// patterns and the tracked-symlink inventory so the same accident fails a
// suite instead of shipping.
const repoRoot = join(import.meta.dirname, '..');

describe('repo hygiene: dependency dirs are ignored even as symlinks', () => {
  const gitignore = readFileSync(join(repoRoot, '.gitignore'), 'utf8');

  it.each(['node_modules', 'dist', 'coverage'])('%s ignore pattern must not end in "/"', (dir) => {
    const line = gitignore.split('\n').find((l) => l.trim() === dir || l.trim() === `${dir}/`);
    expect(line, `.gitignore has no ignore line for ${dir}`).toBeDefined();
    expect(
      line!.trim().endsWith('/'),
      `${dir}/ matches only a real directory, never a symlink of that name`,
    ).toBe(false);
  });

  it('the only tracked symlink is AGENTS.md -> CLAUDE.md', () => {
    const r = spawnSync('git', ['ls-files', '-s'], { cwd: repoRoot, encoding: 'utf8' });
    expect(r.status).toBe(0);
    const trackedSymlinks = r.stdout
      .split('\n')
      .filter((line) => line.startsWith('120000'))
      .map((line) => line.split('\t')[1] ?? '')
      .sort();
    expect(trackedSymlinks).toEqual(['AGENTS.md']);
  });
});
