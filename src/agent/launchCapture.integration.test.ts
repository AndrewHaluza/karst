import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { captureFilesFor, readLaunchFailure, wrapWithStderrCapture } from './launchCapture.js';

const run = (script: string): { status: number | null; stderr: string; dir: string } => {
  const dir = mkdtempSync(join(tmpdir(), 'karst-capture-int-'));
  const w = wrapWithStderrCapture(
    { cwd: dir, shellPath: '/bin/sh', shellArgs: ['-c', script], env: {} },
    captureFilesFor(dir, 9),
  );
  const r = spawnSync(w.shellPath, w.shellArgs, { input: '\n', encoding: 'utf8' });
  return { status: r.status, stderr: r.stderr, dir };
};

describe('wrapWithStderrCapture (real bash)', () => {
  it('captures stderr of a fast failure, keeps the exit code and shows the hint', () => {
    const { status, stderr, dir } = run('echo boom >&2; exit 3');
    try {
      expect(status).toBe(3);
      expect(stderr).toContain('boom');
      expect(stderr).toContain('agentBackends.<core>=host');
      expect(readLaunchFailure(captureFilesFor(dir, 9))).toEqual({ exitCode: 3, tail: 'boom\n' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('records nothing for a clean exit', () => {
    const { status, dir } = run('echo hi >&2; exit 0');
    try {
      expect(status).toBe(0);
      expect(readLaunchFailure(captureFilesFor(dir, 9))).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
