import { describe, expect, it } from 'vitest';
import { isResourceKill, resourceKillReason, EXIT_SIGKILL } from './resourceKill.js';
import type { GateResult } from './result.js';

const killed = (output: string, exitCode: number | null = 137): GateResult => ({ name: 'unit', exitCode, output });

describe('isResourceKill', () => {
  it('is true for exit 137 with only passing output', () => {
    expect(isResourceKill(killed(' ✓ a.test.ts (3 tests)\n ✓ b.test.ts (2 tests)'))).toBe(true);
  });
  it('is true for exit 137 with empty output', () => {
    expect(isResourceKill(killed(''))).toBe(true);
  });
  it('is false for other exit codes', () => {
    expect(isResourceKill(killed('', 1))).toBe(false);
    expect(isResourceKill(killed('', null))).toBe(false);
    expect(isResourceKill(killed('', 0))).toBe(false);
  });
  it.each([
    ' FAIL  src/a.test.ts > does x',
    'AssertionError: expected 1 to be 2',
    ' × does x 3ms',
    'Test Files  1 failed | 2 passed',
    'Tests  2 failed | 10 passed',
    '  1) does x',
  ])('is false for 137 with a real failure marker: %s', (line) => {
    expect(isResourceKill(killed(`ok\n${line}\n`))).toBe(false);
  });
  it('exports the SIGKILL exit code', () => {
    expect(EXIT_SIGKILL).toBe(137);
  });
});

describe('resourceKillReason', () => {
  it('names gate, exit, placement and the Docker VM hint', () => {
    const r = resourceKillReason('unit', true);
    expect(r).toContain('"unit"');
    expect(r).toContain('137');
    expect(r).toContain('sandbox');
    expect(r).toMatch(/Docker Desktop memory/);
  });
  it('names the host placement without the Docker hint', () => {
    const r = resourceKillReason('unit', false);
    expect(r).toContain('host');
    expect(r).not.toMatch(/Docker Desktop/);
  });
});
