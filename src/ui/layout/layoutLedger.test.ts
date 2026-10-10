import { describe, expect, it } from 'vitest';
import { failureKey, type LayoutFailure } from './layoutChecks.js';
import { isFullRun, matchLedger, prune, runKey, seed } from './layoutLedger.js';

const failure = (selector: string, route = 'agents#agents/roles', width = 700): LayoutFailure => ({
  route, width, check: 'containment', selector, rects: [], detail: 'x',
});
const ran = (...pairs: Array<[string, number]>) => new Set(pairs.map(([r, w]) => runKey(r, w)));
const DOCKER = { authoritative: true, fullRun: true };

describe('matchLedger', () => {
  const r = ran(['agents#agents/roles', 700]);
  it('fails on a failure the ledger does not list', () => {
    const m = matchLedger([failure('a')], [], r);
    expect(m.unexpected).toHaveLength(1);
    expect(m.stale).toEqual([]);
  });
  it('fails on a stale entry for a route that ran', () => {
    expect(matchLedger([], [failureKey(failure('gone'))], r).stale).toEqual([failureKey(failure('gone'))]);
  });
  it('passes when the ledger matches exactly', () => {
    expect(matchLedger([failure('a')], [failureKey(failure('a'))], r)).toEqual({ unexpected: [], stale: [] });
  });
  it('does not report other routes or widths stale on a partial run', () => {
    const other = failureKey(failure('x', 'general', 700));
    const otherWidth = failureKey(failure('x', 'agents#agents/roles', 480));
    expect(matchLedger([], [other, otherWidth], r).stale).toEqual([]);
  });
  it('parses the run key when the selector contains a pipe', () => {
    const key = failureKey(failure('a | b'));
    expect(matchLedger([], [key], r).stale).toEqual([key]);
  });
});

describe('isFullRun', () => {
  it('needs every expected route x width', () => {
    const expected = [runKey('a', 1), runKey('b', 1)];
    expect(isFullRun(ran(['a', 1], ['b', 1]), expected)).toBe(true);
    expect(isFullRun(ran(['a', 1]), expected)).toBe(false);
  });
});

describe('seed', () => {
  it('writes exactly the current failures, sorted and unique', () => {
    expect(seed([failure('b'), failure('a'), failure('a')], null, DOCKER)).toEqual(
      [failureKey(failure('a')), failureKey(failure('b'))],
    );
  });
  it('is refused without KARST_LAYOUT_AUTHORITATIVE', () => {
    expect(() => seed([], null, { ...DOCKER, authoritative: false })).toThrow(/test:layout:docker:seed/);
  });
  it('is refused when the ledger exists', () => {
    expect(() => seed([], [], DOCKER)).toThrow(/already exists/);
  });
  it('is refused on a partial run', () => {
    expect(() => seed([], null, { ...DOCKER, fullRun: false })).toThrow(/filtered/);
  });
});

describe('prune', () => {
  const r = ran(['agents#agents/roles', 700]);
  it('removes stale entries only', () => {
    const keep = failureKey(failure('keep'));
    const gone = failureKey(failure('gone'));
    expect(prune([failure('keep')], [keep, gone], r, DOCKER)).toEqual([keep]);
  });
  it('never adds a new failure', () => {
    expect(prune([failure('new')], [], r, DOCKER)).toEqual([]);
  });
  it('keeps entries of routes that did not run', () => {
    const other = failureKey(failure('x', 'general', 700));
    expect(prune([], [other], r, DOCKER)).toEqual([other]);
  });
  it('is refused without KARST_LAYOUT_AUTHORITATIVE', () => {
    expect(() => prune([], [], r, { ...DOCKER, authoritative: false })).toThrow(/test:layout:docker:prune/);
  });
  it('is refused on a partial run', () => {
    expect(() => prune([], [], r, { ...DOCKER, fullRun: false })).toThrow(/filtered/);
  });
});
