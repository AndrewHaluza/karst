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

  // A host in the global policy answers a different error ("covered by rule ... in the global policy"), so the canary uses a host that no policy lists.
  it.each([
    ['setup hosts', sbxHostPolicyArgs('rm', SCRATCH, ['karst-canary.example.com'])],
    ['baseline ports', sbxPolicyArgs('rm', SCRATCH, [5432])],
  ])('parses the %s rm argv and reaches the sandbox lookup', (_label, args) => {
    const out = run(args);
    expect(out.stderr).not.toMatch(/unexpected argument|unknown flag|accepts/);
    // A changed usage-error text must not pass: only the sandbox-lookup error shows that sbx parsed the argv.
    expect(out.stderr).toMatch(/not found|no scoped policy/);
  });
});
