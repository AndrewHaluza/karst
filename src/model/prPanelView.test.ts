import { describe, it, expect } from 'vitest';
import type { PrView } from '../store/dashboard.js';
import { buildPrPanelRows, formatPrStamp } from './prPanelView.js';

const pr = (over: Partial<PrView> = {}): PrView => ({
  id: 1,
  ticketId: 1,
  repo: '/Users/nd/Work/projects/karst',
  repoDisplay: './karst',
  number: 12,
  url: 'https://github.com/o/r/pull/12',
  status: 'open',
  headRef: 'karst/feat/ship',
  baseRef: 'develop',
  createdAt: '2026-07-23T08:55:00Z',
  mergedAt: null,
  comments: [],
  ...over,
});

/** A fixed clock: the fixture's createdAt (2026-07-23) is ~1.6 days old. */
const NOW = '2026-07-25T00:00:00Z';
const rows = (over: Partial<PrView> = {}, repoNameFor?: (repo: string) => string | undefined) =>
  buildPrPanelRows([pr(over)], NOW, repoNameFor);

describe('formatPrStamp', () => {
  it('renders a stamp the reader can place in time', () => {
    const out = formatPrStamp('2026-07-23T08:55:00Z');
    expect(out).not.toBe('');
    expect(out).toContain('2026');
  });

  it('is empty for an absent or unparseable stamp — never "Invalid Date"', () => {
    expect(formatPrStamp(null)).toBe('');
    expect(formatPrStamp(undefined)).toBe('');
    expect(formatPrStamp('')).toBe('');
    expect(formatPrStamp('not a date')).toBe('');
  });
});

describe('buildPrPanelRows', () => {
  it('renders from-to branches, the opened stamp, and offers merge on an open PR', () => {
    const [row] = rows();
    expect(row!.branches).toBe('karst/feat/ship → develop');
    expect(row!.opened).toMatch(/^opened /);
    expect(row!.merged).toBe('');
    expect(row!.canMerge).toBe(true);
    expect(row!.mergeBlockedReason).toBe('');
  });

  it('renders the merge stamp once the PR is merged, and stops offering merge', () => {
    const [row] = rows({ status: 'merged', mergedAt: '2026-07-28T09:30:00Z' });
    expect(row!.merged).toMatch(/^merged /);
    expect(row!.canMerge).toBe(false);
    expect(row!.mergeBlockedReason).toBe('');
  });

  it('carries the display path, never a second format of its own', () => {
    // The path-display preference is resolved upstream (repoDisplayPath); this
    // must pass it through, so a relative-mode dashboard cannot show one repo
    // absolute in the ship stage and relative in the worktree panel.
    const [row] = rows({ repoDisplay: './karst' });
    expect(row!.repoDisplay).toBe('./karst');
    expect(row!.repo).toBe('/Users/nd/Work/projects/karst'); // identity, for messages
  });

  it('prefers the manifest repo NAME over the display path, like the inside rows', () => {
    const [row] = rows({}, (repo) => (repo === '/Users/nd/Work/projects/karst' ? 'Karst-extention' : undefined));
    expect(row!.repoDisplay).toBe('Karst-extention');
    // Unknown repos fall back to the display path, never to a placeholder.
    const [unknown] = rows({});
    expect(unknown!.repoDisplay).toBe('./karst');
  });

  it('counts comments, singular and plural, and renders each one', () => {
    const [one] = rows({
      comments: [{ author: 'ada', at: '2026-07-24T10:00:00Z', body: 'lgtm' }],
    });
    expect(one!.commentsLabel).toBe('1 comment');
    expect(one!.comments).toEqual([
      { author: 'ada', when: formatPrStamp('2026-07-24T10:00:00Z'), body: 'lgtm' },
    ]);

    const [two] = rows({
      comments: [{ author: 'a', at: null, body: 'x' }, { author: 'b', at: null, body: 'y' }],
    });
    expect(two!.commentsLabel).toBe('2 comments');
  });

  // Degrade, never blank: a PR karst has not managed to probe yet renders with the
  // fields it has and nothing where it has none.
  it('renders cleanly when every metadata field is missing', () => {
    const [row] = rows({ headRef: null, baseRef: null, createdAt: null, mergedAt: null, comments: [] });
    expect(row!.branches).toBe('');
    expect(row!.opened).toBe('');
    expect(row!.openedTitle).toBe('');
    expect(row!.merged).toBe('');
    expect(row!.mergedTitle).toBe('');
    expect(row!.commentsLabel).toBe('');
    expect(row!.comments).toEqual([]);
  });

  it('names one branch when only one is known, rather than an arrow to nowhere', () => {
    expect(rows({ baseRef: null })[0]!.branches).toBe('karst/feat/ship');
    expect(rows({ headRef: null })[0]!.branches).toBe('→ develop');
  });

  it('renders a comment with no author or stamp without inventing either', () => {
    const [row] = rows({ comments: [{ author: '', at: null, body: 'anon' }] });
    expect(row!.comments).toEqual([{ author: '', when: '', body: 'anon' }]);
  });

  // The adaptive stamp (best-practice timestamps): relative while fresh, an
  // absolute date past a week, and the FULL locale stamp preserved in the title.
  it('shows a relative age for a fresh stamp, with the full stamp in the title', () => {
    const [row] = rows(); // createdAt 2026-07-23, now 2026-07-25
    expect(row!.opened).toBe('opened 1d ago');
    expect(row!.openedTitle).toBe(`opened ${formatPrStamp('2026-07-23T08:55:00Z')}`);
  });

  it('shows an absolute date once a stamp is a week old', () => {
    const [row] = rows({ createdAt: '2026-07-10T00:00:00Z' });
    expect(row!.opened).toBe('opened 7/10/2026');
    expect(row!.openedTitle).toBe(`opened ${formatPrStamp('2026-07-10T00:00:00Z')}`);
  });

  it('falls back to the absolute date for a stamp in the future (clock skew)', () => {
    const [row] = rows({ mergedAt: '2026-07-28T09:30:00Z' });
    expect(row!.merged).toBe('merged 7/28/2026');
    expect(row!.mergedTitle).toBe(`merged ${formatPrStamp('2026-07-28T09:30:00Z')}`);
  });

  // A draft or closed PR is not mergeable, and the button must say why rather
  // than firing a command gh will refuse.
  it('refuses to offer merge for a draft, a closed PR, or a PR with no url', () => {
    const draft = rows({ status: 'draft' })[0]!;
    expect(draft.canMerge).toBe(false);
    expect(draft.mergeBlockedReason).toMatch(/draft/i);

    const closed = rows({ status: 'closed' })[0]!;
    expect(closed.canMerge).toBe(false);
    expect(closed.mergeBlockedReason).toMatch(/closed/i);

    const noUrl = rows({ url: null })[0]!;
    expect(noUrl.canMerge).toBe(false);
    expect(noUrl.mergeBlockedReason).toMatch(/no pull request url/i);
  });

  // 'unknown' means karst could not read the PR's state. Offering an irreversible
  // merge on a PR whose state is unknown is exactly the guess to avoid.
  it('does not offer merge on a PR whose state is unknown', () => {
    const row = rows({ status: 'unknown' })[0]!;
    expect(row.canMerge).toBe(false);
    expect(row.mergeBlockedReason).toMatch(/state/i);
  });

  it('renders the status label as-is and falls back to unknown for a missing one', () => {
    expect(rows({ status: null })[0]!.status).toBe('unknown');
  });
});
