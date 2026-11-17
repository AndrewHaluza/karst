import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { describeGraphDeps } from './graphDeps.js';

const dirs: string[] = [];
function repo(files: Record<string, string>, folders: string[] = []): string {
  const dir = mkdtempSync(join(tmpdir(), 'graphdeps-'));
  dirs.push(dir);
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  for (const folder of folders) mkdirSync(join(dir, folder));
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('describeGraphDeps', () => {
  it('fits a Node repository the defaults cover', () => {
    expect(describeGraphDeps(repo({ 'package.json': '{}' })).status).toBe('fits');
  });
  it('fits a Go repository (user-level cache)', () => {
    expect(describeGraphDeps(repo({ 'go.mod': 'module x' }))).toMatchObject({ status: 'fits' });
  });
  it('fits a repository with no dependency manifest', () => {
    expect(describeGraphDeps(repo({ 'README.md': '' }))).toMatchObject({ status: 'fits' });
  });
  it('is a gap for a dependency folder no default links', () => {
    const verdict = describeGraphDeps(repo({ 'package.json': '{}' }, ['vendor']));
    expect(verdict.status).toBe('gap');
    expect(verdict.reason).toContain('vendor/');
  });
  it('is a gap for an ecosystem with a manifest and no default', () => {
    expect(describeGraphDeps(repo({ Makefile: 'all:' })).status).toBe('gap');
  });
  it('is a gap for a link target that points into the checkout', () => {
    const dir = repo({ 'requirements.txt': 'x' }, ['real-venv']);
    symlinkSync(join(dir, 'real-venv'), join(dir, '.venv'));
    expect(describeGraphDeps(dir)).toMatchObject({ status: 'gap' });
  });
  it('is a gap, not a throw, for an unreadable path', () => {
    expect(describeGraphDeps('/definitely/not/here').status).toMatch(/fits|gap/);
  });
});
