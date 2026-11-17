import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Manifest } from '../../../manifest/types.js';
import { depsWarningText } from './depsAssess.js';
import { preflightWarning, preflightWorkspaceDeps, repoHasGates } from './depsPreflight.js';

const dirs: string[] = [];
function wt(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'preflight-'));
  dirs.push(dir);
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const gated = { uat: { gates: [{ id: 'g', command: 'true' }] } } as unknown as Manifest;

describe('repoHasGates', () => {
  it('is true for declared gates and false for a bare repository', () => {
    expect(repoHasGates(gated, 'web', wt({}))).toBe(true);
    expect(repoHasGates(undefined, 'web', wt({}))).toBe(false);
  });
  it('is true when package.json has a probe script', () => {
    expect(repoHasGates(undefined, 'web', wt({ 'package.json': '{"scripts":{"test":"x"}}' }))).toBe(true);
  });
});

describe('preflightWorkspaceDeps', () => {
  it('warns for a repository with gates and an ecosystem with no default', async () => {
    const dir = wt({ Makefile: 'all:' });
    const out = await preflightWorkspaceDeps({ manifest: gated, repos: [{ repoName: 'web', worktree: dir, gitCommonDir: null }] });
    expect(out[0]!.status).toBe('gap');
    expect(preflightWarning(out)).toBe('deps: web not provided');
  });
  it('says nothing for a repository without gates', async () => {
    const dir = wt({ Makefile: 'all:' });
    const out = await preflightWorkspaceDeps({ manifest: undefined, repos: [{ repoName: 'web', worktree: dir, gitCommonDir: null }] });
    expect(out[0]!.status).toBe('not-needed');
    expect(preflightWarning(out)).toBeUndefined();
  });
  it('says nothing for a cache ecosystem', async () => {
    const dir = wt({ 'go.mod': 'module x' });
    const out = await preflightWorkspaceDeps({ manifest: gated, repos: [{ repoName: 'api', worktree: dir, gitCommonDir: null }] });
    expect(out[0]!.status).toBe('provided');
  });
  it('names every gap repository once', () => {
    expect(
      depsWarningText([
        { repoName: 'a', status: 'gap', reason: 'x' },
        { repoName: 'b', status: 'provided', reason: 'y' },
        { repoName: 'c', status: 'gap', reason: 'z' },
      ]),
    ).toBe('deps: a, c not provided');
  });
  it('is a gap for a missing link target with no setup', async () => {
    const dir = wt({ 'requirements.txt': 'x' });
    mkdirSync(join(dir, 'src'));
    const manifest = {
      ...gated,
      repositories: { web: { graphWorkspace: { link: ['.venv'] } } },
    } as unknown as Manifest;
    const out = await preflightWorkspaceDeps({ manifest, repos: [{ repoName: 'web', worktree: dir, gitCommonDir: null }] });
    expect(out[0]!.status).toBe('gap');
    expect(out[0]!.reason).toContain('.venv');
  });
});
