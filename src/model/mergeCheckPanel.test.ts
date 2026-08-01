import { describe, it, expect } from 'vitest';
import type { MergeCheckRow } from '../store/mergeChecks.js';
import { formatPrStamp } from './prPanelView.js';
import { buildMergeCheckPanelRows } from './mergeCheckPanel.js';
// Import only — `mergeCheckView.ts` must not be modified by this plan.
import { summarizeMergeCheck } from './mergeCheckView.js';

const NOW = '2026-08-01T12:00:00.000Z';

/** A row with every field present; each test overrides only what it is about. */
function row(over: Partial<MergeCheckRow> = {}): MergeCheckRow {
  return {
    ticketId: 1,
    repo: '/repos/api',
    state: 'clean',
    files: [],
    reason: null,
    headSha: 'h',
    baseSha: 'b',
    baseRef: 'develop',
    checkedAt: '2026-08-01T11:56:00.000Z', // 4 minutes before NOW
    ...over,
  };
}

describe('buildMergeCheckPanelRows', () => {
  it('words a clean check as state, base ref and age', () => {
    const [out] = buildMergeCheckPanelRows([row()], NOW);
    expect(out!.headline).toBe('clean · vs develop · 4m ago');
    // Nothing to open: a clean check has no body.
    expect(out!.detailsLabel).toBe('');
    expect(out!.files).toEqual([]);
    expect(out!.reason).toBe('');
  });

  it('puts the conflict count on the line and the paths in the body', () => {
    const [out] = buildMergeCheckPanelRows(
      [row({ state: 'conflicted', files: ['CLAUDE.md', 'src/a.ts', 'src/b.ts', 'src/c.ts'] })],
      NOW,
    );
    expect(out!.headline).toBe('conflicted · 4 files · vs develop · 4m ago');
    expect(out!.detailsLabel).toBe('4 conflicting files');
    // Uncapped: the disclosure is collapsed and scroll-capped, so the panel
    // lists every path rather than the five the one-line summarizer allows.
    expect(out!.files).toEqual(['CLAUDE.md', 'src/a.ts', 'src/b.ts', 'src/c.ts']);
  });

  it('says file, not files, for a single conflict', () => {
    const [out] = buildMergeCheckPanelRows([row({ state: 'conflicted', files: ['a.ts'] })], NOW);
    expect(out!.headline).toBe('conflicted · 1 file · vs develop · 4m ago');
    expect(out!.detailsLabel).toBe('1 conflicting file');
  });

  it('keeps the conflicted verdict when the file list came back empty', () => {
    // The verdict came from an exit code; only the list came from parsing output.
    // A parsing surprise drops the count and the body — never the verdict.
    const [out] = buildMergeCheckPanelRows([row({ state: 'conflicted', files: [] })], NOW);
    expect(out!.headline).toBe('conflicted · vs develop · 4m ago');
    expect(out!.detailsLabel).toBe('');
  });

  it('routes git\'s own words to the body and never to the headline', () => {
    // Unbounded prose in a one-line slot is the defect this replaces.
    const prose = 'fatal: not a valid object name develop';
    const [out] = buildMergeCheckPanelRows([row({ state: 'unknown', reason: prose })], NOW);
    expect(out!.headline).toBe('unknown · vs develop · 4m ago');
    expect(out!.detailsLabel).toBe('why karst could not tell');
    expect(out!.reason).toBe(prose);
  });

  it('opens no disclosure for an unknown check that carries no reason', () => {
    const [out] = buildMergeCheckPanelRows([row({ state: 'unknown', reason: null })], NOW);
    expect(out!.headline).toBe('unknown · vs develop · 4m ago');
    expect(out!.detailsLabel).toBe('');
    expect(out!.reason).toBe('');
  });

  it('drops the base ref from the line when none was recorded', () => {
    const [out] = buildMergeCheckPanelRows([row({ baseRef: null })], NOW);
    expect(out!.headline).toBe('clean · 4m ago');
  });

  it('reports age in coarse buckets', () => {
    const at = (iso: string) => buildMergeCheckPanelRows([row({ checkedAt: iso })], NOW)[0]!.headline;
    expect(at('2026-08-01T11:59:30.000Z')).toBe('clean · vs develop · just now');
    expect(at('2026-08-01T11:20:00.000Z')).toBe('clean · vs develop · 40m ago');
    expect(at('2026-08-01T09:00:00.000Z')).toBe('clean · vs develop · 3h ago');
    expect(at('2026-07-29T12:00:00.000Z')).toBe('clean · vs develop · 3d ago');
  });

  it('states no age at all rather than a wrong one', () => {
    // Unparseable, and a stamp in the future (clock skew): both are facts karst
    // does not have, and an absent part renders as nothing.
    expect(buildMergeCheckPanelRows([row({ checkedAt: 'nonsense' })], NOW)[0]!.headline)
      .toBe('clean · vs develop');
    expect(buildMergeCheckPanelRows([row({ checkedAt: '2026-08-02T12:00:00.000Z' })], NOW)[0]!.headline)
      .toBe('clean · vs develop');
  });

  it('carries the absolute stamp for the tooltip, and none for a bad one', () => {
    const iso = '2026-08-01T11:56:00.000Z';
    // Computed the same way the PR rows compute theirs, so the assertion holds
    // in any locale the suite runs under.
    expect(buildMergeCheckPanelRows([row({ checkedAt: iso })], NOW)[0]!.checkedTitle)
      .toBe(formatPrStamp(iso));
    expect(buildMergeCheckPanelRows([row({ checkedAt: 'nonsense' })], NOW)[0]!.checkedTitle).toBe('');
  });

  it('carries the repo path and state through untouched, one row per check', () => {
    // `repo` is the row's identity — the value a Resolve click sends back — and
    // `state` drives the dot and whether that button is offered at all.
    const out = buildMergeCheckPanelRows([row({ repo: '/repos/api' }), row({ repo: '/repos/web', state: 'conflicted', files: ['x'] })], NOW);
    expect(out.map((r) => r.repo)).toEqual(['/repos/api', '/repos/web']);
    expect(out.map((r) => r.state)).toEqual(['clean', 'conflicted']);
  });

  // Drift guard, not a redundant assertion: this panel and `mergeCheckView.ts`
  // (the shared one-liner for the ship strip and the `karst context` CLI) each
  // independently word `check.state`. Both read the same field today, so they
  // cannot drift *now* — but nothing stops a future vocabulary rename (e.g.
  // `conflicted` -> `cannot merge`) from landing in one and not the other, which
  // is exactly the drift `mergeCheckView.ts`'s own docstring says sharing it is
  // meant to prevent. This test pins the two renderers' opening word together
  // without merging the modules, which stay deliberately separate (see both
  // docstrings): the panel has room for a second line and says more; the shared
  // one-liner does not.
  it.each(['clean', 'conflicted', 'unknown'] as const)(
    'opens with the same state word as the shared one-liner for %s',
    (state) => {
      const files = state === 'conflicted' ? ['a.ts'] : [];
      const reason = state === 'unknown' ? 'fatal: not a valid object name develop' : null;

      const panelWord = buildMergeCheckPanelRows([row({ state, files, reason })], NOW)[0]!.headline
        .split(' · ')[0];
      const viewWord = summarizeMergeCheck({ state, files, reason }).split(' ')[0];

      expect(panelWord).toBe(viewWord);
    },
  );
});
