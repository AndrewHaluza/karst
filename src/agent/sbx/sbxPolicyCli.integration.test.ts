import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { sbxHostPolicyArgs, sbxPolicyArgs } from './sbxPorts.js';

const hasSbx = spawnSync('sbx', ['version'], { encoding: 'utf8' }).status === 0;
const SCRATCH = 'karst-t1192-no-such-sandbox';

/** The real CLI must accept karst's rm argv: a usage error ("unexpected argument") means a window that never closes. */
describe.skipIf(!hasSbx)('sbx policy rm argv against the real CLI', () => {
  const run = (args: string[]) => spawnSync('sbx', args, { encoding: 'utf8' });

  it('rejects the old positional form', () => {
    const out = run(['policy', 'rm', 'network', '--sandbox', SCRATCH, 'github.com:443']);
    expect(out.stderr).toMatch(/unexpected argument/);
  });

  it.each([
    ['setup hosts', sbxHostPolicyArgs('rm', SCRATCH, ['github.com'])],
    ['baseline ports', sbxPolicyArgs('rm', SCRATCH, [5432])],
  ])('parses the %s rm argv (no usage error)', (_label, args) => {
    const out = run(args);
    expect(out.stderr).not.toMatch(/unexpected argument|unknown flag|accepts/);
  });
});
