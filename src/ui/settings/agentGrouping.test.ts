import { describe, it, expect } from 'vitest';
import { sortAgentRowsByProvenance } from './agentGrouping.js';
import type { SettingsAgentRow } from './state.js';

const row = (name: string, source: 'file' | 'approach', approachId?: string, enabled = true): SettingsAgentRow =>
  ({ name, source, ...(approachId ? { approachId } : {}), enabled, body: source === 'file' ? '' : null });

describe('sortAgentRowsByProvenance', () => {
  it('puts file agents first, preserving their order', () => {
    const out = sortAgentRowsByProvenance([
      row('zeta', 'approach', 'rpi'),
      row('beta', 'file'),
      row('alpha', 'file'),
    ]);
    expect(out.map((r) => r.name)).toEqual(['beta', 'alpha', 'zeta']);
  });

  it('groups approach agents by approachId in first-appearance order', () => {
    const out = sortAgentRowsByProvenance([
      row('a1', 'approach', 'rpi'),
      row('b1', 'approach', 'tdd'),
      row('a2', 'approach', 'rpi'),
      row('f', 'file'),
    ]);
    expect(out.map((r) => r.name)).toEqual(['f', 'a1', 'a2', 'b1']);
  });

  it('retains disabled rows', () => {
    const out = sortAgentRowsByProvenance([row('x', 'file', undefined, false)]);
    expect(out).toHaveLength(1);
    expect(out[0]!.enabled).toBe(false);
  });

  it('returns a new array (immutable)', () => {
    const input = [row('f', 'file')];
    expect(sortAgentRowsByProvenance(input)).not.toBe(input);
  });
});
