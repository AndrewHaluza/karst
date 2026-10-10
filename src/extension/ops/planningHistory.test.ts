import { describe, it, expect, vi } from 'vitest';
import type { execFile } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { repo } from '../../manifest/fixtures.js';
import { execGit, gatherPlanningHistory } from './planningHistory.js';

function withArch(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'karst-ph-'));
  mkdirSync(join(root, 'docs', 'arch'), { recursive: true });
  for (const [name, body] of Object.entries(files)) writeFileSync(join(root, 'docs', 'arch', name), body);
  return root;
}

describe('gatherPlanningHistory', () => {
  it('reads base commits with a trailing -- and the @arch heading keys, sorted by file', async () => {
    const root = withArch({
      'prompt-metrics.md': '## [@arch:RESIDENT] R\nbody [@arch:NOPE]\n## [@arch:GUIDEGATE] G\nEND_DOC_BLOCK: [@arch:GUIDEGATE]\n',
      'a.md': '## [@arch:A-1] x\nsee ## [@arch:INLINE] y\n',
      'notes.txt': '## [@arch:SKIP] x\n',
    });
    const calls: string[][] = [];
    const runGit = async (args: string[]) => { calls.push(args); return `abc ${'y'.repeat(120)}\ndef fix: two\n\n`; };
    const manifest = { baselineBranch: 'main', repositories: { api: repo({ repoPath: root, baselineBranch: 'develop' }) } };
    const [h] = await gatherPlanningHistory(manifest, { runGit });
    expect(calls).toEqual([['-C', root, 'log', '--oneline', '-12', 'develop', '--']]);
    expect(h!.repo).toBe('api');
    expect(h!.base).toBe('develop');
    expect(h!.commits).toHaveLength(2);
    expect(h!.commits[0]).toHaveLength(90);
    expect(h!.commits[1]).toBe('def fix: two');
    expect(h!.archKeys).toEqual([
      { file: 'a.md', keys: ['A-1'] },
      { file: 'prompt-metrics.md', keys: ['RESIDENT', 'GUIDEGATE'] },
    ]);
  });

  it('gathers a shared repoPath once and skips disabled repos', async () => {
    let n = 0;
    const runGit = async () => { n += 1; return 'abc x\n'; };
    const manifest = {
      baselineBranch: 'main',
      repositories: {
        a: repo({ repoPath: '/mono' }),
        b: repo({ repoPath: '/mono' }),
        c: repo({ repoPath: '/off', enabled: false }),
      },
    };
    const out = await gatherPlanningHistory(manifest, { runGit });
    expect(n).toBe(1);
    expect(out.map((h) => h.repo)).toEqual(['a']);
  });

  it('omits commits on a git failure and keys without docs/arch, logging each', async () => {
    const debugs: string[] = [];
    const runGit = async () => { throw new Error('bad base'); };
    const manifest = { baselineBranch: 'main', repositories: { a: repo({ repoPath: '/nope/none' }) } };
    const [h] = await gatherPlanningHistory(manifest, { runGit, debug: (m) => void debugs.push(m) });
    expect(h).toEqual({ repo: 'a', base: 'main', commits: [], archKeys: [] });
    expect(debugs.some((m) => m.startsWith('[planning]') && m.includes('git log') && m.includes('bad base'))).toBe(true);
    expect(debugs.some((m) => m.includes('docs/arch'))).toBe(true);
  });
});

describe('execGit', () => {
  const fake = (err: Error | null) => {
    const fn = vi.fn((...a: unknown[]) => (a.at(-1) as (e: Error | null, o: string) => void)(err, 'out\n'));
    return fn as unknown as typeof execFile & typeof fn;
  };

  it('runs git asynchronously with a timeout and a bounded buffer, resolving stdout', async () => {
    const run = fake(null);
    await expect(execGit(['log'], run)).resolves.toBe('out\n');
    expect(run).toHaveBeenCalledWith('git', ['log'], { timeout: 5_000, maxBuffer: 256 * 1024 }, expect.any(Function));
  });

  it('rejects with the git error', async () => {
    await expect(execGit(['log'], fake(new Error('boom')))).rejects.toThrow('boom');
  });
});
