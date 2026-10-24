import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TAIL_BYTES, captureFilesFor, readLaunchFailure, wrapWithStderrCapture } from './launchCapture.js';

const run = (script: string, eventsFile?: string): { status: number | null; stderr: string; dir: string } => {
  const dir = mkdtempSync(join(tmpdir(), 'karst-capture-int-'));
  const files = captureFilesFor(dir, 9, eventsFile);
  const w = wrapWithStderrCapture(
    { cwd: dir, shellPath: '/bin/sh', shellArgs: ['-c', script], env: {} },
    files,
  );
  const r = spawnSync(w.shellPath, w.shellArgs, { input: '\n', encoding: 'utf8' });
  return { status: r.status, stderr: r.stderr, dir };
};

describe('wrapWithStderrCapture (real bash)', () => {
  it('captures stderr of a fast failure, exits 0 (no raw bash toast), keeps the code in the marker and shows the hint', () => {
    const { status, stderr, dir } = run('echo boom >&2; exit 3');
    try {
      expect(status).toBe(0);
      expect(stderr).toContain('boom');
      expect(stderr).toContain('agentBackends.<core>=host');
      expect(readLaunchFailure(captureFilesFor(dir, 9))).toEqual({ exitCode: 3, tail: 'boom\n' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('records a SIGKILL-style exit 137 even after the fast-fail window', () => {
    const { status, dir } = run('sleep 10.5; exit 137');
    try {
      expect(status).toBe(0);
      expect(readLaunchFailure(captureFilesFor(dir, 9))?.exitCode).toBe(137);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20000);

  it('records a pre-SessionStart failure even after the fast-fail window when eventsFile lacks SessionStart', () => {
    const dir = mkdtempSync(join(tmpdir(), 'karst-capture-events-'));
    const eventsFile = join(dir, 'events.ndjson');
    writeFileSync(eventsFile, '{"type":"someOtherEvent"}\n');
    const { status, stderr, dir: runDir } = run('sleep 10.5; echo "sbx boot failed" >&2; exit 1', eventsFile);
    try {
      expect(status).toBe(0);
      expect(stderr).toContain('sbx boot failed');
      expect(readLaunchFailure(captureFilesFor(runDir, 9, eventsFile))).toEqual({ exitCode: 1, tail: 'sbx boot failed\n' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(runDir, { recursive: true, force: true });
    }
  }, 20000);

  it('ignores a non-zero exit after the fast-fail window when SessionStart was written', () => {
    const dir = mkdtempSync(join(tmpdir(), 'karst-capture-events-'));
    const eventsFile = join(dir, 'events.ndjson');
    writeFileSync(eventsFile, '{"type":"SessionStart"}\n');
    const { status, dir: runDir } = run('sleep 10.5; echo "user exited" >&2; exit 1', eventsFile);
    try {
      expect(status).toBe(0);
      expect(readLaunchFailure(captureFilesFor(runDir, 9, eventsFile))).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(runDir, { recursive: true, force: true });
    }
  }, 20000);

  it('records nothing for a clean exit', () => {
    const { status, dir } = run('echo hi >&2; exit 0');
    try {
      expect(status).toBe(0);
      expect(readLaunchFailure(captureFilesFor(dir, 9))).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('caps the captured stderr and still delivers all of it to the terminal', () => {
    const { stderr, dir } = run('head -c 200000 /dev/zero | tr "\\0" x >&2; exit 2');
    try {
      expect(stderr.length).toBeGreaterThan(190000);
      const f = readLaunchFailure(captureFilesFor(dir, 9));
      expect(f?.exitCode).toBe(2);
      expect(f?.tail.length).toBeLessThanOrEqual(TAIL_BYTES);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('ignores a stale marker left by an earlier launch', () => {
    const dir = mkdtempSync(join(tmpdir(), 'karst-capture-int-'));
    const files = captureFilesFor(dir, 9);
    writeFileSync(files.fast, '1\n');
    const w = wrapWithStderrCapture({ cwd: dir, shellPath: '/bin/sh', shellArgs: ['-c', 'exit 0'], env: {} }, files);
    try {
      expect(spawnSync(w.shellPath, w.shellArgs, { input: '\n' }).status).toBe(0);
      expect(readLaunchFailure(files)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
