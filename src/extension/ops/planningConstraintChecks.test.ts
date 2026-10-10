import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  archDocFiles,
  archWarnings,
  repoPathsOf,
  commitExistsViaGit,
  commitWarnings,
  sensitivePathWarning,
} from './planningConstraintChecks.js';

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
    expect(archWarnings(['see @arch:B', '@arch:B tail'], [repo], vi.fn())).toEqual([]);
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
  it('checks every sensitive path', () => {
    for (const path of ['src/agent/seed.ts', 'src/agent/entrySeed.ts', 'src/agent/instructions.ts', 'src/context/ticketContext.ts', 'src/planning/preamble.ts']) {
      expect(sensitivePathWarning({ description: '', summary: `edit ${path}` })).toHaveLength(1);
    }
  });
});
