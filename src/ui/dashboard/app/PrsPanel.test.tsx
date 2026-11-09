// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent } from '@testing-library/react';
import type { DashboardState } from '../state.js';
import { failing, installRuntimeDoubles, mc, mount, one, byAct, pr, refreshBtn, REPO, stateWith, text, texts, URL } from './fixtures/prsPanelKit.js';

installRuntimeDoubles();

const html = (sel: string): string => document.querySelector(sel)?.innerHTML ?? '';
const row = (n = 0): HTMLElement => document.querySelectorAll<HTMLElement>('#prs .prrow')[n]!;

describe('PrsPanel — header and empty states', () => {
  it('renders nothing in the body before the first snapshot, but keeps the refresh control', () => {
    mount(null);
    expect(text('.phead .count')).toBe('');
    expect(document.querySelector('#prs')!.childElementCount).toBe(0);
    expect(refreshBtn().disabled).toBe(false);
  });

  it('says there are none, shows no count, and keeps the refresh live', () => {
    mount(stateWith([]));
    expect(text('.phead .count')).toBe('');
    expect(text('#prs .ehead')).toBe('No pull requests.');
    expect(text('#prs .esub')).toBe('Ship opens one per repository with changes.');
    expect(refreshBtn().disabled).toBe(false);
  });

  it('counts the rows', () => {
    mount(stateWith([pr(), pr({ repo: '/repos/api', repoDisplay: 'api' })]));
    expect(text('.phead .count')).toBe('2');
    expect(document.querySelectorAll('#prs .prrow')).toHaveLength(2);
  });

  it('renders the refresh control with the idle name as both label and title, and the 13px glyph', () => {
    mount(stateWith([pr()]));
    const b = refreshBtn();
    expect(b.className).toBe('k-iconbtn iconbtn');
    expect(b.getAttribute('aria-label')).toBe('Re-check pull request status and mergeability now');
    expect(b.title).toBe(b.getAttribute('aria-label'));
    expect(b.dataset.act).toBe('refresh-prs');
    expect(b.type).toBe('button');
    expect(b.querySelector('svg.k-icon')).not.toBeNull();
  });
});

describe('PrsPanel — the PR line', () => {
  it('lays out lead icon, repo, number, copy, details, chips, stamp and branch, with the actions in the trail', () => {
    mount(stateWith([pr({ canMerge: true, mergeBlockedReason: '', canDismiss: true, checks: { state: 'passing', label: '3 passed', title: 'all green', detailsLabel: '', failing: [] } })]));
    const line = row().querySelector('.pr')!;
    expect([...line.querySelector('.krow-main')!.children].map((c) => c.className)).toEqual([
      'prepo', 'pnum', 'k-iconbtn ib t-copy url-copy', 'k-iconbtn ib pinfo-btn', 'k-chip pst pst-open', 'k-chip pck pck-passing', 'pstamp', 'pbranch',
    ]);
    expect(line.querySelector('.pr-lead')!.getAttribute('data-status')).toBe('open');
    expect([...line.querySelectorAll('.krow-trail button')].map((c) => c.textContent)).toEqual(['Dismiss', 'Merge']);
    expect(line.querySelector('.prepo')!.textContent).toBe('web');
    expect(line.querySelector('.prepo')!.getAttribute('title')).toBe(REPO);
    const a = line.querySelector('.pnum a')!;
    expect(a.textContent).toBe('#42');
    expect(a.getAttribute('href')).toBe('#');
    expect(a.getAttribute('title')).toBe('Open this pull request');
    expect(a.getAttribute('data-url')).toBe(URL);
    expect(a.getAttribute('data-act')).toBe('open-pr');
  });

  it('shows the copy control as a labelled icon button with the data-copy hook', () => {
    mount(stateWith([pr()]));
    const copy = one('copy-pr-url');
    expect(copy.getAttribute('data-copy')).toBe('');
    expect(copy.getAttribute('data-url')).toBe(URL);
    expect(copy.title).toBe('Copy pull request URL');
    expect(copy.getAttribute('aria-label')).toBe('Copy pull request URL');
    expect(copy.querySelector('svg.k-icon')).not.toBeNull();
  });

  it('with no recorded URL has no copy control and the number is plain text', () => {
    mount(stateWith([pr({ url: null })]));
    expect(byAct('copy-pr-url')).toHaveLength(0);
    expect(byAct('open-pr')).toHaveLength(0);
    expect(text('.pnum')).toBe('#42');
  });

  it('with neither URL nor number leaves an empty number slot', () => {
    mount(stateWith([pr({ url: null, number: null })]));
    expect(text('.pnum')).toBe('');
    expect(document.querySelector('.pnum')).not.toBeNull();
  });

  it('falls back to the path when no display name resolves, with no tooltip', () => {
    mount(stateWith([pr({ repoDisplay: '' })]));
    expect(text('.prepo')).toBe(REPO);
    expect(document.querySelector('.prepo')!.hasAttribute('title')).toBe(false);
    cleanup();
    mount(stateWith([pr({ repoDisplay: REPO })]));
    expect(document.querySelector('.prepo')!.hasAttribute('title')).toBe(false);
  });

  it.each(['open', 'merged', 'closed', 'draft'])('puts a %s status in its chip variant', (status) => {
    mount(stateWith([pr({ status })]));
    expect(document.querySelector('.pst')!.className).toBe(`k-chip pst pst-${status}`);
    expect(text('.pst')).toBe(status);
    cleanup();
  });

  it('renders an empty status as the unknown variant with no word', () => {
    mount(stateWith([pr({ status: '' })]));
    expect(document.querySelector('.pst')!.className).toBe('k-chip pst pst-unknown');
    expect(text('.pst')).toBe('');
  });

  it('chips the CI rollup and GitHub refusal with their tooltips, only while the PR is live', () => {
    const base = { checks: { ...failing(['lint', null]), label: '1 failing', title: 'one failed' }, mergeBlockLabel: 'conflicts', mergeBlockedReason: 'merge conflicts' };
    mount(stateWith([pr(base)]));
    expect(document.querySelector('.pck')!.className).toBe('k-chip pck pck-failing');
    expect(document.querySelector('.pck')!.getAttribute('title')).toBe('one failed');
    expect(text('.pblock')).toBe('conflicts');
    expect(document.querySelector('.pblock')!.getAttribute('title')).toBe('merge conflicts');
    cleanup();
    mount(stateWith([pr({ ...base, status: 'merged' })]));
    expect(document.querySelector('.pck')).toBeNull();
    expect(document.querySelector('.pblock')).toBeNull();
  });

  it('shows no chip for a rollup without a label', () => {
    mount(stateWith([pr()]));
    expect(document.querySelector('.pck')).toBeNull();
    expect(document.querySelector('.pblock')).toBeNull();
  });

  it('shows the dismissal stamp on the line, dims the row, and offers Undo dismiss', () => {
    mount(stateWith([pr({ status: 'closed', dismissed: true, dismissedLabel: 'dismissed Aug 11' })]));
    expect(text('.krow-main .pstamp')).toBe('dismissed Aug 11');
    expect([...document.querySelectorAll('.pacts button')].map((c) => c.textContent)).toEqual(['Undo dismiss', 'Merge']);
    expect(document.querySelector('.prrow.dismissed')).not.toBeNull();
  });
});

describe('PrsPanel — merge and dismiss controls (host verdicts)', () => {
  it('offers Merge as the primary action with the target branch and number in its title', () => {
    mount(stateWith([pr({ canMerge: true, mergeBlockedReason: '' })]));
    const b = one('merge-pr');
    expect(b.className).toBe('k-btn k-btn--primary k-btn--sm mgbtn');
    expect(b.dataset.repo).toBe(REPO);
    expect(b.title).toBe('Merge PR #42 into main — cannot be undone');
    expect(b.textContent).toBe('Merge');
    expect(b.disabled).toBe(false);
  });

  it('names its base as "its base" and drops the number when the host does not know them', () => {
    mount(stateWith([pr({ canMerge: true, mergeBlockedReason: '', number: null, baseRef: null })]));
    expect(one('merge-pr').title).toBe('Merge PR into its base — cannot be undone');
  });

  it('shows the host reason on a disabled secondary Merge and posts no act', () => {
    mount(stateWith([pr({ canMerge: false, mergeBlockedReason: 'merge conflicts' })]));
    const b = document.querySelector<HTMLButtonElement>('.mgbtn')!;
    expect(b.className).toBe('k-btn k-btn--secondary k-btn--sm mgbtn');
    expect(b.disabled).toBe(true);
    expect(b.title).toBe('merge conflicts');
    expect(b.hasAttribute('data-act')).toBe(false);
    expect(byAct('merge-pr')).toHaveLength(0);
  });

  it('offers no Merge on a merged PR', () => {
    mount(stateWith([pr({ status: 'merged', canMerge: true })]));
    expect(document.querySelector('.pacts .mgbtn')).toBeNull();
  });

  it('offers Dismiss only when the host says so', () => {
    mount(stateWith([pr({ canDismiss: true })]));
    const b = one('dismiss-pr');
    expect(b.className).toBe('k-btn k-btn--ghost k-btn--sm mgbtn');
    expect(b.dataset.repo).toBe(REPO);
    expect(b.title).toBe('Stop waiting on this pull request — it will never land');
    cleanup();
    mount(stateWith([pr({ canDismiss: false })]));
    expect(byAct('dismiss-pr')).toHaveLength(0);
  });

  it('offers Undo dismiss on a dismissed PR even when canDismiss is false', () => {
    mount(stateWith([pr({ dismissed: true, canDismiss: false })]));
    const b = one('undismiss-pr');
    expect(b.textContent).toBe('Undo dismiss');
    expect(b.title).toBe('Wait on this pull request again');
    expect(byAct('dismiss-pr')).toHaveLength(0);
  });
});

describe('PrsPanel — metadata, checks and comments', () => {
  it('shows the line stamp with its full text in the title, preferring dismissed, then merged, then opened', () => {
    mount(stateWith([pr({ status: 'merged', merged: 'merged 1 day ago', mergedTitle: 'merged Aug 12', openedTitle: 'opened Aug 11' })]));
    expect(text('.pr .pstamp')).toBe('merged 1 day ago');
    expect(document.querySelector('.pr .pstamp')!.getAttribute('title')).toBe('merged Aug 12');
    cleanup();
    mount(stateWith([pr()]));
    expect(text('.pr .pstamp')).toBe('opened 2 days ago');
    expect(document.querySelector('.pr .pstamp')!.getAttribute('title')).toBe('opened Aug 11');
  });

  it('shows the branches only when the head differs from the Worktrees header branch', () => {
    mount(stateWith([pr()]));
    expect(text('.pr .pbranch')).toBe('feat/x → main');
    expect(document.querySelector('.pr .pbranch')!.getAttribute('title')).toBe('feat/x → main');
    cleanup();
    mount({ ...stateWith([pr()]), worktrees: [{ repo: REPO, branch: 'feat/x' }] } as never);
    expect(document.querySelector('.pr .pbranch')).toBeNull();
    cleanup();
    mount({ ...stateWith([pr()]), worktrees: [{ repo: REPO, branch: 'feat/other' }] } as never);
    expect(document.querySelector('.pr .pbranch')).not.toBeNull();
  });

  it('renders no stamp or branch when the host sent neither', () => {
    mount(stateWith([pr({ branches: '', opened: '', openedTitle: '' })]));
    expect(document.querySelector('.pr .pstamp')).toBeNull();
    expect(document.querySelector('.pr .pbranch')).toBeNull();
  });

  it('lists comments behind a collapsed disclosure, naming an anonymous author and omitting an unknown time', () => {
    mount(
      stateWith([
        pr({
          commentsLabel: '2 comments',
          comments: [
            { author: 'octo', when: '1 day ago', body: 'Looks right' },
            { author: '', when: '', body: 'No name' },
          ],
        }),
      ]),
    );
    const d = document.querySelector<HTMLDetailsElement>('details.pcms')!;
    expect(d.open).toBe(false);
    expect(text('details.pcms summary')).toBe('2 comments');
    expect(texts('.pcmwho')).toEqual(['octo', 'unknown']);
    expect(texts('.pcmwhen')).toEqual(['1 day ago']);
    expect(texts('.pcmbody')).toEqual(['Looks right', 'No name']);
  });

  it('renders no comments disclosure without a label', () => {
    mount(stateWith([pr()]));
    expect(document.querySelector('details.pcms')).toBeNull();
  });

  it('opens the failing-checks disclosure with links for runs that have a URL and plain names otherwise', () => {
    mount(stateWith([pr({ checks: failing(['build', 'https://x.test/run/1'], ['lint', null]) })]));
    expect(text('details.pcks summary')).toBe('2 failing checks');
    const rows = [...document.querySelectorAll('details.pcks .pck-row')];
    expect(rows[0]!.querySelector('a')!.getAttribute('data-url')).toBe('https://x.test/run/1');
    expect(rows[0]!.querySelector('a')!.getAttribute('title')).toBe('Open this check run');
    expect(rows[1]!.querySelector('a')).toBeNull();
    expect(rows[1]!.querySelector('span')!.textContent).toBe('lint');
  });

  it('suppresses the checks disclosure for a merged PR and when the host gave no label', () => {
    mount(stateWith([pr({ status: 'merged', checks: failing(['build', null]) })]));
    expect(document.querySelector('details.pcks')).toBeNull();
    cleanup();
    mount(stateWith([pr({ checks: { ...failing(['build', null]), detailsLabel: '' } })]));
    expect(document.querySelector('details.pcks')).toBeNull();
  });
});

describe('PrsPanel — the CI line', () => {
  it('leaves the pending line out: the checks chip already says it', () => {
    mount(stateWith([pr({ checks: { state: 'pending', label: '1 pending', title: '', detailsLabel: '', failing: [] } })]));
    expect(document.querySelector('.mg-ci')).toBeNull();
    expect(text('.pck-pending')).toBe('1 pending');
    expect(byAct('send-ci-failure')).toHaveLength(0);
    expect(document.querySelector('.mg-ci-failing')).toBeNull();
  });

  it('renders nothing for passing, none or a merged PR', () => {
    mount(stateWith([pr({ checks: { state: 'passing', label: '3 passed', title: '', detailsLabel: '', failing: [] } })]));
    expect(document.querySelector('.mg-ci')).toBeNull();
    cleanup();
    mount(stateWith([pr({ status: 'merged', checks: failing(['x', null]) })]));
    expect(document.querySelector('.mg-ci')).toBeNull();
  });

  it('counts failures in the singular and plural and lists the check names under the line', () => {
    mount(stateWith([pr({ checks: failing(['a', 'https://x.test/1']) })]));
    expect(text('.mg-ci-failing .mgtext')).toBe('CI failing — 1 check');
    expect(document.querySelectorAll('.mg-ci-failing > .pck-row')).toHaveLength(1);
    cleanup();
    mount(stateWith([pr({ checks: failing(['a', null], ['b', null]) })]));
    expect(text('.mg-ci-failing .mgtext')).toBe('CI failing — 2 checks');
  });

  it('offers Send CI failure only when the host lists this repo as available', () => {
    const failingPr = pr({ checks: failing(['a', null]) });
    mount(stateWith([failingPr], { ci: { available: true, repos: [REPO] } }));
    const b = one('send-ci-failure');
    expect(b.className).toBe('k-btn k-btn--secondary k-btn--sm mgbtn');
    expect(b.title).toBe('Send the failing CI log to the agent — UAT and Review will run again');
    expect(b.textContent).toBe('Send CI failure to agent');
    cleanup();
    mount(stateWith([failingPr], { ci: { available: true, repos: ['/other'] } }));
    expect(byAct('send-ci-failure')).toHaveLength(0);
    expect(text('.mg-ci-failing .mgtext')).toBe('CI failing — 1 check');
    cleanup();
    mount(stateWith([failingPr], { ci: { available: false, repos: [REPO] } }));
    expect(byAct('send-ci-failure')).toHaveLength(0);
  });
});

describe('PrsPanel — the merge check line', () => {
  it('renders no line for a repo with no check', () => {
    mount(stateWith([pr()]));
    expect(document.querySelector('.mgwrap')).toBeNull();
  });

  it('keys the dot and wrapper on the state and offers Resolve only for a conflict', () => {
    mount(stateWith([pr()], { mergeChecks: [mc()] }));
    expect(document.querySelector('.mgwrap')!.className).toBe('mgwrap mg-conflicted');
    expect(text('.mg .mgtext')).toBe('conflicted · 2 files · vs main');
    const r = one('resolve-conflicts');
    expect(r.className).toBe('k-btn k-btn--secondary k-btn--sm mgbtn');
    expect(r.dataset.repo).toBe(REPO);
    expect(r.title).toBe("Hand this repo's conflict to an agent session");
    expect(r.textContent).toBe('Resolve conflicts');
    cleanup();
    mount(stateWith([pr()], { mergeChecks: [mc({ state: 'clean', detailsLabel: '', files: [] })] }));
    expect(document.querySelector('.mgwrap')!.className).toBe('mgwrap mg-clean');
    expect(byAct('resolve-conflicts')).toHaveLength(0);
  });

  it('keeps the host stamp prefix verbatim in the headline tooltip (parity with the vanilla title)', () => {
    mount(stateWith([pr()], { mergeChecks: [mc({ checkedTitle: 'Aug 11' })] }));
    expect(document.querySelector('.mgtext')!.getAttribute('title')).toBe('checked Aug 11');
    cleanup();
    mount(stateWith([pr()], { mergeChecks: [mc({ checkedTitle: '' })] }));
    expect(document.querySelector('.mgtext')!.hasAttribute('title')).toBe(false);
  });

  it('lists conflicting files, or git’s reason when it has one, behind the disclosure', () => {
    mount(stateWith([pr()], { mergeChecks: [mc()] }));
    expect(text('details.mgd summary')).toBe('2 conflicting files');
    expect(document.querySelector<HTMLElement>('details.mgd')!.dataset.repo).toBe(REPO);
    expect(texts('.mgdbody .mgfile')).toEqual(['src/a.ts', 'src/b.ts']);
    cleanup();
    mount(stateWith([pr()], { mergeChecks: [mc({ state: 'unknown', files: [], reason: 'git failed', detailsLabel: 'why' })] }));
    expect(texts('.mgdbody .mgreason')).toEqual(['git failed']);
    expect(document.querySelector('.mgfile')).toBeNull();
    cleanup();
    mount(stateWith([pr()], { mergeChecks: [mc({ detailsLabel: '' })] }));
    expect(document.querySelector('details.mgd')).toBeNull();
  });

  it('matches a check to its PR by repo and ignores checks for repos with no PR', () => {
    mount(stateWith([pr()], { mergeChecks: [mc({ repo: '/other' })] }));
    expect(document.querySelector('.mgwrap')).toBeNull();
  });
});

describe('PrsPanel — disclosure state', () => {
  it('keeps the merge-check disclosure open across pushes, even if the line disappears and returns', () => {
    const h = mount(stateWith([pr()], { mergeChecks: [mc()] }));
    const d = document.querySelector<HTMLDetailsElement>('details.mgd')!;
    d.open = true;
    d.dispatchEvent(new Event('toggle'));
    h.emit({ type: 'state', state: stateWith([pr({ opened: 'opened 3 days ago' })], { mergeChecks: [mc()] }) });
    expect(document.querySelector<HTMLDetailsElement>('details.mgd')!.open).toBe(true);
    h.emit({ type: 'state', state: stateWith([pr()]) });
    expect(document.querySelector('details.mgd')).toBeNull();
    h.emit({ type: 'state', state: stateWith([pr()], { mergeChecks: [mc()] }) });
    expect(document.querySelector<HTMLDetailsElement>('details.mgd')!.open).toBe(true);
  });

  it('forgets a disclosure the user closed', () => {
    const h = mount(stateWith([pr()], { mergeChecks: [mc()] }));
    const d = document.querySelector<HTMLDetailsElement>('details.mgd')!;
    d.open = true;
    d.dispatchEvent(new Event('toggle'));
    d.open = false;
    d.dispatchEvent(new Event('toggle'));
    h.emit({ type: 'state', state: stateWith([pr()], { mergeChecks: [mc({ headline: 'conflicted · 3 files' })] }) });
    expect(document.querySelector<HTMLDetailsElement>('details.mgd')!.open).toBe(false);
  });

  it('keeps the comments and checks disclosures open across a push (they are the same elements)', () => {
    const withBoth = (opened: string) =>
      stateWith([pr({ opened, commentsLabel: '1 comment', comments: [{ author: 'a', when: '', body: 'b' }], checks: failing(['x', null]) })]);
    const h = mount(withBoth('opened 2 days ago'));
    const comments = document.querySelector<HTMLDetailsElement>('details.pcms')!;
    const checks = document.querySelector<HTMLDetailsElement>('details.pcks')!;
    comments.open = true;
    checks.open = true;
    h.emit({ type: 'state', state: withBoth('opened 3 days ago') });
    expect(document.querySelector('details.pcms')).toBe(comments);
    expect(comments.open).toBe(true);
    expect(checks.open).toBe(true);
  });
});

describe('PrsPanel — slice selection (migration plan A4)', () => {
  it('does not re-render on a live push whose PR slice is structurally unchanged, and re-renders on a change', () => {
    const make = (extra: Record<string, unknown>) => ({ ...stateWith([pr(), pr({ repo: '/repos/api', repoDisplay: 'api' })]), ...extra }) as unknown as DashboardState;
    const onRender = vi.fn();
    const h = mount(make({}), onRender);
    const before = onRender.mock.calls.length;
    h.emit({ type: 'state', state: make({ clock: 't1' }), live: true });
    h.emit({ type: 'state', state: make({ clock: 't2' }), live: true });
    expect(onRender.mock.calls.length).toBe(before);

    h.emit({ type: 'state', state: stateWith([pr(), pr({ repo: '/repos/api', repoDisplay: 'api', status: 'merged' })]), live: true });
    expect(onRender.mock.calls.length).toBeGreaterThan(before);
    expect(row(1).querySelector('.pst')!.textContent).toBe('merged');
  });

  it('keeps unchanged rows as the very same DOM nodes when another row changes', () => {
    const h = mount(stateWith([pr(), pr({ repo: '/repos/api', repoDisplay: 'api' })]));
    const first = row(0);
    h.emit({ type: 'state', state: stateWith([pr(), pr({ repo: '/repos/api', repoDisplay: 'api', status: 'closed' })]) });
    expect(row(0)).toBe(first);
  });
});

describe('PrsPanel — summary, the details popover and the blocked reason', () => {
  it('summarises ready, blocked and dismissed PRs, non-zero parts only, with the full text in the title', () => {
    mount(stateWith([
      pr({ canMerge: true }),
      pr({ repo: '/repos/b', canMerge: false }),
      pr({ repo: '/repos/c', status: 'closed', dismissed: true, dismissedLabel: 'dismissed Aug 11' }),
    ]));
    const sum = document.querySelector('.phead .sec-sum')!;
    expect(sum.textContent).toBe('1 ready · 1 blocked · 1 dismissed');
    expect(sum.getAttribute('title')).toBe('1 ready · 1 blocked · 1 dismissed');
    cleanup();
    mount(stateWith([pr({ canMerge: true })]));
    expect(text('.phead .sec-sum')).toBe('1 ready');
  });

  it('shows the host reason a Merge is disabled in the row, not only in its title', () => {
    mount(stateWith([pr({ canMerge: false, mergeBlockedReason: 'awaiting review' })]));
    expect(text('.pwhy')).toBe('awaiting review');
  });

  it('opens a details dialog from the ⓘ toggle and closes it on Escape, returning focus', () => {
    mount(stateWith([pr({ checks: { state: 'passing', label: '3 passed', title: 'all green', detailsLabel: '', failing: [] } })]));
    const info = one('toggle-pr-info');
    expect(info.getAttribute('aria-haspopup')).toBe('dialog');
    expect(info.getAttribute('aria-label')).toBe('Pull request details');
    expect(document.querySelector('.pinfo-pop')).toBeNull();
    fireEvent.click(info);
    const pop = document.querySelector('.pinfo-pop')!;
    expect(pop.getAttribute('role')).toBe('dialog');
    expect(pop.textContent).toContain('feat/x → main');
    expect(pop.textContent).toContain('opened Aug 11');
    expect(pop.textContent).toContain('all green');
    expect(pop.textContent).toContain('awaiting review');
    expect(pop.querySelector('[data-act="open-pr"]')!.textContent).toBe('Open on GitHub');
    expect(pop.querySelector('[data-act="copy-pr-url"]')!.textContent).toBe('Copy URL');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(document.querySelector('.pinfo-pop')).toBeNull();
    expect(document.activeElement).toBe(info);
  });

  it('closes the details dialog on a click outside it', () => {
    mount(stateWith([pr()]));
    fireEvent.click(one('toggle-pr-info'));
    fireEvent.click(document.body);
    expect(document.querySelector('.pinfo-pop')).toBeNull();
  });
});
