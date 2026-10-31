import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { manifest, repo } from '../../manifest/fixtures.js';
import { regenerateOption } from './regenerateOption.js';
import { runGateList } from './runList.js';
import type { ResolvedGate } from './resolve.js';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' });

function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'karst-regen-'));
  dirs.push(dir);
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 't@t');
  git(dir, 'config', 'user.name', 't');
  mkdirSync(join(dir, 'docs'));
  writeFileSync(join(dir, 'docs/map.md'), 'old\n');
  writeFileSync(join(dir, 'agent.txt'), 'a\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'init');
  writeFileSync(join(dir, 'agent.txt'), 'agent work\n'); // uncommitted agent work stays out of the commit
  return dir;
}

// docs-graph-like read-only gate: fails while the generated file is stale.
const docsGraph = {
  name: 'docs-graph', command: 'sh', args: ['-c', 'grep -q fresh docs/map.md || { echo "docs/map.md is stale"; exit 1; }'],
  script: null, required: true,
} as unknown as ResolvedGate;

describe('ship.regenerate against a real worktree (T880)', () => {
  it('a manifest keyed "extention" with repoPath target regenerates, commits only generated paths, then the gate passes', async () => {
    const cwd = fixture();
    const m = manifest({ extention: repo({ repoPath: cwd, ship: { regenerate: ["echo fresh > docs/map.md"] } }) });
    const rows: Array<[string, number | null, number]> = [];
    const run = await runGateList([docsGraph], cwd, {
      // the stage passes target.repo = the repo PATH and target.names = manifest keys
      ...regenerateOption(m, { repo: cwd, names: ['extention'] }),
      onGateComplete: (name, code, _s, _e, index) => rows.push([name, code, index]),
    });
    expect(run.kind).toBe('ran');
    expect(run.kind === 'ran' && run.results.map((r) => [r.name, r.exitCode])).toEqual([['docs-graph', 0]]);
    expect(git(cwd, 'log', '-1', '--format=%s')).toBe('chore: regenerate generated files\n');
    expect(git(cwd, 'show', '--name-only', '--format=', 'HEAD').trim()).toBe('docs/map.md');
    expect(readFileSync(join(cwd, 'agent.txt'), 'utf8')).toBe('agent work\n');
    expect(git(cwd, 'status', '--porcelain').trim()).toBe('M agent.txt');
    expect(rows).toContainEqual(['regenerate (extention)', 0, -1]);
  });

  it('records an ok evidence row naming the command and "nothing to commit"', async () => {
    const cwd = fixture();
    const outputs: string[] = [];
    await runGateList([], cwd, {
      regenerate: { repo: 'extention', commands: ['true'] },
      onGateComplete: (_n, _c, _s, _e, _i, output) => outputs.push(output ?? ''),
    });
    expect(outputs[0]).toContain('$ true → exit 0');
    expect(outputs[0]).toContain('nothing to commit');
  });

  it('records the committed paths and a failing generator row', async () => {
    const cwd = fixture();
    const rows: Array<[number | null, string]> = [];
    await runGateList([], cwd, {
      regenerate: { repo: 'extention', commands: ['echo n > docs/map.md'] },
      onGateComplete: (_n, c, _s, _e, _i, o) => rows.push([c, o ?? '']),
    });
    expect(rows[0]![1]).toContain('committed 1 path(s): docs/map.md');
    await runGateList([], cwd, {
      regenerate: { repo: 'extention', commands: ['exit 3'] },
      onGateComplete: (_n, c, _s, _e, _i, o) => rows.push([c, o ?? '']),
    });
    expect(rows[1]![0]).toBe(3);
    expect(rows[1]![1]).toContain('$ exit 3 → exit 3');
  });
});
