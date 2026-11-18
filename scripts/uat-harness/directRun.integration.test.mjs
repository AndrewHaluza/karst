import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { main, parseArgs } from '../../src/workflow/uat/directRunRecorder.mjs';

const dirs = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'direct-run-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  vi.restoreAllMocks();
  while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true });
});

describe('directRunRecorder.mjs', () => {
  it('parses flags and the command after --', () => {
    expect(parseArgs(['--name', 'n1', '--run', 'r1', '--', 'echo', 'a b'])).toEqual({
      name: 'n1', run: 'r1', command: ['echo', 'a b'],
    });
  });
  it.each([
    [['--', 'x'], '--name'],
    [['--name', '../x', '--', 'x'], '--name'],
    [['--name', 'n'], 'command'],
    [['--bogus', 'n', '--', 'x'], 'unknown'],
  ])('rejects bad args %j', (argv, message) => {
    expect(() => parseArgs(argv)).toThrow(message);
  });

  it('writes the summary with the exit code of a failing command', async () => {
    vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const cwd = tmp();
    const code = await main(['--name', 'n1', '--run', 'r1', '--', 'sh', '-c', 'echo out; echo err >&2; exit 3'], cwd);
    expect(code).toBe(3);
    const summary = JSON.parse(readFileSync(join(cwd, '.karst/uat-scratch/out/direct/n1/summary.json'), 'utf8'));
    expect(summary).toMatchObject({
      kind: 'direct-run', name: 'n1', runId: 'r1', exitCode: 3, stdoutTail: 'out\n', stderrTail: 'err\n',
    });
    expect(summary.command).toEqual(['sh', '-c', 'echo out; echo err >&2; exit 3']);
    expect(Date.parse(summary.startedAt)).toBeLessThanOrEqual(Date.parse(summary.finishedAt));
  });

  it('records a null run id when --run is absent, and exit 127 for a missing binary', async () => {
    vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const cwd = tmp();
    expect(await main(['--name', 'n', '--', 'no-such-binary-xyz'], cwd)).toBe(127);
    const summary = JSON.parse(readFileSync(join(cwd, '.karst/uat-scratch/out/direct/n/summary.json'), 'utf8'));
    expect(summary.runId).toBeNull();
  });
});
