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
});
