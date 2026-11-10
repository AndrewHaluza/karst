import { describe, expect, it } from 'vitest';
import type { MergeCheckRow } from '../store/mergeChecks.js';
import type { PrChecks } from './prChecks.js';
import {
  blockingCount,
  blockingReasonsTitle,
  NO_AUTOFIX,
  NO_OFFERS,
  prMergeReadiness,
  type AutofixInput,
  type ReadinessOffers,
  type ReadinessPr,
} from './prMergeReadiness.js';

const NOW = '2026-11-10T12:00:00Z';
const URL = 'https://github.com/o/r/pull/7';

const passing: PrChecks = { state: 'passing', total: 4, passed: 4, failed: 0, pending: 0, failing: [], failedShown: 0 };

function pr(over: Partial<ReadinessPr> = {}): ReadinessPr {
  return {
    repo: 'api',
    url: URL,
    status: 'open',
    baseRef: 'develop',
    canMerge: false,
    mergeBlock: 'unknown',
    checks: passing,
    reviewDecision: null,
    approvals: null,
    requiredApprovals: null,
    reviewRequests: [],
    ...over,
  };
}

function check(over: Partial<MergeCheckRow> = {}): MergeCheckRow {
  return {
    ticketId: 1,
    repo: 'api',
    state: 'clean',
    files: [],
    reason: null,
    headSha: null,
    baseSha: null,
    baseRef: 'develop',
    checkedAt: '2026-11-10T11:00:00Z',
    ...over,
  };
}

const offers: ReadinessOffers = { ciRepos: ['api'], ciAvailable: true, rebaseAvailable: true, feedbackAvailable: true };
const read = (p: ReadinessPr, m?: MergeCheckRow, o: ReadinessOffers = NO_OFFERS, a: AutofixInput = NO_AUTOFIX) =>
  prMergeReadiness(p, m, o, a, NOW);
const of = (kind: string, r: ReturnType<typeof read>) => r.reasons.find((x) => x.kind === kind)!;
const kinds = (p: ReadinessPr, m?: MergeCheckRow, o: ReadinessOffers = NO_OFFERS, a: AutofixInput = NO_AUTOFIX) =>
  read(p, m, o, a).reasons.map((r) => `${r.kind}:${r.state}`);

const failing: PrChecks = {
  state: 'failing',
  total: 5,
  passed: 2,
  failed: 2,
  pending: 1,
  failing: [
    { name: 'unit', url: 'https://ci/1', required: true },
    { name: 'lint', url: null, required: false },
  ],
  failedShown: 2,
  required: { total: 3, failed: 1, pending: 0 },
};

describe('prMergeReadiness', () => {
  it('reads a merged or closed PR as having no reasons', () => {
    expect(read(pr({ status: 'merged' })).reasons).toEqual([]);
    expect(read(pr({ status: 'closed' })).ready).toBe(false);
  });

  it('is ready when canMerge, with the facts line', () => {
    const r = read(pr({ canMerge: true, mergeBlock: 'clean', reviewDecision: 'APPROVED' }), check());
    expect(r.ready).toBe(true);
    expect(r.headline).toBe('Ready to merge');
    expect(r.facts).toBe('approved · 4 checks passed · GitHub: clean · karst: no conflicts vs develop, checked 1h ago');
    expect(r.reasons).toEqual([]);
  });

  it.each(['unknown', 'unstable', 'has_hooks'] as const)('never claims GitHub clean or ready when GitHub answered %s', (mergeBlock) => {
    const r = read(pr({ canMerge: true, mergeBlock }), check());
    expect(r.ready).toBe(false);
    expect(r.headline).toBe('Merge not confirmed');
    expect(r.facts).not.toContain('clean');
  });

  it('names optional checks when the required split has no failed required check', () => {
    const c = { ...failing, failed: 1, failing: [{ name: 'lint', url: null, required: false }], failedShown: 1, required: { total: 3, failed: 0, pending: 0 } };
    const r = read(pr({ checks: c })).reasons.find((x) => x.kind === 'checks')!;
    expect(r.label).toBe('Optional checks failing');
    expect(r.detail).toBe('1 optional check failing');
  });

  it('keeps the reasons and actions when GitHub says behind or unstable while canMerge', () => {
    const behind = read(pr({ canMerge: true, mergeBlock: 'behind' }), check(), { ...NO_OFFERS, rebaseAvailable: true });
    expect(behind.ready).toBe(false);
    expect(behind.reasons.map((r) => r.kind)).toContain('behind');
    expect(behind.reasons.find((r) => r.kind === 'behind')!.action).toMatchObject({ act: 'rebase-on-base' });
    const unstable = read(pr({ canMerge: true, mergeBlock: 'unstable', checks: failing }));
    expect(unstable.ready).toBe(false);
    expect(unstable.reasons.some((r) => r.kind === 'checks' && r.state === 'bad')).toBe(true);
  });

  it('omits the karst clause without a clean check', () => {
    expect(read(pr({ canMerge: true, mergeBlock: 'clean', reviewDecision: 'APPROVED' })).facts).toBe('approved · 4 checks passed · GitHub: clean');
    expect(read(pr({ canMerge: true, mergeBlock: 'clean' }), check({ state: 'unknown' })).facts).toBe('no review required · 4 checks passed · GitHub: clean');
  });

  it('draft is a bad reason with an Open action', () => {
    const r = read(pr({ status: 'draft' })).reasons[0]!;
    expect(r).toMatchObject({ kind: 'draft', state: 'bad', label: 'Draft', action: { act: 'open-pr', label: 'Open on GitHub', url: URL } });
  });

  it('draft without a url has no action', () => {
    expect(read(pr({ status: 'draft', url: null })).reasons[0]!.action).toBeUndefined();
  });

  it('changes requested offers address-pr-feedback, else open-pr', () => {
    const p = pr({ reviewDecision: 'CHANGES_REQUESTED' });
    expect(read(p, undefined, offers).reasons[0]).toMatchObject({ label: 'Changes requested', state: 'bad', action: { act: 'address-pr-feedback' } });
    expect(read(p).reasons[0]!.action?.act).toBe('open-pr');
  });

  it('review required words the approval count or the requested names', () => {
    expect(read(pr({ reviewDecision: 'REVIEW_REQUIRED', approvals: 1, requiredApprovals: 2 })).reasons[0]!.detail).toBe('1 of 2 approving reviews');
    expect(read(pr({ reviewDecision: 'REVIEW_REQUIRED', requiredApprovals: 2 })).reasons[0]!.detail).toBe('0 of 2 approving reviews');
    expect(read(pr({ reviewDecision: 'REVIEW_REQUIRED', reviewRequests: ['ann', 'bo'] })).reasons[0]!.detail).toBe('requested from ann, bo');
    expect(read(pr({ reviewDecision: 'REVIEW_REQUIRED' })).reasons[0]!.detail).toBe('an approving review is required');
    expect(read(pr({ reviewDecision: 'REVIEW_REQUIRED' })).reasons[0]!.action?.act).toBe('open-pr');
  });

  it('shows an approval only beside a problem', () => {
    const approved = pr({ reviewDecision: 'APPROVED', approvals: 2 });
    expect(read(approved).reasons).toEqual([]);
    const withProblem = read({ ...approved, checks: failing });
    expect(withProblem.reasons[0]).toMatchObject({ kind: 'review', state: 'ok', label: 'Approved', detail: '2 approving reviews' });
    expect(read({ ...approved, approvals: null, checks: failing }).reasons[0]!.detail).toBe('by a reviewer');
  });

  it('failing required checks: split, list, and the send action', () => {
    const r = read(pr({ checks: failing }), undefined, offers).reasons[0]!;
    expect(r).toMatchObject({ kind: 'checks', state: 'bad', label: 'Required checks failing', detail: '1 of 3 required failing · 1 optional pending', action: { act: 'send-ci-failure' } });
    expect(r.list).toEqual([{ text: 'unit', url: 'https://ci/1' }, { text: 'lint' }]);
    expect(r.listNote).toBeUndefined();
  });

  it('failing checks without a split use plain counts', () => {
    const r = read(pr({ checks: { ...failing, required: null } })).reasons[0]!;
    expect(r).toMatchObject({ label: 'Checks failing', detail: '2 checks failing' });
    expect(read(pr({ checks: { ...failing, required: null, failed: 1, failing: [failing.failing[0]!], failedShown: 1 } })).reasons[0]!.detail).toBe('1 check failing');
  });

  it('notes a capped failing list', () => {
    const capped = { ...failing, failed: 12, failedShown: 2 };
    expect(read(pr({ checks: capped })).reasons[0]!.listNote).toBe('— first 2 of 12 shown');
  });

  it('offers Send CI failure only for a listed repo with CI available', () => {
    const p = pr({ checks: failing });
    expect(read(p, undefined, { ...offers, ciRepos: ['web'] }).reasons[0]!.action).toBeUndefined();
    expect(read(p, undefined, { ...offers, ciAvailable: false }).reasons[0]!.action).toBeUndefined();
  });

  it('pending checks run; passing checks are ok', () => {
    const pending: PrChecks = { ...passing, state: 'pending', passed: 1, pending: 3 };
    expect(read(pr({ checks: pending })).reasons[0]).toMatchObject({ kind: 'checks', state: 'run', label: 'Checks running', detail: '3 of 4 pending' });
    expect(kinds(pr({ checks: passing, mergeBlock: 'behind' }))).toEqual(['checks:ok', 'behind:warn']);
  });

  it('no checks reason for none or unknown', () => {
    expect(kinds(pr({ checks: null, mergeBlock: 'behind' }))).toEqual(['behind:warn']);
    expect(kinds(pr({ checks: { ...passing, state: 'none' }, mergeBlock: 'behind' }))).toEqual(['behind:warn']);
    expect(kinds(pr({ checks: { ...passing, state: 'unknown' }, mergeBlock: 'behind' }))).toEqual(['behind:warn']);
  });

  it('conflicts: conflicted, unknown, clean and absent', () => {
    const conflicted = read(pr(), check({ state: 'conflicted', files: ['a.ts', 'b.ts'] }), offers).reasons.find((r) => r.kind === 'conflicts')!;
    expect(conflicted).toMatchObject({ state: 'warn', label: 'Conflicts with develop', detail: '2 files · checked 1h ago', action: { act: 'resolve-conflicts', repo: 'api' } });
    expect(conflicted.list).toEqual([{ text: 'a.ts' }, { text: 'b.ts' }]);
    const one = read(pr(), check({ state: 'conflicted', files: ['a.ts'] })).reasons.find((r) => r.kind === 'conflicts')!;
    expect(one.detail).toBe('1 file · checked 1h ago');
    const unknown = read(pr({ mergeBlock: 'behind' }), check({ state: 'unknown', reason: 'no git' })).reasons.find((r) => r.kind === 'conflicts')!;
    expect(unknown).toMatchObject({ state: 'warn', label: 'Conflicts unknown', disclosure: 'why karst could not tell', why: 'no git' });
    const noReason = read(pr({ mergeBlock: 'behind' }), check({ state: 'unknown' })).reasons.find((r) => r.kind === 'conflicts')!;
    expect(noReason.why).toBeUndefined();
    expect(kinds(pr({ checks: failing }), check())).toContain('conflicts:ok');
    expect(kinds(pr({ checks: failing }))).not.toContain('conflicts:ok');
  });

  it('uses the PR base when the check has none', () => {
    const r = of('conflicts', read(pr(), check({ state: 'conflicted', baseRef: null, files: ['a'] })));
    expect(r.label).toBe('Conflicts with develop');
  });

  it('behind offers rebase only when available', () => {
    const p = pr({ mergeBlock: 'behind' });
    expect(of('behind', read(p, undefined, offers))).toMatchObject({ kind: 'behind', state: 'warn', label: 'Behind develop', action: { act: 'rebase-on-base' } });
    expect(of('behind', read(p)).action).toBeUndefined();
  });

  it('GitHub rule fallback only when nothing else explains the refusal', () => {
    const rule = read(pr({ mergeBlock: 'blocked' }), check()).reasons.find((r) => r.kind === 'github-rule')!;
    expect(rule).toMatchObject({ state: 'bad', label: 'Blocked by a GitHub rule', action: { act: 'open-pr' } });
    expect(rule.detail).toContain('signed commits');
    expect(read(pr({ mergeBlock: 'dirty' })).reasons.some((r) => r.kind === 'github-rule')).toBe(true);
    expect(kinds(pr({ mergeBlock: 'blocked', checks: failing }))).not.toContain('github-rule:bad');
    expect(kinds(pr({ mergeBlock: 'unstable' }))).toEqual([]);
  });

  it('orders reasons draft, review, checks, conflicts, behind', () => {
    const p = pr({ status: 'draft', reviewDecision: 'REVIEW_REQUIRED', checks: failing, mergeBlock: 'behind' });
    expect(kinds(p, check({ state: 'conflicted', files: ['a'] }))).toEqual([
      'draft:bad', 'review:bad', 'checks:bad', 'conflicts:warn', 'behind:warn',
    ]);
  });

  describe('autopilot', () => {
    const running = (kind: 'ci' | 'conflicts', repo: string | null): AutofixInput => ({
      effective: true, running: { kind, repo, round: '2/3' }, parked: null, unknownCi: false,
    });

    it('a running ci round turns the checks reason to run with no action', () => {
      const r = read(pr({ checks: failing }), undefined, offers, running('ci', 'api')).reasons[0]!;
      expect(r).toMatchObject({ state: 'run', detail: 'Auto-fix round 2/3 runs' });
      expect(r.action).toBeUndefined();
      expect(r.list).toHaveLength(2);
    });

    it('a null repo applies to every PR; another repo does not', () => {
      expect(read(pr({ checks: failing }), undefined, offers, running('ci', null)).reasons[0]!.state).toBe('run');
      expect(read(pr({ checks: failing }), undefined, offers, running('ci', 'web')).reasons[0]!.state).toBe('bad');
    });

    it('a running ci round leaves a conflicts reason alone, and the reverse', () => {
      const c = check({ state: 'conflicted', files: ['a'] });
      expect(of('conflicts', read(pr(), c, offers, running('ci', null))).state).toBe('warn');
      const r = of('conflicts', read(pr(), c, offers, running('conflicts', 'api')));
      expect(r).toMatchObject({ state: 'run', detail: 'Auto-fix round 2/3 runs' });
      expect(r.action).toBeUndefined();
    });

    it('a park keeps the action and adds the reason', () => {
      const parked: AutofixInput = { effective: true, running: null, parked: { kind: 'ci', reason: 'auto-fix stopped: ci budget spent' }, unknownCi: false };
      const r = read(pr({ checks: failing }), undefined, offers, parked).reasons[0]!;
      expect(r.action?.act).toBe('send-ci-failure');
      expect(r.extra).toBe('auto-fix stopped: ci budget spent');
      const c = of('conflicts', read(pr(), check({ state: 'conflicted', files: ['a'] }), offers, { ...parked, parked: { kind: 'conflicts', reason: 'stopped' } }));
      expect(c.extra).toBe('stopped');
      expect(c.action?.act).toBe('resolve-conflicts');
    });

    it('a park of the other kind adds nothing', () => {
      const parked: AutofixInput = { effective: true, running: null, parked: { kind: 'conflicts', reason: 'x' }, unknownCi: false };
      expect(read(pr({ checks: failing }), undefined, offers, parked).reasons[0]!.extra).toBeUndefined();
    });

    it('unknown CI while effective adds the wait line; not effective adds nothing', () => {
      const wait: AutofixInput = { effective: true, running: null, parked: null, unknownCi: true };
      const pending: PrChecks = { ...passing, state: 'pending', passed: 1, pending: 3 };
      expect(read(pr({ checks: pending }), undefined, offers, wait).reasons[0]!.extra).toBe('Auto-fix waits; not counted as pass');
      expect(read(pr({ checks: failing }), undefined, offers, wait).reasons[0]!.extra).toBe('Auto-fix waits; not counted as pass');
      expect(read(pr({ checks: pending }), undefined, offers, { ...wait, effective: false }).reasons[0]!.extra).toBeUndefined();
    });
  });
});

describe('blocking helpers', () => {
  it('joins the blocking reasons and counts them, skipping ok rows', () => {
    const r = read(pr({ reviewDecision: 'APPROVED', approvals: 1, checks: failing, mergeBlock: 'behind' }));
    expect(blockingCount(r)).toBe(2);
    expect(blockingReasonsTitle(r)).toBe('Required checks failing — 1 of 3 required failing · 1 optional pending · Behind develop — the branch is out of date');
  });
});
