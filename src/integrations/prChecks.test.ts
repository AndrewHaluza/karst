import { describe, it, expect } from 'vitest';
import { normalizeChecks, normalizeMergeBlock } from './prChecks.js';

const checkRun = (over: Record<string, unknown>): Record<string, unknown> => ({
  __typename: 'CheckRun',
  ...over,
});

const statusContext = (over: Record<string, unknown>): Record<string, unknown> => ({
  __typename: 'StatusContext',
  ...over,
});

describe('normalizeChecks', () => {
  it('normalizes the real PR #384 rollup (three successful CheckRuns)', () => {
    const rollup = [
      checkRun({
        name: 'Typecheck, build, unit, e2e',
        status: 'COMPLETED',
        conclusion: 'SUCCESS',
        detailsUrl: 'https://github.com/AndrewHaluza/karst/actions/runs/35152829691/job/104985079741',
        workflowName: 'CI',
      }),
      checkRun({ name: 'other', status: 'COMPLETED', conclusion: 'SUCCESS', workflowName: 'CI' }),
      checkRun({ name: 'third', status: 'COMPLETED', conclusion: 'SUCCESS', workflowName: 'CI' }),
    ];
    const checks = normalizeChecks(rollup);
    expect(checks?.state).toBe('passing');
    expect(checks?.total).toBe(3);
    expect(checks?.passed).toBe(3);
    expect(checks?.failed).toBe(0);
    expect(checks?.pending).toBe(0);
  });

  it('one FAILURE beside two SUCCESS → failing, and the failure carries its run url', () => {
    const checks = normalizeChecks([
      checkRun({ name: 'build', status: 'COMPLETED', conclusion: 'FAILURE', detailsUrl: 'https://x.test/run/1' }),
      checkRun({ name: 'lint', status: 'COMPLETED', conclusion: 'SUCCESS' }),
      checkRun({ name: 'unit', status: 'COMPLETED', conclusion: 'SUCCESS' }),
    ]);
    expect(checks?.state).toBe('failing');
    expect(checks?.failed).toBe(1);
    expect(checks?.failing).toEqual([{ name: 'build', url: 'https://x.test/run/1' }]);
    expect(checks?.failedShown).toBe(1);
  });

  it('one FAILURE beside one IN_PROGRESS → failing (precedence over pending)', () => {
    const checks = normalizeChecks([
      checkRun({ name: 'build', status: 'COMPLETED', conclusion: 'FAILURE' }),
      checkRun({ name: 'e2e', status: 'IN_PROGRESS', conclusion: null }),
    ]);
    expect(checks?.state).toBe('failing');
    expect(checks?.failed).toBe(1);
    expect(checks?.pending).toBe(1);
  });

  it('one IN_PROGRESS beside one SUCCESS → pending', () => {
    const checks = normalizeChecks([
      checkRun({ name: 'build', status: 'IN_PROGRESS', conclusion: null }),
      checkRun({ name: 'lint', status: 'COMPLETED', conclusion: 'SUCCESS' }),
    ]);
    expect(checks?.state).toBe('pending');
    expect(checks?.pending).toBe(1);
    expect(checks?.passed).toBe(1);
  });

  it('[] is "no checks"; undefined is "gh did not say"', () => {
    expect(normalizeChecks([])).toEqual({
      state: 'none',
      total: 0,
      passed: 0,
      failed: 0,
      pending: 0,
      failing: [],
      failedShown: 0,
    });
    expect(normalizeChecks(undefined)).toBeNull();
    expect(normalizeChecks(null)).toBeNull();
    expect(normalizeChecks('nope')).toBeNull();
  });

  it('a COMPLETED run with an unrecognised conclusion counts pending, never passed', () => {
    const checks = normalizeChecks([
      checkRun({ name: 'mystery', status: 'COMPLETED', conclusion: 'SOMETHING_NEW' }),
    ]);
    expect(checks?.state).toBe('pending');
    expect(checks?.passed).toBe(0);
    expect(checks?.pending).toBe(1);
  });

  it('a COMPLETED run with a null conclusion counts pending', () => {
    expect(normalizeChecks([checkRun({ name: 'x', status: 'COMPLETED', conclusion: null })])?.state).toBe(
      'pending',
    );
  });

  it('a StatusContext uses context as the name and targetUrl as the url', () => {
    const checks = normalizeChecks([
      statusContext({ context: 'ci/legacy', state: 'FAILURE', targetUrl: 'https://x.test/legacy' }),
    ]);
    expect(checks?.state).toBe('failing');
    expect(checks?.failing).toEqual([{ name: 'ci/legacy', url: 'https://x.test/legacy' }]);
  });

  it('12 failures cap at 10 in the list while failed stays 12', () => {
    const rollup = Array.from({ length: 12 }, (_, i) =>
      checkRun({ name: `job-${i}`, status: 'COMPLETED', conclusion: 'FAILURE' }),
    );
    const checks = normalizeChecks(rollup);
    expect(checks?.failed).toBe(12);
    expect(checks?.failing).toHaveLength(10);
    expect(checks?.failedShown).toBe(10);
  });

  it('a 400-character name is truncated to 120', () => {
    const checks = normalizeChecks([
      checkRun({ name: 'x'.repeat(400), status: 'COMPLETED', conclusion: 'FAILURE' }),
    ]);
    expect(checks?.failing[0]?.name).toHaveLength(120);
  });

  it('falls back to workflowName and then "check" for a nameless node', () => {
    const withWf = normalizeChecks([
      checkRun({ status: 'COMPLETED', conclusion: 'FAILURE', workflowName: 'CI' }),
    ]);
    expect(withWf?.failing).toEqual([{ name: 'CI', url: null }]);
    const nameless = normalizeChecks([
      checkRun({ status: 'COMPLETED', conclusion: 'FAILURE' }),
    ]);
    expect(nameless?.failing).toEqual([{ name: 'check', url: null }]);
  });

  it('counts a non-object element as one pending check', () => {
    const checks = normalizeChecks(['nope', 7]);
    expect(checks?.state).toBe('pending');
    expect(checks?.total).toBe(2);
    expect(checks?.pending).toBe(2);
  });
});

describe('normalizeMergeBlock', () => {
  it('maps the merge-state tokens', () => {
    expect(normalizeMergeBlock(undefined, 'BLOCKED')).toBe('blocked');
    expect(normalizeMergeBlock(undefined, 'BEHIND')).toBe('behind');
    expect(normalizeMergeBlock(undefined, 'DIRTY')).toBe('dirty');
    expect(normalizeMergeBlock(undefined, 'UNSTABLE')).toBe('unstable');
    expect(normalizeMergeBlock(undefined, 'DRAFT')).toBe('draft');
    expect(normalizeMergeBlock(undefined, 'HAS_HOOKS')).toBe('has_hooks');
    expect(normalizeMergeBlock('MERGEABLE', 'CLEAN')).toBe('clean');
  });

  it('falls back to mergeable for UNKNOWN or unrecognised tokens', () => {
    expect(normalizeMergeBlock('MERGEABLE', 'UNKNOWN')).toBe('unknown');
    expect(normalizeMergeBlock('CONFLICTING', 'UNKNOWN')).toBe('dirty');
    expect(normalizeMergeBlock(undefined, undefined)).toBe('unknown');
    expect(normalizeMergeBlock('MERGEABLE', 'SOMETHING_NEW')).toBe('unknown');
  });

  it('MERGEABLE alone is not clean — the trees merge, the rules were not asked', () => {
    expect(normalizeMergeBlock('MERGEABLE', undefined)).toBe('unknown');
  });
});
