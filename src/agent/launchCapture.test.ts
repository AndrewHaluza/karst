import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, afterEach } from 'vitest';
import {
  FAST_FAIL_SECONDS,
  TAIL_BYTES,
  captureFilesFor,
  formatLaunchFailure,
  readLaunchFailure,
  wrapWithStderrCapture,
} from './launchCapture.js';

const dirs: string[] = [];
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'karst-capture-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const placed = { cwd: '/w', shellPath: 'sbx', shellArgs: ['run', 'x'], env: { A: '1' } };

describe('wrapWithStderrCapture', () => {
  it('runs the original launch under bash, passing the capture file and argv', () => {
    const files = captureFilesFor('/art', 7);
    const w = wrapWithStderrCapture(placed, files);
    expect(w.shellPath).toBe('/bin/bash');
    expect(w.shellArgs.slice(0, 1)).toEqual(['-c']);
    expect(w.shellArgs.slice(2)).toEqual(['karst-launch', files.stderr, files.fast, 'sbx', 'run', 'x']);
    expect(w.cwd).toBe('/w');
    expect(w.env).toEqual({ A: '1' });
    expect(files.stderr).toContain('7');
  });

  it('always exits 0 so VS Code shows no raw bash crash toast', () => {
    const script = wrapWithStderrCapture(placed, captureFilesFor('/art', 7)).shellArgs[1]!;
    expect(script.trimEnd().split('\n').at(-1)).toBe('exit 0');
    expect(script).not.toContain('exit "$rc"');
  });

  it('records the marker for a fast failure and for a mid-session 137 kill', () => {
    const script = wrapWithStderrCapture(placed, captureFilesFor('/art', 7)).shellArgs[1]!;
    expect(script).toContain('if { [ "$rc" -ne 0 ] && [ "$SECONDS" -lt 10 ]; } || [ "$rc" -eq 137 ]; then');
  });

  it('keeps the window and tail constants bounded', () => {
    expect(FAST_FAIL_SECONDS).toBe(10);
    expect(TAIL_BYTES).toBe(4096);
  });
});

describe('readLaunchFailure', () => {
  it('returns null when no fast-fail marker exists (normal session)', () => {
    const d = tmp();
    const files = captureFilesFor(d, 1);
    writeFileSync(files.stderr, 'noise');
    expect(readLaunchFailure(files)).toBeNull();
    expect(existsSync(files.stderr)).toBe(false); // always cleaned
  });

  it('returns exit code and the last 4 KB of stderr on a fast failure', () => {
    const d = tmp();
    const files = captureFilesFor(d, 1);
    writeFileSync(files.stderr, 'x'.repeat(5000) + 'TAIL');
    writeFileSync(files.fast, '1\n');
    const r = readLaunchFailure(files);
    expect(r?.exitCode).toBe(1);
    expect(r?.tail.length).toBe(TAIL_BYTES);
    expect(r?.tail.endsWith('TAIL')).toBe(true);
    expect(existsSync(files.fast)).toBe(false);
  });

  it('tolerates a missing stderr file', () => {
    const d = tmp();
    const files = captureFilesFor(d, 2);
    writeFileSync(files.fast, '125');
    expect(readLaunchFailure(files)).toEqual({ exitCode: 125, tail: '' });
  });
});

describe('formatLaunchFailure', () => {
  it('builds the WARN line with a flattened tail', () => {
    expect(formatLaunchFailure('T704', 'sbx', { exitCode: 1, tail: 'a\nb\n' })).toBe(
      '[session] ticket T704 sandbox launch failed (runner: sbx, exit 1): a b',
    );
  });
  it('says so when nothing was captured', () => {
    expect(formatLaunchFailure('T1', 'docker', { exitCode: 2, tail: '' })).toContain('(no output captured)');
  });
});
