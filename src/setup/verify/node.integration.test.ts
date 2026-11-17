import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { gitApplyCheck, nodeRecheck, nodeVerifyDeps, readManifestText } from './node.js';

const YAML =
  'id: demo\nhost: 127.0.0.1\nportRange: [3000, 3999]\nbaselineBranch: main\n' +
  'repositories:\n  web:\n    repoPath: web\n    hasMigrations: false\n';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'verify-node-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function initRepo(path: string): void {
  mkdirSync(path, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: path });
  writeFileSync(join(path, 'a.txt'), 'one\n');
}

const PATCH = '--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-one\n+two\n';

describe('node verify binding', () => {
  it('readManifestText reads the file and gives undefined for a missing file', () => {
    expect(readManifestText(join(dir, 'karst.yml'))).toBeUndefined();
    writeFileSync(join(dir, 'karst.yml'), YAML);
    expect(readManifestText(join(dir, 'karst.yml'))).toBe(YAML);
  });

  it('readManifestText rethrows a read error that is not ENOENT', () => {
    expect(() => readManifestText(dir)).toThrow();
  });

  it('gitApplyCheck passes a patch that applies and fails one that does not', async () => {
    initRepo(dir);
    expect(await gitApplyCheck(dir, PATCH)).toEqual({ ok: true });
    const bad = await gitApplyCheck(dir, PATCH.replace('-one', '-nine'));
    expect(bad.ok).toBe(false);
    expect(bad.error).toBeTruthy();
    expect(execFileSync('git', ['status', '--porcelain'], { cwd: dir }).toString()).not.toContain('M a.txt');
  });

  it('loadText loads a good manifest and reports an invalid one', () => {
    const deps = nodeVerifyDeps(join(dir, 'karst.yml'));
    const ok = deps.loadText(YAML);
    expect(ok.ok).toBe(true);
    const bad = deps.loadText('id: [');
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toMatch(/YAML|manifest/i);
  });

  it('loadText resolves a relative repoPath against the manifest directory', () => {
    mkdirSync(join(dir, 'web'));
    const ok = nodeVerifyDeps(join(dir, 'karst.yml')).loadText(YAML);
    expect(ok.ok && ok.codedWarnings.some((w) => w.code.includes('repo'))).toBe(false);
  });

  it('readCurrentText follows the real file', () => {
    const deps = nodeVerifyDeps(join(dir, 'karst.yml'));
    expect(deps.readCurrentText()).toBeUndefined();
    writeFileSync(join(dir, 'karst.yml'), YAML);
    expect(deps.readCurrentText()).toBe(YAML);
  });

  it('recheck returns only the named items, slow ones included', async () => {
    initRepo(join(dir, 'web'));
    writeFileSync(join(dir, 'karst.yml'), YAML);
    const items = await nodeRecheck(join(dir, 'karst.yml'))(['manifest.load']);
    expect(items.map((i) => i.id)).toEqual(['manifest.load']);
    expect(items[0]!.status).toBe('ok');
  });

  it('recheck gives a failing manifest.load for a missing or broken file', async () => {
    const path = join(dir, 'karst.yml');
    expect((await nodeRecheck(path)(['manifest.load']))[0]!.status).toBe('fail');
    writeFileSync(path, 'id: [');
    expect((await nodeRecheck(path)(['manifest.load']))[0]!.status).toBe('fail');
  });
});
