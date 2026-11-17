import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { main, parseArgs } from '../../src/workflow/uat/harnessRunner.mjs';

const dirs = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'harness-run-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  vi.restoreAllMocks();
  while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true });
});

describe('uat-harness run.mjs', () => {
  it('parses flags and the command after --', () => {
    expect(parseArgs(['--harness', 'sbx', '--check', 'c1', '--', 'echo', 'a b'])).toEqual({
      harness: 'sbx', check: 'c1', command: ['echo', 'a b'],
    });
  });
  it.each([
    [['--check', 'c', '--', 'x'], '--harness'],
    [['--harness', '../x', '--check', 'c', '--', 'x'], '--harness'],
    [['--harness', 'h', '--check', 'c'], 'command'],
    [['--bogus', 'h', '--', 'x'], 'unknown'],
  ])('rejects bad args %j', (argv, message) => {
    expect(() => parseArgs(argv)).toThrow(message);
  });

  it('writes summary.json with the command, exit code and tails', async () => {
    vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const cwd = tmp();
    const code = await main(
      ['--harness', 'sbx', '--check', 'c1', '--', 'sh', '-c', 'echo out; echo err >&2; exit 3'],
      cwd,
    );
    expect(code).toBe(3);
    const summary = JSON.parse(readFileSync(join(cwd, '.karst/uat-scratch/out/sbx/c1/summary.json'), 'utf8'));
    expect(summary).toMatchObject({ harness: 'sbx', check: 'c1', exitCode: 3, stdoutTail: 'out\n', stderrTail: 'err\n' });
    expect(summary.command).toEqual(['sh', '-c', 'echo out; echo err >&2; exit 3']);
  });

  it('records exit 127 for a command that does not exist', async () => {
    vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const cwd = tmp();
    expect(await main(['--harness', 'h', '--check', 'c', '--', 'no-such-binary-xyz'], cwd)).toBe(127);
  });
});
