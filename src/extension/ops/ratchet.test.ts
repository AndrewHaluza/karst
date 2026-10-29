import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { defaultGitRunner, type GitRunner } from '../../integrations/git.js';
import {
  ALLOWED_EXTENSION_GROWTH,
  COARSE_EXTENSION_CEILING,
  calculateGrowth,
  resolveBaseRef,
  resolveMergeBase,
  checkExtensionRatchet,
  assertExtensionRatchet,
  extensionGrowthErrorMessage,
} from './ratchet.js';

// Extension entry file growth is capped at ALLOWED_EXTENSION_GROWTH (15) net lines
// compared with the merge base of the ticket's base branch (origin/develop, or develop).
// When git or the base is unavailable, COARSE_EXTENSION_CEILING applies as a fallback.

describe('extension.ts ratchet arithmetic and base resolution', () => {
  it('calculates net growth correctly', () => {
    expect(calculateGrowth(8790, 8790)).toBe(0);
    expect(calculateGrowth(8790, 8805)).toBe(15);
    expect(calculateGrowth(8790, 8806)).toBe(16);
    expect(calculateGrowth(8790, 8780)).toBe(-10);
  });

  it('resolves base ref: prefers origin/develop when present', async () => {
    const fakeGit: GitRunner = async (args) => {
      if (args[0] === 'rev-parse' && args[2] === 'origin/develop') {
        return { stdout: 'sha-origin\n', stderr: '', exitCode: 0 };
      }
      return { stdout: '', stderr: 'not found', exitCode: 1 };
    };
    const ref = await resolveBaseRef(fakeGit, '/repo');
    expect(ref).toBe('origin/develop');
  });

  it('resolves base ref: falls back to develop when remote ref does not exist', async () => {
    const fakeGit: GitRunner = async (args) => {
      if (args[0] === 'rev-parse' && args[2] === 'origin/develop') {
        return { stdout: '', stderr: 'unknown revision', exitCode: 128 };
      }
      if (args[0] === 'rev-parse' && args[2] === 'develop') {
        return { stdout: 'sha-local\n', stderr: '', exitCode: 0 };
      }
      return { stdout: '', stderr: 'not found', exitCode: 1 };
    };
    const ref = await resolveBaseRef(fakeGit, '/repo');
    expect(ref).toBe('develop');
  });

  it('resolves base ref: returns null when neither exists or git fails', async () => {
    const fakeGit: GitRunner = async () => ({ stdout: '', stderr: 'not found', exitCode: 128 });
    const ref = await resolveBaseRef(fakeGit, '/repo');
    expect(ref).toBeNull();
  });

  it('resolves merge base with origin/develop when available', async () => {
    const calls: string[][] = [];
    const fakeGit: GitRunner = async (args) => {
      calls.push(args);
      if (args[0] === 'rev-parse' && args[2] === 'origin/develop') {
        return { stdout: 'sha-origin\n', stderr: '', exitCode: 0 };
      }
      if (args[0] === 'merge-base' && args[1] === 'origin/develop') {
        return { stdout: 'mb-sha-123\n', stderr: '', exitCode: 0 };
      }
      return { stdout: '', stderr: 'error', exitCode: 1 };
    };
    const mb = await resolveMergeBase(fakeGit, '/repo');
    expect(mb).toBe('mb-sha-123');
    expect(calls).toContainEqual(['rev-parse', '--verify', 'origin/develop']);
    expect(calls).toContainEqual(['merge-base', 'origin/develop', 'HEAD']);
  });

  it('resolves merge base with develop when origin/develop is missing', async () => {
    const calls: string[][] = [];
    const fakeGit: GitRunner = async (args) => {
      calls.push(args);
      if (args[0] === 'rev-parse' && args[2] === 'origin/develop') {
        return { stdout: '', stderr: 'error', exitCode: 1 };
      }
      if (args[0] === 'rev-parse' && args[2] === 'develop') {
        return { stdout: 'sha-local\n', stderr: '', exitCode: 0 };
      }
      if (args[0] === 'merge-base' && args[1] === 'develop') {
        return { stdout: 'mb-local-456\n', stderr: '', exitCode: 0 };
      }
      return { stdout: '', stderr: 'error', exitCode: 1 };
    };
    const mb = await resolveMergeBase(fakeGit, '/repo');
    expect(mb).toBe('mb-local-456');
    expect(calls).toContainEqual(['merge-base', 'develop', 'HEAD']);
  });

  it('returns null when merge-base fails (shallow clone)', async () => {
    const fakeGit: GitRunner = async (args) => {
      if (args[0] === 'rev-parse') {
        return { stdout: 'sha\n', stderr: '', exitCode: 0 };
      }
      if (args[0] === 'merge-base') {
        return { stdout: '', stderr: 'fatal: no merge base', exitCode: 128 };
      }
      return { stdout: '', stderr: 'error', exitCode: 1 };
    };
    const mb = await resolveMergeBase(fakeGit, '/repo');
    expect(mb).toBeNull();
  });
});

describe('extension.ts ratchet growth check', () => {
  const baseContent = Array(100).fill('line').join('\n'); // 100 lines

  function makeGit(baseFileContent: string = baseContent): GitRunner {
    return async (args) => {
      if (args[0] === 'rev-parse') {
        return { stdout: 'sha\n', stderr: '', exitCode: 0 };
      }
      if (args[0] === 'merge-base') {
        return { stdout: 'mb-sha\n', stderr: '', exitCode: 0 };
      }
      if (args[0] === 'show' && args[1] === 'mb-sha:src/extension.ts') {
        return { stdout: baseFileContent, stderr: '', exitCode: 0 };
      }
      return { stdout: '', stderr: 'not found', exitCode: 1 };
    };
  }

  it('passes when change leaves the file the same size', async () => {
    const git = makeGit();
    const res = await checkExtensionRatchet({
      git,
      currentSource: baseContent,
    });
    expect(res.ok).toBe(true);
    expect(res.growth).toBe(0);
  });

  it('passes when change removes lines', async () => {
    const git = makeGit();
    const reducedContent = Array(80).fill('line').join('\n'); // 80 lines (-20)
    const res = await checkExtensionRatchet({
      git,
      currentSource: reducedContent,
    });
    expect(res.ok).toBe(true);
    expect(res.growth).toBe(-20);
  });

  it('passes when change adds 15 or fewer net lines', async () => {
    const git = makeGit();
    const addedContent = Array(110).fill('line').join('\n'); // +10 lines
    const res = await checkExtensionRatchet({
      git,
      currentSource: addedContent,
    });
    expect(res.ok).toBe(true);
    expect(res.growth).toBe(10);
  });

  it('passes when change adds exactly 15 net lines', async () => {
    const git = makeGit();
    const addedContent = Array(115).fill('line').join('\n'); // +15 lines
    const res = await checkExtensionRatchet({
      git,
      currentSource: addedContent,
    });
    expect(res.ok).toBe(true);
    expect(res.growth).toBe(15);
  });

  it('fails with actionable message when change adds 16 or more net lines', async () => {
    const git = makeGit();
    const addedContent = Array(116).fill('line').join('\n'); // +16 lines
    const res = await checkExtensionRatchet({
      git,
      currentSource: addedContent,
    });
    expect(res.ok).toBe(false);
    expect(res.growth).toBe(16);
    expect(res.errorMessage).toBe(
      'src/extension.ts grew by 16 lines in this change (allowed: 15). Move the logic into a module under src/extension/ (a *Binding.ts, or ops/ for vscode-free logic) and keep only the wiring call here.'
    );
  });

  it('assertExtensionRatchet throws the expected message when growth exceeded', async () => {
    const git = makeGit();
    const addedContent = Array(120).fill('line').join('\n'); // +20 lines
    await expect(
      assertExtensionRatchet({
        git,
        currentSource: addedContent,
      })
    ).rejects.toThrow(
      'src/extension.ts grew by 20 lines in this change (allowed: 15). Move the logic into a module under src/extension/ (a *Binding.ts, or ops/ for vscode-free logic) and keep only the wiring call here.'
    );
  });
});

describe('extension.ts ratchet fallback ceiling when base is unavailable', () => {
  it('passes when git is unavailable but line count is below fallback ceiling', async () => {
    const git: GitRunner = async () => {
      throw new Error('git not found');
    };
    const content = Array(5000).fill('line').join('\n');
    const res = await checkExtensionRatchet({
      git,
      currentSource: content,
      ceiling: 9100,
    });
    expect(res.ok).toBe(true);
  });

  it('passes when shallow clone has no merge base and file is below fallback ceiling', async () => {
    const git: GitRunner = async (args) => {
      if (args[0] === 'rev-parse') return { stdout: 'sha\n', stderr: '', exitCode: 0 };
      return { stdout: '', stderr: 'fatal: no merge base', exitCode: 128 };
    };
    const content = Array(9100).fill('line').join('\n'); // exactly ceiling
    const res = await checkExtensionRatchet({
      git,
      currentSource: content,
      ceiling: 9100,
    });
    expect(res.ok).toBe(true);
  });

  it('fails with ceiling message and no raw git error when file exceeds fallback ceiling', async () => {
    const git: GitRunner = async () => {
      throw new Error('git: command not found (opaque raw git error)');
    };
    const content = Array(9101).fill('line').join('\n'); // ceiling + 1
    const res = await checkExtensionRatchet({
      git,
      currentSource: content,
      ceiling: 9100,
    });
    expect(res.ok).toBe(false);
    expect(res.errorMessage).toBeDefined();
    expect(res.errorMessage).toContain('ceiling');
    expect(res.errorMessage).not.toContain('command not found');
    expect(res.errorMessage).not.toContain('opaque raw git error');

    await expect(
      assertExtensionRatchet({
        git,
        currentSource: content,
        ceiling: 9100,
      })
    ).rejects.toThrow(/ceiling/);
  });
});

describe('extension.ts ratchet live check', () => {
  it('src/extension.ts passes the ratchet against the merge base', async () => {
    await assertExtensionRatchet({ git: defaultGitRunner });
  });
});

describe('ops/ has no vscode import', () => {
  it('no file under src/extension/ops/ imports vscode', () => {
    const opsDir = join(process.cwd(), 'src', 'extension', 'ops');
    const files = readdirSync(opsDir).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));
    const vscodeRe = /from ['"]vscode['"]|require\(['"]vscode['"]\)/;
    const violations: string[] = [];
    for (const file of files) {
      const content = readFileSync(join(opsDir, file), 'utf8');
      if (vscodeRe.test(content)) {
        violations.push(file);
      }
    }
    expect(violations).toEqual([]);
  });
});
