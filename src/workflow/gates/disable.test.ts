import { describe, expect, it } from 'vitest';
import { partitionDisabled } from './disable.js';
import type { ResolvedGate } from './resolve.js';

function gate(name: string, required = false): ResolvedGate {
  return { name, command: 'npm', args: ['run', name], script: name, required };
}

describe('partitionDisabled', () => {
  it('keeps everything when nothing is disabled', () => {
    const gates = [gate('test'), gate('e2e')];
    const { kept, skipped } = partitionDisabled(gates, []);
    expect(kept.map((g) => g.name)).toEqual(['test', 'e2e']);
    expect(skipped).toEqual([]);
  });

  it('removes a named gate and reports it as skipped', () => {
    const { kept, skipped } = partitionDisabled([gate('test'), gate('e2e')], ['e2e']);
    expect(kept.map((g) => g.name)).toEqual(['test']);
    expect(skipped.map((g) => g.name)).toEqual(['e2e']);
  });

  it('removes a REQUIRED gate too — an explicit disable outranks a declaration', () => {
    const { kept, skipped } = partitionDisabled([gate('lint', true)], ['lint']);
    expect(kept).toEqual([]);
    expect(skipped.map((g) => g.name)).toEqual(['lint']);
  });

  it('matches by exact name, never by prefix or case', () => {
    const { kept } = partitionDisabled([gate('test'), gate('test:integration')], ['test']);
    expect(kept.map((g) => g.name)).toEqual(['test:integration']);
    expect(partitionDisabled([gate('E2E')], ['e2e']).kept.map((g) => g.name)).toEqual(['E2E']);
  });

  it('ignores a disabled name no gate carries', () => {
    const { kept, skipped } = partitionDisabled([gate('test')], ['nope']);
    expect(kept.map((g) => g.name)).toEqual(['test']);
    expect(skipped).toEqual([]);
  });

  it('removes every gate sharing a disabled name', () => {
    const { skipped } = partitionDisabled([gate('test'), gate('test')], ['test']);
    expect(skipped).toHaveLength(2);
  });

  it('never mutates the input array or its gates', () => {
    const gates = [gate('test'), gate('e2e')];
    const snapshot = JSON.stringify(gates);
    partitionDisabled(gates, ['e2e']);
    expect(JSON.stringify(gates)).toBe(snapshot);
  });
});
