import { describe, expect, it } from 'vitest';
import { staleOnlyCommands } from './baseMovedStale.js';

const CMD = 'npm run -s docs:graph';
const STALE = `docs/arch/system-map.md is stale: run ${CMD}`;

describe('staleOnlyCommands', () => {
  it('returns the command of a stale-only failure', () => {
    expect(staleOnlyCommands([{ summary: STALE }], [CMD])).toEqual([CMD]);
  });
  it('merges the commands of several gates once', () => {
    expect(staleOnlyCommands([{ summary: STALE }, { summary: `a.md is stale: run ${CMD}\nb.md is stale: run other` }], [CMD, 'other'])).toEqual([CMD, 'other']);
  });
  it('returns null when no gate failed', () => {
    expect(staleOnlyCommands([], [CMD])).toBeNull();
  });
  it('returns null when a failed gate has no summary', () => {
    expect(staleOnlyCommands([{ summary: STALE }, { summary: null }], [CMD])).toBeNull();
  });
  it('returns null when one gate fails for another reason', () => {
    expect(staleOnlyCommands([{ summary: STALE }, { summary: 'FAIL src/a.test.ts > x > y\nTest Files 1 failed' }], [CMD])).toBeNull();
  });
  it('returns null when the command is not in ship.regenerate', () => {
    expect(staleOnlyCommands([{ summary: STALE }], ['other'])).toBeNull();
    expect(staleOnlyCommands([{ summary: STALE }], [])).toBeNull();
  });
});
