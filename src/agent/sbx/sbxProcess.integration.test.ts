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
});
