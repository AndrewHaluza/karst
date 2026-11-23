import { describe, expect, it } from 'vitest';
import type { DoctorReport } from '../../doctor/types.js';
import { createDoctorRun, type DoctorCliInput, type ExecFileFn } from './doctorRun.js';

const report: DoctorReport = {
  areas: ['state'],
  fixRequested: false,
  applied: [],
  summary: { ok: 0, warn: 0, fail: 0, skipped: 0 },
  checks: [],
  exitCode: 0,
};

function recorder(): { calls: Array<{ file: string; args: readonly string[] }>; exec: ExecFileFn } {
  const calls: Array<{ file: string; args: readonly string[] }> = [];
  const exec: ExecFileFn = (file, args, callback) => {
    calls.push({ file, args });
    callback(undefined, JSON.stringify(report), '');
  };
  return { calls, exec };
}

describe('createDoctorRun (DR-4)', () => {
  it('reads the CLI input on every run, so a manifest switch reaches the next run', async () => {
    const { calls, exec } = recorder();
    let input: DoctorCliInput = { cliEntry: '/cli/main.js', dbPath: '/db/one', manifestPath: '/one/karst.yml' };
    const run = createDoctorRun(() => input, exec);
    await run(false);
    input = { cliEntry: '/cli/main.js', dbPath: '/db/two', manifestPath: '/two/karst.yml' };
    await run(false);
    expect(calls.map((c) => c.args)).toEqual([
      ['/cli/main.js', '--db', '/db/one', '--manifest', '/one/karst.yml', 'doctor', '--json'],
      ['/cli/main.js', '--db', '/db/two', '--manifest', '/two/karst.yml', 'doctor', '--json'],
    ]);
    // The CLI runs under this Node, not a shell.
    expect(calls[0]!.file).toBe(process.execPath);
  });

  it('omits --manifest when the session has none and pins each confirmed fix id', async () => {
    const { calls, exec } = recorder();
    const run = createDoctorRun(() => ({ cliEntry: '/c.js', dbPath: '/db' }), exec);
    await run(true, ['state.a', 'tools.b']);
    expect(calls[0]!.args).toEqual([
      '/c.js', '--db', '/db', 'doctor', '--json', '--fix', '--only', 'state.a', '--only', 'tools.b',
    ]);
  });

  it('surfaces the spawn error when no report came back', async () => {
    const run = createDoctorRun(
      () => ({ cliEntry: '/c.js', dbPath: '/db' }),
      (_file, _args, callback) => callback(new Error('spawn karst ENOENT'), '', ''),
    );
    await expect(run(false)).rejects.toThrow('karst doctor produced no report: spawn karst ENOENT');
  });
});
