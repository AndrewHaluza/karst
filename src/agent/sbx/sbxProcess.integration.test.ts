import { describe, expect, it } from 'vitest';
import { NODE_SBX_PROCESS } from './sbxProcess.js';

describe('NODE_SBX_PROCESS', () => {
  it('runs an argv array and captures code, stdout and stderr', async () => {
    const out = await NODE_SBX_PROCESS.run(process.execPath, [
      '-e', 'process.stdout.write(process.argv[1]); process.stderr.write("e"); process.exit(3)', 'a b; rm -rf x',
    ]);
    expect(out).toEqual({ code: 3, stdout: 'a b; rm -rf x', stderr: 'e' });
  });

  it('resolves a missing binary to code 127 instead of throwing', async () => {
    const out = await NODE_SBX_PROCESS.run('karst-no-such-binary-xyz', ['version']);
    expect(out.code).toBe(127);
  });

  it('kills the child and fails once stdout passes maxStdoutBytes', async () => {
    const out = await NODE_SBX_PROCESS.run(process.execPath, ['-e', 'setInterval(() => process.stdout.write("x".repeat(1024)), 1)'], { maxStdoutBytes: 4096 });
    expect(out).toEqual({ code: 1, stdout: '', stderr: 'output exceeded 4096 bytes' });
  });

  it('keeps output at or under maxStdoutBytes', async () => {
    const out = await NODE_SBX_PROCESS.run(process.execPath, ['-e', 'process.stdout.write("abcd")'], { maxStdoutBytes: 4 });
    expect(out).toMatchObject({ code: 0, stdout: 'abcd' });
  });
});
