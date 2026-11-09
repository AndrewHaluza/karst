import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

describe('rebuild-better-sqlite3 worktree guard', () => {
  let root;
  afterEach(() => root && rmSync(root, { recursive: true, force: true }));

  const fakeInstall = (modulesDir) => {
    const pkg = join(modulesDir, 'better-sqlite3');
    mkdirSync(pkg, { recursive: true });
    writeFileSync(join(pkg, 'package.json'), '{"name":"better-sqlite3","version":"0.0.0"}');
    writeFileSync(join(pkg, 'marker.txt'), 'main');
    return pkg;
  };

  const setup = () => {
    root = mkdtempSync(join(tmpdir(), 'karst-rebuild-'));
    const main = join(root, 'main');
    const wt = join(root, 'wt');
    const mainPkg = fakeInstall(join(main, 'node_modules'));
    mkdirSync(join(wt, 'scripts'), { recursive: true });
    for (const f of ['rebuild-better-sqlite3.mjs', 'nativeToolchain.mjs', 'onPath.mjs']) {
      copyFileSync(join(here, f), join(wt, 'scripts', f));
    }
    return { main, wt, mainPkg };
  };

  const run = (wt) =>
    spawnSync(process.execPath, [join(wt, 'scripts', 'rebuild-better-sqlite3.mjs'), 'node'], {
      cwd: wt,
      encoding: 'utf8',
    });

  it('refuses a symlinked node_modules and leaves the main install unchanged', () => {
    const { main, wt, mainPkg } = setup();
    symlinkSync(join(main, 'node_modules'), join(wt, 'node_modules'));
    const result = run(wt);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('is a symlink');
    expect(result.stderr).toContain('does not delete the shared install');
    expect(result.stderr).toContain('remove the symlink');
    expect(existsSync(join(mainPkg, 'marker.txt'))).toBe(true);
  });

  it('refuses a symlinked node_modules/better-sqlite3 inside a real folder', () => {
    const { wt, mainPkg } = setup();
    mkdirSync(join(wt, 'node_modules'), { recursive: true });
    symlinkSync(mainPkg, join(wt, 'node_modules', 'better-sqlite3'));
    const result = run(wt);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('is a symlink');
    expect(existsSync(join(mainPkg, 'marker.txt'))).toBe(true);
  });

  it('still copies better-sqlite3 into a real node_modules folder', () => {
    const { main, wt } = setup();
    // No node_modules in the worktree: copy it under main so the walk-up finds the main install.
    const under = join(main, 'wt');
    spawnSync('cp', ['-R', wt, under]);
    const result = run(under);
    expect(result.stdout).toContain('copied it locally');
    expect(existsSync(join(under, 'node_modules', 'better-sqlite3', 'marker.txt'))).toBe(true);
    expect(existsSync(join(main, 'node_modules', 'better-sqlite3', 'marker.txt'))).toBe(true);
  });
});
