import { describe, expect, it } from 'vitest';
import { NODE_DOCKER_PROCESS } from './dockerProcess.js';

const node = process.execPath;

describe('NODE_DOCKER_PROCESS.pipe (real child processes)', () => {
  it('streams stdout into stdin and returns exit codes only', async () => {
    const result = await NODE_DOCKER_PROCESS.pipe(
      { command: node, args: ['-e', 'process.stdout.write(process.env.K_SECRET)'], env: { K_SECRET: 'sk-SECRET' } },
      { command: node, args: ['-e', "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>process.exit(s==='sk-SECRET'?0:3))"] },
    );
    expect(result).toEqual({ fromCode: 0, toCode: 0 });
  });

  it('reports each side failing, and a missing binary as 127', async () => {
    await expect(NODE_DOCKER_PROCESS.pipe(
      { command: node, args: ['-e', 'process.exit(4)'] },
      { command: node, args: ['-e', "process.stdin.resume();process.stdin.on('end',()=>process.exit(5))"] },
    )).resolves.toEqual({ fromCode: 4, toCode: 5 });
    const missing = await NODE_DOCKER_PROCESS.pipe(
      { command: 'karst-no-such-binary', args: [] },
      { command: node, args: ['-e', 'process.stdin.resume()'] },
    );
    expect(missing.fromCode).toBe(127);
  });
});
