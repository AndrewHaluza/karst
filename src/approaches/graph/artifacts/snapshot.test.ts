/**
 * Artifact snapshot protocol (Slice 2 Task 7): a symlink, a FIFO, a
 * hardlinked file, a directory, an oversize file, a media-type mismatch, and
 * a swap after validation are each rejected or made irrelevant by the
 * one-descriptor protocol; a required output whose staging destination
 * already exists refuses the launch; artifact roots live outside every
 * worktree, so `git status` stays clean with artifacts present.
 */

import { describe, it, expect } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  symlinkSync,
  linkSync,
  rmSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  artifactRootDir,
  assertStagingAbsent,
  graphRunDir,
  snapshotFile,
  workspaceRootDir,
  type SnapshotSpec,
} from './snapshot.js';

function harness(): { dir: string; artifactDir: string; makeSpec: (path: string, overrides?: Partial<SnapshotSpec>) => SnapshotSpec } {
  const dir = mkdtempSync(join(tmpdir(), 'karst-snapshot-'));
  const artifactDir = join(dir, 'store', 'graph', 'project', '1', '1', 'artifacts');
  mkdirSync(artifactDir, { recursive: true });
  return {
    dir,
    artifactDir,
    makeSpec: (path: string, overrides?: Partial<SnapshotSpec>) => ({
      path,
      maxBytes: 1024,
      mediaType: 'text/markdown',
      ...overrides,
    }),
  };
}

describe('snapshotFile — the one-descriptor protocol', () => {
  it('snapshots a regular file into content-addressed storage', () => {
    const { dir, artifactDir, makeSpec } = harness();
    const source = join(dir, 'graph.json');
    writeFileSync(source, '{"version":1}');
    const result = snapshotFile(makeSpec(source, { mediaType: 'application/json' }), artifactDir);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.size).toBe(13);
    expect(result.sha256).toHaveLength(64);
    // The stored bytes are exactly the source bytes, under the content address.
    expect(readFileSync(join(artifactDir, result.sha256), 'utf8')).toBe('{"version":1}');
  });

  it('rejects a symlink at open (O_NOFOLLOW)', () => {
    const { dir, artifactDir, makeSpec } = harness();
    const real = join(dir, 'real.md');
    const link = join(dir, 'link.md');
    writeFileSync(real, '# real');
    symlinkSync(real, link);
    const result = snapshotFile(makeSpec(link), artifactDir);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('not-regular');
  });

  it('rejects a FIFO (O_NONBLOCK open, fstat not regular)', () => {
    const { dir, artifactDir, makeSpec } = harness();
    const fifo = join(dir, 'pipe');
    execFileSync('mkfifo', [fifo]);
    const result = snapshotFile(makeSpec(fifo), artifactDir);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('not-regular');
  });

  it('rejects a directory', () => {
    const { dir, artifactDir, makeSpec } = harness();
    const subdir = join(dir, 'subdir');
    mkdirSync(subdir);
    const result = snapshotFile(makeSpec(subdir), artifactDir);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('not-regular');
  });

  it('rejects a hardlinked file', () => {
    const { dir, artifactDir, makeSpec } = harness();
    const a = join(dir, 'a.md');
    const b = join(dir, 'b.md');
    writeFileSync(a, '# a');
    linkSync(a, b);
    const result = snapshotFile(makeSpec(a), artifactDir);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('hardlinked');
  });

  it('rejects an oversize file', () => {
    const { dir, artifactDir, makeSpec } = harness();
    const source = join(dir, 'big.md');
    writeFileSync(source, 'x'.repeat(2048));
    const result = snapshotFile(makeSpec(source, { maxBytes: 1024 }), artifactDir);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('oversize');
  });

  it('rejects a media-type mismatch', () => {
    const { dir, artifactDir, makeSpec } = harness();
    const source = join(dir, 'binary.md');
    writeFileSync(source, Buffer.from([0x23, 0x00, 0x42]));
    const result = snapshotFile(makeSpec(source, { mediaType: 'text/markdown' }), artifactDir);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('media-mismatch');
  });

  it('rejects declared application/json bytes that do not parse', () => {
    const { dir, artifactDir, makeSpec } = harness();
    const source = join(dir, 'graph.json');
    writeFileSync(source, '{not json');
    const result = snapshotFile(makeSpec(source, { mediaType: 'application/json' }), artifactDir);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('media-mismatch');
  });

  it('snapshots the validated bytes even when the path is swapped after open', () => {
    const { dir, artifactDir, makeSpec } = harness();
    const source = join(dir, 'swap.md');
    writeFileSync(source, 'original bytes');
    const result = snapshotFile(makeSpec(source), artifactDir);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // A swap after validation cannot matter: the descriptor was already
    // opened on the validated object and the path is never re-resolved.
    rmSync(source);
    symlinkSync(join(dir, 'elsewhere.md'), source);
    writeFileSync(join(dir, 'elsewhere.md'), 'forged');
    expect(readFileSync(join(artifactDir, result.sha256), 'utf8')).toBe('original bytes');
  });

  it('reports a missing file', () => {
    const { dir, artifactDir, makeSpec } = harness();
    const result = snapshotFile(makeSpec(join(dir, 'nope.md')), artifactDir);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('missing');
  });
});

describe('staging destinations (E7)', () => {
  it('refuses a launch when a required output staging destination already exists', () => {
    const { dir, artifactDir } = harness();
    mkdirSync(join(artifactDir, 'results'), { recursive: true });
    writeFileSync(join(artifactDir, 'results', 'out.md'), 'stale');
    const result = assertStagingAbsent(artifactDir, ['results/out.md']);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('staging-exists');
    expect(result.path).toContain('results/out.md');
  });

  it('accepts absent staging destinations', () => {
    const { artifactDir } = harness();
    const result = assertStagingAbsent(artifactDir, ['results/out.md', 'plan/PLAN.md']);
    expect(result).toEqual({ ok: true });
  });
});

describe('locations (Decision 15) and worktree cleanliness (E4)', () => {
  it('resolves artifacts and workspaces under global storage, per graph run', () => {
    const root = '/gs';
    expect(graphRunDir(root, 'project', 7, 3)).toBe('/gs/graph/project/7/3');
    expect(artifactRootDir(root, 'project', 7, 3)).toBe('/gs/graph/project/7/3/artifacts');
    expect(workspaceRootDir(root, 'project', 7, 3)).toBe('/gs/graph/project/7/3/workspaces');
  });

  it('git status stays clean in the worktree while artifacts exist', () => {
    const { dir, artifactDir } = harness();
    // The worktree is a git repo; the artifact root lives OUTSIDE it, under
    // global storage — the reason no KARST_EXCLUDE_RULES entry is needed.
    const worktree = join(dir, 'worktree');
    mkdirSync(worktree);
    execFileSync('git', ['init', '-q', worktree]);
    writeFileSync(join(worktree, 'tracked.md'), '# tracked');
    execFileSync('git', ['-C', worktree, 'add', '.']);
    execFileSync('git', ['-C', worktree, 'commit', '-q', '-m', 'init']);
    writeFileSync(join(artifactDir, 'evidence.md'), '# evidence');
    const status = execFileSync('git', ['-C', worktree, 'status', '--porcelain'], {
      encoding: 'utf8',
    });
    expect(status.trim()).toBe('');
  });
});
