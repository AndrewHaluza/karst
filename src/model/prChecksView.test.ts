import { describe, it, expect } from 'vitest';
import { buildPrChecksView, mergeBlockNotice, STALE_CHECKS_MAX_AGE_MS } from './prChecksView.js';
import type { MergeBlock, PrChecks } from './prChecks.js';

function checks(over: Partial<PrChecks> = {}): PrChecks {
  return {
    state: 'passing',
    total: 3,
    passed: 3,
    failed: 0,
    pending: 0,
    failing: [],
    failedShown: 0,
    ...over,
  };
}

const NOTHING = { label: '', title: '', detailsLabel: '', failing: [], stale: false, cue: '' };

describe('buildPrChecksView', () => {
  it('states nothing for a never-probed PR', () => {
    expect(buildPrChecksView(null)).toEqual({ state: 'none', ...NOTHING });
  });

  it('states nothing for a PR with no CI at all', () => {
    expect(buildPrChecksView(checks({ state: 'none', total: 0, passed: 0 }))).toEqual({
      state: 'none',
      ...NOTHING,
    });
  });

  it('states nothing for an unknown rollup', () => {
    expect(buildPrChecksView(checks({ state: 'unknown' }))).toEqual({ state: 'none', ...NOTHING });
  });

  it('summarizes a passing rollup and opens no disclosure', () => {
    const view = buildPrChecksView(checks());
    expect(view.state).toBe('passing');
    expect(view.label).toBe('3 passed');
    expect(view.detailsLabel).toBe('');
    expect(view.failing).toEqual([]);
    expect(view.title).toBe('3 checks: 3 passed, 0 failed, 0 pending');
  });

  it('leads with failures and opens the disclosure', () => {
    const failing = [{ name: 'build', url: 'https://x.test/run/1' }];
    const view = buildPrChecksView(
      checks({ state: 'failing', total: 3, passed: 2, failed: 1, failing, failedShown: 1 }),
    );
    expect(view.label).toBe('1 failing · 2 passed');
    expect(view.detailsLabel).toBe('1 failing check');
    expect(view.failing).toEqual(failing);
  });

  it('pluralizes the disclosure summary from the failure count', () => {
    const view = buildPrChecksView(
      checks({ state: 'failing', total: 2, passed: 0, failed: 2, failing: [], failedShown: 2 }),
    );
    expect(view.detailsLabel).toBe('2 failing checks');
  });

  it('names both numbers when more failed than the list carries', () => {
    const view = buildPrChecksView(
      checks({ state: 'failing', total: 12, passed: 0, failed: 12, failing: [], failedShown: 10 }),
    );
    expect(view.detailsLabel).toBe('12 failing checks — first 10 shown');
  });

  it('reads a running rollup as pending', () => {
    const view = buildPrChecksView(checks({ state: 'pending', total: 2, passed: 1, pending: 1 }));
    expect(view.state).toBe('pending');
    expect(view.label).toBe('1 pending · 1 passed');
  });

  it('uses the singular for a one-check rollup title', () => {
    expect(buildPrChecksView(checks({ total: 1, passed: 1 })).title).toBe(
      '1 check: 1 passed, 0 failed, 0 pending',
    );
  });
});

describe('mergeBlockNotice', () => {
  const VALUES: MergeBlock[] = [
    'clean', 'blocked', 'behind', 'dirty', 'unstable', 'draft', 'has_hooks', 'unknown',
  ];

  it('refuses exactly blocked, behind and dirty, and words each refusal', () => {
    expect(mergeBlockNotice('blocked')).toEqual({
      blocks: true,
      label: 'blocked',
      reason: 'GitHub is blocking this merge — a required review or check has not passed.',
    });
    expect(mergeBlockNotice('dirty')).toEqual({
      blocks: true,
      label: 'conflicts',
      reason: 'GitHub reports conflicts on this branch — they must be resolved before it can merge.',
    });
  });

  it('never blocks on a verdict GitHub did not refuse', () => {
    for (const block of VALUES) {
      const notice = mergeBlockNotice(block);
      expect(notice.label !== '').toBe(notice.blocks);
      expect(notice.reason !== '').toBe(notice.blocks);
    }
    // BEHIND is out-of-date, not a refusal: GitHub still merges it unless the
    // repository requires branches to be up to date, which this probe cannot see.
    expect(mergeBlockNotice('behind').blocks).toBe(false);
    expect(mergeBlockNotice('unstable').blocks).toBe(false);
    expect(mergeBlockNotice('has_hooks').blocks).toBe(false);
    expect(mergeBlockNotice('clean').blocks).toBe(false);
    expect(mergeBlockNotice('draft').blocks).toBe(false);
    expect(mergeBlockNotice('unknown').blocks).toBe(false);
  });
});

describe('buildPrChecksView — last known snapshot (stale chip)', () => {
  const NOW = 1_700_000_000_000;
  const snap = (over: { at?: number; head?: string | null; checks?: Partial<PrChecks> } = {}) => ({
    checks: checks({ state: 'failing', total: 3, passed: 2, failed: 1, failing: [{ name: 'unit', url: null }], failedShown: 1, ...over.checks }),
    head: over.head === undefined ? 'abc1234def' : over.head,
    at: over.at ?? NOW - 60_000,
  });

  it('prefers the current rollup when it has checks, and is not stale', () => {
    const view = buildPrChecksView(checks({ state: 'pending', total: 2, passed: 1, pending: 1 }), snap(), NOW);
    expect(view.label).toBe('1 pending · 1 passed');
    expect(view.stale).toBe(false);
    expect(view.cue).toBe('');
  });

  it.each([
    ['null', null],
    ['none', checks({ state: 'none', total: 0, passed: 0 })],
    ['unknown', checks({ state: 'unknown' })],
  ])('shows the snapshot as stale when the current rollup is %s', (_n, current) => {
    const view = buildPrChecksView(current, snap(), NOW);
    expect(view.stale).toBe(true);
    expect(view.state).toBe('failing');
    expect(view.label).toBe('1 failing · 2 passed');
    expect(view.cue).toBe('checking new commit…');
    expect(view.title).toContain('previous commit abc1234');
  });

  it('never feeds the disclosure from a stale snapshot', () => {
    const view = buildPrChecksView(null, snap(), NOW);
    expect(view.failing).toEqual([]);
    expect(view.detailsLabel).toBe('');
  });

  it('words the tooltip without a sha when the head is unknown', () => {
    const view = buildPrChecksView(null, snap({ head: null }), NOW);
    expect(view.title).toContain('previous commit');
    expect(view.title).not.toContain('null');
  });

  it('shows nothing once the snapshot is older than the limit', () => {
    expect(buildPrChecksView(null, snap({ at: NOW - STALE_CHECKS_MAX_AGE_MS - 1 }), NOW)).toEqual({ state: 'none', ...NOTHING });
  });

  it('still shows a snapshot exactly at the limit', () => {
    expect(buildPrChecksView(null, snap({ at: NOW - STALE_CHECKS_MAX_AGE_MS }), NOW).stale).toBe(true);
  });

  it('shows nothing when the PR never had checks', () => {
    expect(buildPrChecksView(null, null, NOW)).toEqual({ state: 'none', ...NOTHING });
  });
});
