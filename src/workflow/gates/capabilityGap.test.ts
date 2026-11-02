import { describe, it, expect } from 'vitest';
import { capabilityGap, EXIT_COMMAND_NOT_FOUND } from './capabilityGap.js';
import type { GateResult } from './result.js';

function result(name: string, exitCode: number | null, output = ''): GateResult {
  return { name, exitCode, output };
}

describe('capabilityGap', () => {
  it('is null when no gate failed', () => {
    expect(capabilityGap([])).toBeNull();
  });

  it('is null when a failing gate is not a missing command', () => {
    // A real failure is the ticket's to fix; a capability gap must never
    // swallow it.
    expect(capabilityGap([result('unit', 1, 'assertion failed')])).toBeNull();
  });

  it('is null when one of the failures is a real one', () => {
    expect(
      capabilityGap([result('unit', EXIT_COMMAND_NOT_FOUND, 'no toolchain'), result('e2e', 1, 'assertion failed')]),
    ).toBeNull();
  });

  it('names the gate and quotes what it said about the missing command', () => {
    const gap = capabilityGap([
      result('visual (extention)', EXIT_COMMAND_NOT_FOUND, 'docker is not installed\nsh: 1: docker: not found'),
    ]);
    expect(gap).not.toBeNull();
    expect(gap?.names).toEqual(['visual (extention)']);
    expect(gap?.reason).toContain('"visual (extention)"');
    expect(gap?.reason).toContain('exited 127');
    expect(gap?.reason).toContain('docker is not installed');
    expect(gap?.reason).toContain('install it in sandbox.setup, or mark the gate sandbox: host');
  });

  it('names every gate that hit the gap', () => {
    const gap = capabilityGap([
      result('unit', EXIT_COMMAND_NOT_FOUND, 'no C++ toolchain'),
      result('visual', EXIT_COMMAND_NOT_FOUND, 'docker is not installed'),
    ]);
    expect(gap?.names).toEqual(['unit', 'visual']);
    expect(gap?.reason).toContain('gates "unit", "visual"');
    expect(gap?.reason).toContain('no C++ toolchain');
    expect(gap?.reason).toContain('docker is not installed');
  });

  it('falls back to the gate name when the gate said nothing', () => {
    const gap = capabilityGap([result('layout', EXIT_COMMAND_NOT_FOUND, '   ')]);
    expect(gap?.reason).toContain('layout');
  });

  it('keeps the reason bounded', () => {
    const gap = capabilityGap([result('unit', EXIT_COMMAND_NOT_FOUND, 'x'.repeat(5000))]);
    expect(gap!.reason.length).toBeLessThan(1200);
  });

  describe('launcher MODULE_NOT_FOUND', () => {
    const launcher = (mod: string, stack = '[]'): string =>
      `node:internal/modules/cjs/loader:1228\n  throw err;\n\nError: Cannot find module '${mod}'\n    at Function._resolveFilename {\n  code: 'MODULE_NOT_FOUND',\n  requireStack: ${stack}\n}`;

    it('is a gap when the tool the gate launches is missing under node_modules', () => {
      const mod = '/repo/.karst/worktrees/t/node_modules/typescript/bin/tsc';
      const gap = capabilityGap([result('typecheck', 1, launcher(mod))]);
      expect(gap?.names).toEqual(['typecheck']);
      expect(gap?.reason).toContain('"typecheck"');
      expect(gap?.reason).toContain(mod);
      expect(gap?.reason).toContain('npm ci');
    });

    it('is not a gap when the requireStack names a project source file', () => {
      const out = launcher('/repo/node_modules/foo/index.js', "[\n    '/repo/src/foo.test.ts'\n  ]");
      expect(capabilityGap([result('unit', 1, out)])).toBeNull();
    });

    it('is not a gap when the missing module is not under node_modules', () => {
      expect(capabilityGap([result('unit', 1, launcher('../src/missing.js'))])).toBeNull();
    });

    it('is not parked when mixed with an ordinary failure', () => {
      const out = launcher('/repo/node_modules/typescript/bin/tsc');
      expect(capabilityGap([result('typecheck', 1, out), result('unit', 1, 'assertion failed')])).toBeNull();
    });

    it('is not a gap when a test failed and the error is only mentioned in its output', () => {
      const out = `FAIL src/a.test.ts\nAssertionError: expected\n${launcher('/repo/node_modules/typescript/bin/tsc')}`;
      expect(capabilityGap([result('unit', 1, out)])).toBeNull();
    });

    it('reads only the stack of the error block, and a stack-less block is a gap', () => {
      const noStack = `Error: Cannot find module '/repo/node_modules/x/bin.js'\n  code: 'MODULE_NOT_FOUND'\n}\nlater: /repo/src/a.ts`;
      expect(capabilityGap([result('g', 1, noStack)])).not.toBeNull();
      const listed = `Error: Cannot find module '/repo/node_modules/x/bin.js'\nRequire stack:\n- /repo/src/a.test.ts\n  code: 'MODULE_NOT_FOUND'`;
      expect(capabilityGap([result('g', 1, listed)])).toBeNull();
    });

    it('parks a mix of exit 127 and a launcher gap', () => {
      const out = launcher('/repo/node_modules/typescript/bin/tsc');
      expect(capabilityGap([result('a', 127, 'x'), result('typecheck', 1, out)])?.names).toEqual(['a', 'typecheck']);
    });
  });
});
