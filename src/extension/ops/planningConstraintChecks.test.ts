import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  archDocFiles,
  archWarnings,
  repoPathsOf,
  resolveBaseShasOf,
  commitExistsViaGit,
  commitWarnings,
  sensitivePathWarning,
  missingPathWarnings,
  missingPathsViaGitBatch,
  pathVariants,
  repoTargetsOf,
  MAX_CHECKED_PATHS,
  overlapWarnings,
  type GitBatch,
} from './planningConstraintChecks.js';
import type { Manifest } from '../../manifest/types.js';

const dirs: string[] = [];
function repoWithDocs(doc: string | undefined): string {
  const root = mkdtempSync(join(tmpdir(), 'karst-cc-'));
  dirs.push(root);
  if (doc !== undefined) {
    mkdirSync(join(root, 'docs', 'arch'), { recursive: true });
    writeFileSync(join(root, 'docs', 'arch', 'prompt-metrics.md'), doc);
  }
  return root;
}
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

describe('archWarnings', () => {
  const doc = '## [@arch:RESIDENT] Resident\nbody\nEND_DOC_BLOCK: [@arch:RESIDENT]\n';
  it('is silent for a known key and warns for an unknown one', () => {
    const repo = repoWithDocs(doc);
    const debug = vi.fn();
    expect(archWarnings(['@arch:RESIDENT', '@arch:NOPE', '#1', 'abc1234'], [repo], debug)).toEqual([
      'unknown design key @arch:NOPE',
    ]);
  });
  it('a key found in any of the repos counts', () => {
    expect(archWarnings(['@arch:RESIDENT'], [repoWithDocs(undefined), repoWithDocs(doc)], vi.fn())).toEqual([]);
  });
  it('skips with a debug line when no repo has readable docs', () => {
    const debug = vi.fn();
    expect(archWarnings(['@arch:RESIDENT'], [repoWithDocs(undefined)], debug)).toEqual([]);
    expect(debug).toHaveBeenCalledWith(expect.stringContaining('docs/arch'));
  });
  it('does nothing without arch constraints or repos', () => {
    expect(archWarnings(['#1'], [repoWithDocs(doc)], vi.fn())).toEqual([]);
    expect(archWarnings(['@arch:X'], [], vi.fn())).toEqual([]);
  });
});

describe('sensitivePathWarning', () => {
  const msg = 'touches prompt-sensitive code without citing a design rule';
  it('warns when a sensitive path is mentioned and no @arch is cited', () => {
    expect(sensitivePathWarning({ description: 'edit src/agent/seed.ts', summary: '', constraints: ['#1'] })).toEqual([msg]);
    expect(sensitivePathWarning({ description: '', summary: 'see src/planning/preamble.ts' })).toEqual([msg]);
  });
  it('is silent with an @arch entry or without a sensitive path', () => {
    expect(sensitivePathWarning({ description: 'src/agent/seed.ts', summary: '', constraints: ['@arch:RESIDENT'] })).toEqual([]);
    expect(sensitivePathWarning({ description: 'src/other.ts', summary: '' })).toEqual([]);
  });
});

describe('commitWarnings', () => {
  it('warns for a hash missing in every repo, not for one found in any', async () => {
    const exists = vi.fn(async (repo: string, hash: string) => repo === 'b' && hash === 'abc1234');
    expect(await commitWarnings(['abc1234', 'dead567', '@arch:X', '#4'], ['a', 'b'], exists, vi.fn())).toEqual([
      'unknown commit dead567',
    ]);
  });
  it('skips a hash whose check failed everywhere, logging it', async () => {
    const debug = vi.fn();
    const exists = vi.fn(async () => {
      throw new Error('git missing');
    });
    expect(await commitWarnings(['abc1234'], ['a'], exists, debug)).toEqual([]);
    expect(debug).toHaveBeenCalledWith(expect.stringContaining('abc1234'));
  });
  it('does nothing without hashes or repos', async () => {
    const exists = vi.fn();
    expect(await commitWarnings(['#1'], ['a'], exists, vi.fn())).toEqual([]);
    expect(await commitWarnings(['abc1234'], [], exists, vi.fn())).toEqual([]);
    expect(exists).not.toHaveBeenCalled();
  });
});

describe('commitExistsViaGit', () => {
  it('runs cat-file on the commit and maps exit status to a boolean', async () => {
    const ok = vi.fn(async () => '');
    expect(await commitExistsViaGit('/r', 'abc1234', ok)).toBe(true);
    expect(ok).toHaveBeenCalledWith(['-C', '/r', 'cat-file', '-e', 'abc1234^{commit}']);
    const missing = vi.fn(async () => {
      throw Object.assign(new Error('x'), { code: 128 });
    });
    expect(await commitExistsViaGit('/r', 'abc1234', missing)).toBe(false);
  });
  it('rethrows a spawn failure so the check is skipped', async () => {
    const boom = vi.fn(async () => {
      throw Object.assign(new Error('x'), { code: 'ENOENT' });
    });
    await expect(commitExistsViaGit('/r', 'abc1234', boom)).rejects.toThrow();
  });
});

describe('archDocFiles', () => {
  const doc = '## [@arch:RESIDENT] Resident\nEND_DOC_BLOCK: [@arch:RESIDENT]\n';
  it('maps each cited @arch key to the doc file defining it', () => {
    const repo = repoWithDocs(doc);
    writeFileSync(join(repo, 'docs', 'arch', 'notes.txt'), '[@arch:TXTONLY]');
    expect(archDocFiles(['@arch:RESIDENT', '@arch:TXTONLY', '@arch:NOPE', '#1', 'abc1234', 'x@arch:RESIDENT'], [repo])).toEqual({
      '@arch:RESIDENT': 'prompt-metrics.md',
    });
  });
  it('searches later repos and tolerates unreadable ones', () => {
    expect(archDocFiles(['@arch:RESIDENT'], [repoWithDocs(undefined), repoWithDocs(doc)])).toEqual({
      '@arch:RESIDENT': 'prompt-metrics.md',
    });
    expect(archDocFiles(['@arch:RESIDENT'], [repoWithDocs(undefined)])).toEqual({});
  });
});

describe('repoPathsOf', () => {
  const m = { repositories: { a: { repoPath: '/x' }, b: { repoPath: '/x' }, c: { repoPath: '/y' } } };
  it('returns the distinct paths of the named repos, skipping unknown names', () => {
    expect(repoPathsOf(m, ['a', 'b', 'c', 'zz'])).toEqual(['/x', '/y']);
    expect(repoPathsOf(undefined, ['a'])).toEqual([]);
  });
});

describe('check anchoring', () => {
  it('treats only whole-string keys and hashes as such', async () => {
    const repo = repoWithDocs('## [@arch:A] t\n');
    expect(archWarnings(['see @arch:B', '@arch:B tail'], [repo], vi.fn())).toEqual(['malformed design key @arch:B tail']);
    const exists = vi.fn(async () => false);
    expect(await commitWarnings(['abc1234 and more', 'xabc1234', 'abc123', 'a'.repeat(41)], ['r'], exists, vi.fn())).toEqual([]);
    expect(await commitWarnings(['a'.repeat(40), 'a'.repeat(7)], ['r'], exists, vi.fn())).toHaveLength(2);
  });
  it('reads only .md files for keys', () => {
    const repo = repoWithDocs('## [@arch:A] t\n');
    writeFileSync(join(repo, 'docs', 'arch', 'x.txt'), '[@arch:ONLYTXT]');
    expect(archWarnings(['@arch:ONLYTXT', '@arch:A'], [repo], vi.fn())).toEqual(['unknown design key @arch:ONLYTXT']);
  });
  it('logs the repo and error when a commit probe fails', async () => {
    const debug = vi.fn();
    await commitWarnings(['abc1234'], ['/the/repo'], async () => { throw new Error('boom'); }, debug);
    expect(debug).toHaveBeenCalledWith(expect.stringContaining('/the/repo'));
    expect(debug).toHaveBeenCalledWith(expect.stringContaining('boom'));
    expect(debug).toHaveBeenCalledWith(expect.stringMatching(/^\[planning\]/));
  });
  it('sensitive check requires exactly a leading @arch: for a citation', () => {
    const c = (constraints: string[]) => sensitivePathWarning({ description: 'src/agent/seed.ts', summary: '', constraints });
    expect(c(['x@arch:K'])).toHaveLength(1);
    expect(c(['arch:K'])).toHaveLength(1);
    expect(c(['@arch:K'])).toHaveLength(0);
  });
  it('a malformed @arch entry does not count as a citation', () => {
    const c = (constraints: string[]) => sensitivePathWarning({ description: 'src/agent/seed.ts', summary: '', constraints });
    expect(c(['@arch:x'])).toHaveLength(1);
    expect(c(['@arch:'])).toHaveLength(1);
    expect(c(['@arch:A b'])).toHaveLength(1);
  });
  it('archWarnings flags a malformed @arch entry, even with no repos', () => {
    expect(archWarnings(['@arch:x', '@arch:'], [], vi.fn())).toEqual(['malformed design key @arch:x', 'malformed design key @arch:']);
    expect(archWarnings(['@arch:x'], [repoWithDocs('## [@arch:A] t\n')], vi.fn())).toEqual(['malformed design key @arch:x']);
  });
  it('checks every sensitive path', () => {
    for (const path of ['src/agent/seed.ts', 'src/agent/entrySeed.ts', 'src/agent/instructions.ts', 'src/context/ticketContext.ts', 'src/planning/preamble.ts']) {
      expect(sensitivePathWarning({ description: '', summary: `edit ${path}` })).toHaveLength(1);
    }
  });
});

describe('resolveBaseShasOf', () => {
  const SHA = 'a'.repeat(40);
  const manifest = {
    baselineBranch: 'main',
    repositories: {
      web: { repoPath: '/r/mono', baselineBranch: 'develop' },
      api: { repoPath: '/r/mono', baselineBranch: 'develop' },
      other: { repoPath: '/r/other' },
    },
  } as unknown as Parameters<typeof resolveBaseShasOf>[0];

  it('returns nothing without a manifest', async () => {
    expect(await resolveBaseShasOf(undefined, ['web'], async () => SHA)).toEqual({});
  });

  it('prefers origin/<baseline branch> and keys by manifest name for repos sharing a repoPath', async () => {
    const calls: Array<[string, string[]]> = [];
    const out = await resolveBaseShasOf(manifest, ['web', 'api'], async (cwd, args) => {
      calls.push([cwd, args]);
      return `${SHA}\n`;
    });
    expect(out).toEqual({ web: SHA, api: SHA });
    expect(calls).toEqual([
      ['/r/mono', ['rev-parse', '--verify', 'origin/develop^{commit}']],
      ['/r/mono', ['rev-parse', '--verify', 'origin/develop^{commit}']],
    ]);
  });

  it('falls back to the local branch when origin/<branch> is missing, using the manifest default', async () => {
    const refs: string[] = [];
    const out = await resolveBaseShasOf(manifest, ['other'], async (_cwd, args) => {
      refs.push(args[2]!);
      if (args[2]!.startsWith('origin/')) throw new Error('no such ref');
      return SHA;
    });
    expect(out).toEqual({ other: SHA });
    expect(refs).toEqual(['origin/main^{commit}', 'main^{commit}']);
  });

  it('omits unknown names, unresolvable bases and too-short output without throwing', async () => {
    expect(await resolveBaseShasOf(manifest, ['ghost'], async () => SHA)).toEqual({});
    expect(
      await resolveBaseShasOf(manifest, ['web'], async () => {
        throw new Error('git failed');
      }),
    ).toEqual({});
    expect(await resolveBaseShasOf(manifest, ['web'], async () => 'abc123')).toEqual({});
    expect(await resolveBaseShasOf(manifest, ['web'], async () => '')).toEqual({});
  });

  it('accepts exactly 7 characters', async () => {
    expect(await resolveBaseShasOf(manifest, ['web'], async () => 'abcdef1')).toEqual({ web: 'abcdef1' });
  });
});

function repoWithUiDocs(doc: string): string {
  const root = repoWithDocs(undefined);
  mkdirSync(join(root, 'docs', 'ui'), { recursive: true });
  writeFileSync(join(root, 'docs', 'ui', 'UI-INVARIANTS.md'), doc);
  return root;
}

describe('@ui design keys', () => {
  const uiDoc = '## [@ui:TITLE-KEY] T\n## [@ui:1.1] N\n## [@ui:UI-R09b] R\n';
  it('verifies @ui keys against docs/ui, including dotted and lowercase-suffix keys', () => {
    const repo = repoWithUiDocs(uiDoc);
    expect(archWarnings(['@ui:TITLE-KEY', '@ui:1.1', '@ui:UI-R09b', '@ui:NOPE'], [repo], vi.fn())).toEqual([
      'unknown design key @ui:NOPE',
    ]);
  });
  it('does not accept an @ui key from docs/arch or an @arch key from docs/ui', () => {
    const repo = repoWithUiDocs('## [@ui:ONLYUI] x\n');
    mkdirSync(join(repo, 'docs', 'arch'), { recursive: true });
    writeFileSync(join(repo, 'docs', 'arch', 'a.md'), '## [@arch:ONLYARCH] x\n');
    expect(archWarnings(['@ui:ONLYARCH', '@arch:ONLYUI'], [repo], vi.fn())).toEqual([
      'unknown design key @ui:ONLYARCH',
      'unknown design key @arch:ONLYUI',
    ]);
  });
  it('flags a malformed @ui key and keeps @arch strict', () => {
    expect(archWarnings(['@ui:', '@ui:a b', '@arch:1.1', '@arch:x'], [], vi.fn())).toEqual([
      'malformed design key @ui:',
      'malformed design key @ui:a b',
      'malformed design key @arch:1.1',
      'malformed design key @arch:x',
    ]);
  });
  it('skips @ui keys with a debug line when no repo has docs/ui, and still checks @arch keys', () => {
    const debug = vi.fn();
    const repo = repoWithDocs('## [@arch:A] t\n');
    expect(archWarnings(['@ui:X', '@arch:A', '@arch:B'], [repo], debug)).toEqual(['unknown design key @arch:B']);
    expect(debug).toHaveBeenCalledWith(expect.stringMatching(/^\[planning\] .*docs\/ui.*@ui keys not verified/));
  });
  it('archDocFiles names the docs/ui file of an @ui key', () => {
    const repo = repoWithUiDocs(uiDoc);
    expect(archDocFiles(['@ui:1.1', '@ui:NOPE', 'free text'], [repo])).toEqual({ '@ui:1.1': 'UI-INVARIANTS.md' });
  });
  it('an @ui citation does not count for the prompt-sensitive check', () => {
    expect(sensitivePathWarning({ description: 'src/agent/seed.ts', summary: '', constraints: ['@ui:TITLE-KEY'] })).toHaveLength(1);
  });
  it('clips every design-key warning to 60 chars', () => {
    const long = `@arch:${'A'.repeat(190)}`;
    const bad = `@arch:${'a'.repeat(190)}`;
    const w = archWarnings([long, bad], [repoWithDocs('## [@arch:Z] t\n')], vi.fn());
    expect(w).toHaveLength(2);
    for (const x of w) expect(x.length).toBeLessThanOrEqual(60);
    expect(w[0]).toMatch(/^malformed design key …a+$/);
    expect(w[1]).toMatch(/^unknown design key …A+$/);
  });
});

const SHA = 'a'.repeat(40);
/** A fake `cat-file --batch-check`: `known` lines resolve, every other line is missing. */
function fakeBatch(known: (line: string) => boolean): GitBatch & { calls: { repoPath: string; lines: string[] }[] } {
  const calls: { repoPath: string; lines: string[] }[] = [];
  const fn = async (repoPath: string, input: string): Promise<string> => {
    const lines = input.split('\n').filter((l) => l !== '');
    calls.push({ repoPath, lines });
    return lines.map((l) => (known(l) ? `${SHA} blob 12` : `${l} missing`)).join('\n') + '\n';
  };
  return Object.assign(fn, { calls });
}

describe('repoTargetsOf', () => {
  it('dedupes by repoPath and resolves the base branch of the first name', () => {
    const manifest = {
      baselineBranch: 'develop',
      repositories: { a: { repoPath: '/x' }, b: { repoPath: '/x', baselineBranch: 'other' }, c: { repoPath: '/y', baselineBranch: 'main' } },
    } as unknown as Manifest;
    expect(repoTargetsOf(manifest, ['a', 'b', 'c', 'zz'])).toEqual([
      { repoPath: '/x', baseBranch: 'develop' },
      { repoPath: '/y', baseBranch: 'main' },
    ]);
    expect(repoTargetsOf(undefined, ['a'])).toEqual([]);
  });
});

describe('pathVariants', () => {
  it('adds .ts and .tsx for a .js specifier only', () => {
    expect(pathVariants('src/a.js')).toEqual(['src/a.js', 'src/a.ts', 'src/a.tsx']);
    expect(pathVariants('src/a.ts')).toEqual(['src/a.ts']);
    expect(pathVariants('src/a.json')).toEqual(['src/a.json']);
  });
});

describe('missingPathsViaGitBatch', () => {
  const target = { repoPath: '/r', baseBranch: 'develop' };
  it('sends every ref and every path in ONE batch and uses origin/<base> first', async () => {
    const batch = fakeBatch((l) => l === 'origin/develop^{commit}' || l === 'develop^{commit}' || l === 'origin/develop:src/a.ts' || l === 'develop:src/b.ts');
    expect(await missingPathsViaGitBatch(target, ['src/a.ts', 'src/b.ts'], batch)).toEqual(['src/b.ts']);
    expect(batch.calls).toHaveLength(1);
    expect(batch.calls[0]!.lines.slice(0, 3)).toEqual(['origin/develop^{commit}', 'develop^{commit}', 'HEAD^{commit}']);
  });
  it('falls back to the local branch, then HEAD', async () => {
    const local = fakeBatch((l) => l === 'develop^{commit}' || l === 'develop:src/a.ts');
    expect(await missingPathsViaGitBatch(target, ['src/a.ts', 'src/b.ts'], local)).toEqual(['src/b.ts']);
    const head = fakeBatch((l) => l === 'HEAD^{commit}' || l === 'HEAD:src/b.ts');
    expect(await missingPathsViaGitBatch(target, ['src/a.ts', 'src/b.ts'], head)).toEqual(['src/a.ts']);
  });
  it('is undefined when no ref resolves', async () => {
    expect(await missingPathsViaGitBatch(target, ['src/a.ts'], fakeBatch(() => false))).toBeUndefined();
  });
  it('a .js path counts as present when its .ts or .tsx source exists', async () => {
    const batch = fakeBatch((l) => l === 'origin/develop^{commit}' || l === 'origin/develop:src/a.ts' || l === 'origin/develop:src/b.tsx');
    expect(await missingPathsViaGitBatch(target, ['src/a.js', 'src/b.js', 'src/c.js'], batch)).toEqual(['src/c.js']);
  });
  it('reads a line as present only when it is "<sha> <type> <size>"', async () => {
    const batch: GitBatch = async () => `${SHA} commit 200\n${SHA} commit 200\n${SHA} commit 200\nsrc/a.ts ambiguous\n\n`;
    expect(await missingPathsViaGitBatch(target, ['src/a.ts'], batch)).toEqual(['src/a.ts']);
  });
});

describe('missingPathWarnings', () => {
  const t1 = { repoPath: '/r1', baseBranch: 'main' };
  const t2 = { repoPath: '/r2', baseBranch: 'main' };
  const resolves = (l: string) => l.endsWith('^{commit}');
  it('runs one batch per target and warns on a path missing in every target', async () => {
    const batch = fakeBatch((l) => resolves(l) || l === 'origin/main:src/a.ts');
    const w = await missingPathWarnings(['src/a.ts', 'src/b.ts'], [t1, t2], batch, vi.fn());
    expect(w).toEqual(['missing path at base: src/b.ts']);
    expect(batch.calls.map((c) => c.repoPath)).toEqual(['/r1', '/r2']);
  });
  it('caps the output at 3 paths and one "+N more" line', async () => {
    const paths = ['src/1.ts', 'src/2.ts', 'src/3.ts', 'src/4.ts', 'src/5.ts'];
    expect(await missingPathWarnings(paths, [t1], fakeBatch(resolves), vi.fn())).toEqual([
      'missing path at base: src/1.ts',
      'missing path at base: src/2.ts',
      'missing path at base: src/3.ts',
      '+2 more missing paths at base',
    ]);
    expect(await missingPathWarnings(paths.slice(0, 3), [t1], fakeBatch(resolves), vi.fn())).toHaveLength(3);
  });
  it('checks at most 50 distinct paths and drops paths with a line break', async () => {
    const batch = fakeBatch(resolves);
    const paths = Array.from({ length: 60 }, (_, i) => `src/f${i}.ts`);
    await missingPathWarnings([...paths, 'src/f0.ts', 'src/x\n.ts', 'src/y\r.ts'], [t1], batch, vi.fn());
    const pathLines = batch.calls[0]!.lines.filter((l) => l.startsWith('HEAD:'));
    expect(pathLines).toHaveLength(MAX_CHECKED_PATHS);
    expect(pathLines.some((l) => /[\r\n]/.test(l))).toBe(false);
  });
  it('is silent with no paths or no targets, and spawns nothing', async () => {
    const batch = fakeBatch(resolves);
    expect(await missingPathWarnings([], [t1], batch, vi.fn())).toEqual([]);
    expect(await missingPathWarnings(['src/a.ts'], [], batch, vi.fn())).toEqual([]);
    expect(batch.calls).toHaveLength(0);
  });
  it('skips a target whose git fails or whose base does not resolve, with a [planning] debug line', async () => {
    const debug = vi.fn();
    const batch: GitBatch = async (repoPath, input) => {
      if (repoPath === '/r1') throw new Error('spawn git ENOENT');
      return fakeBatch(() => false)(repoPath, input);
    };
    expect(await missingPathWarnings(['src/a.ts'], [t1, t2], batch, debug)).toEqual([]);
    expect(debug).toHaveBeenCalledWith(expect.stringMatching(/^\[planning\] .*\/r1.*spawn git ENOENT/));
    expect(debug).toHaveBeenCalledWith(expect.stringMatching(/^\[planning\] .*\/r2.*no base ref/));
  });
  it('a path present in one checked target and missing in another is not reported', async () => {
    const batch: GitBatch = async (repoPath, input) => fakeBatch((l) => resolves(l) || (repoPath === '/r2' && l === 'origin/main:src/a.ts'))(repoPath, input);
    expect(await missingPathWarnings(['src/a.ts'], [t1, t2], batch, vi.fn())).toEqual([]);
  });
  it('clips a long path to keep the warning at 60 chars', async () => {
    const long = `src/${'deep/'.repeat(20)}file.ts`;
    const [w] = await missingPathWarnings([long], [t1], fakeBatch(resolves), vi.fn());
    expect(w!.length).toBeLessThanOrEqual(60);
    expect(w).toMatch(/^missing path at base: ….*file\.ts$/);
  });
});

describe('overlapWarnings', () => {
  const incoming = { title: 'Retry token refresh in session store', description: 'Edit src/auth/session.ts and src/auth/token.ts.' };
  const c = (ref: string, title: string, description = '') => ({ ref, title, description });
  it('warns on 2 or more shared source files, not on 1', () => {
    expect(overlapWarnings(incoming, [c('D4', 'x', 'src/auth/session.ts src/auth/token.ts')])).toEqual(['overlaps files with D4 (add dependsOn?)']);
    expect(overlapWarnings(incoming, [c('T9', 'x', 'src/auth/session.ts only')])).toEqual([]);
  });
  it('created paths count as shared files too', () => {
    expect(overlapWarnings({ title: 'a', description: '[NEW] src/n.ts\n[NEW] src/m.ts' }, [c('D1', 'b', 'src/n.ts src/m.ts')])).toHaveLength(1);
  });
  it('does not count docs/** or *.md files', () => {
    const docs = { title: 'a', description: 'docs/arch/cli.md docs/x.ts src/README.md src/a.ts' };
    expect(overlapWarnings(docs, [c('D1', 'b', 'docs/arch/cli.md docs/x.ts src/README.md src/a.ts')])).toEqual([]);
  });
  it('warns on a title Jaccard of 0.65 or more, with 3+ meaningful tokens on both sides', () => {
    const tokens = Array.from({ length: 17 }, (_, i) => `tok${i}`);
    const a = { title: [...tokens.slice(0, 13), 'aaa1', 'aaa2', 'aaa3'].join(' '), description: '' };
    // 13 shared, 3 own + 4 own: 13/20 = 0.65
    expect(overlapWarnings(a, [c('T2', [...tokens.slice(0, 13), 'bbb1', 'bbb2', 'bbb3', 'bbb4'].join(' '))])).toEqual(['title closely matches T2']);
    // 13 shared, 3 own + 5 own: 13/21 < 0.65
    expect(overlapWarnings(a, [c('T2', [...tokens.slice(0, 13), 'bbb1', 'bbb2', 'bbb3', 'bbb4', 'bbb5'].join(' '))])).toEqual([]);
  });
  it('needs 3 tokens of length 3+ that are not stopwords on both sides', () => {
    expect(overlapWarnings({ title: 'Fix auth', description: '' }, [c('D1', 'Fix auth')])).toEqual([]);
    expect(overlapWarnings({ title: 'feat: fix the auth flow', description: '' }, [c('D1', 'feat: fix the auth flow')])).toEqual([]);
    expect(overlapWarnings({ title: 'go to db ui', description: '' }, [c('D1', 'go to db ui')])).toEqual([]);
    expect(overlapWarnings({ title: 'Token refresh retry', description: '' }, [c('D1', 'token REFRESH retry')])).toEqual(['title closely matches D1']);
  });
  it('a file overlap wins over a title match for the same candidate', () => {
    expect(overlapWarnings(incoming, [c('D4', incoming.title, incoming.description)])).toEqual(['overlaps files with D4 (add dependsOn?)']);
  });
  it('caps at 3 warnings, each at most 60 chars', () => {
    const many = Array.from({ length: 5 }, (_, i) => c(`T${100000 + i}`, 'x', incoming.description));
    const w = overlapWarnings(incoming, many);
    expect(w).toHaveLength(3);
    for (const x of w) expect(x.length).toBeLessThanOrEqual(60);
  });
});
