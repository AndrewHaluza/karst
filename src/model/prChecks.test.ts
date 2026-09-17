import { describe, it, expect } from 'vitest';
import {
  MAX_FAILING_CHECKS,
  serializeChecks,
  parseChecks,
  readMergeBlock,
  type PrChecks,
} from './prChecks.js';

function passing(): PrChecks {
  return {
    state: 'passing',
    total: 3,
    passed: 3,
    failed: 0,
    pending: 0,
    failing: [],
    failedShown: 0,
  };
}

describe('serializeChecks / parseChecks', () => {
  it('serializes null as null ("never probed")', () => {
    expect(serializeChecks(null)).toBeNull();
  });

  it('serializes an unknown-state rollup as null — an unknown is not a value', () => {
    const unknown = { ...passing(), state: 'unknown' as const };
    expect(serializeChecks(unknown)).toBeNull();
  });

  it('round-trips a passing rollup', () => {
    const checks = passing();
    expect(parseChecks(serializeChecks(checks))).toEqual(checks);
  });

  it('parses an absent, empty, or malformed column as null, never a throw', () => {
    expect(parseChecks(null)).toBeNull();
    expect(parseChecks(undefined)).toBeNull();
    expect(parseChecks('')).toBeNull();
    expect(parseChecks('{not json')).toBeNull();
    expect(parseChecks('[]')).toBeNull();
    expect(parseChecks('{"state":"green"}')).toBeNull();
  });

  it('drops a failing entry with no string name and keeps one whose url is missing', () => {
    const parsed = parseChecks(
      JSON.stringify({
        state: 'failing',
        total: 2,
        passed: 0,
        failed: 2,
        pending: 0,
        failing: [{ url: 'https://example.test/run/1' }, { name: 'build', url: null }],
        failedShown: 2,
      }),
    );
    expect(parsed).toEqual({
      state: 'failing',
      total: 2,
      passed: 0,
      failed: 2,
      pending: 0,
      failing: [{ name: 'build', url: null }],
      failedShown: 2,
    });
  });

  it('reads missing or non-finite counts as 0 and a non-array failing as []', () => {
    const parsed = parseChecks('{"state":"passing","total":3}');
    expect(parsed).toEqual({
      state: 'passing',
      total: 3,
      passed: 0,
      failed: 0,
      pending: 0,
      failing: [],
      failedShown: 0,
    });
    expect(parseChecks('{"state":"passing","failing":"nope","passed":null}')?.failedShown).toBe(0);
    expect(parseChecks('{"state":"passing","failing":"nope","passed":null}')?.passed).toBe(0);
  });

  it('exposes the failing-check cap', () => {
    expect(MAX_FAILING_CHECKS).toBe(10);
  });
});

describe('readMergeBlock', () => {
  it('passes the seven known tokens through', () => {
    for (const token of ['clean', 'blocked', 'behind', 'dirty', 'unstable', 'draft', 'has_hooks']) {
      expect(readMergeBlock(token)).toBe(token);
    }
  });

  it('reads null, empty and unrecognised tokens as unknown, never as a block', () => {
    // A newer karst's token must not be able to claim GitHub refuses a merge.
    expect(readMergeBlock(null)).toBe('unknown');
    expect(readMergeBlock('')).toBe('unknown');
    expect(readMergeBlock('mergeable')).toBe('unknown');
    expect(readMergeBlock('SOMETHING_NEW')).toBe('unknown');
  });
});
