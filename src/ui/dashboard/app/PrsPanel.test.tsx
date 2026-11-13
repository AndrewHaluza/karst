// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent } from '@testing-library/react';
import type { Reason } from '../../../model/prMergeReadiness.js';
import type { DashboardState } from '../state.js';
import { blockedBy, failing, installRuntimeDoubles, mount, one, byAct, pr, refreshBtn, REPO, stateWith, text, texts, URL } from './fixtures/prsPanelKit.js';

installRuntimeDoubles();

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

  it('chips the CI rollup and the blocked-reason count with their tooltips, only while the PR is live', () => {
    const base = { checks: { ...failing(['lint', null]), label: '1 failing', title: 'one failed' }, mergeBlockedReason: 'CI failing — 1 check', readiness: blockedBy(['checks', 'bad']) };
    mount(stateWith([pr(base)]));
    expect(document.querySelector('.pck')!.className).toBe('k-chip pck pck-failing');
    expect(document.querySelector('.pck')!.getAttribute('title')).toBe('one failed');
    expect(text('.pblock')).toBe('blocked · 1 reason');
    expect(document.querySelector('.pblock')!.getAttribute('title')).toBe('CI failing — 1 check');
    cleanup();
    mount(stateWith([pr({ ...base, readiness: blockedBy(['checks', 'bad'], ['conflicts', 'bad']) })]));
    expect(text('.pblock')).toBe('blocked · 2 reasons');
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

});

describe('PrsPanel — the merge-readiness block', () => {
  it('shows one green line for a ready PR and no list', () => {
    mount(stateWith([pr({ canMerge: true, readiness: { ready: true, headline: 'Ready to merge', facts: 'CI passed', reasons: [] } })]));
    expect(text('.prready b')).toBe('Ready to merge');
    expect(text('.prready-facts')).toBe('CI passed');
    expect(document.querySelector('.prblock')).toBeNull();
  });

  it('lists one row per reason with a header count, and shows nothing for a merged PR', () => {
    mount(stateWith([pr({ readiness: blockedBy(['checks', 'bad'], ['review', 'warn']) })]));
    expect(document.querySelectorAll('li.prsn')).toHaveLength(2);
    expect(document.querySelector('li.prsn')!.className).toBe('prsn prsn-bad');
    expect(text('li.prsn .prsn-label')).toBe('checks label');
    cleanup();
    mount(stateWith([pr({ status: 'merged', readiness: blockedBy(['checks', 'bad']) })]));
    expect(document.querySelector('.prblock')).toBeNull();
    expect(document.querySelector('.prready')).toBeNull();
  });

  it('keeps the conflicts disclosure open across pushes', () => {
    const withWhy = (opened: string) =>
      stateWith([pr({ opened, readiness: { ready: false, headline: 'Merge blocked', facts: '', reasons: [{ kind: 'conflicts', state: 'bad', label: 'Conflicts', short: 'conflicts', detail: '', why: 'git failed' }] } })]);
    const h = mount(withWhy('opened 2 days ago'));
    const d = document.querySelector<HTMLDetailsElement>('details.prsn-more')!;
    d.open = true;
    d.dispatchEvent(new Event('toggle'));
    h.emit({ type: 'state', state: withWhy('opened 3 days ago') });
    expect(document.querySelector<HTMLDetailsElement>('details.prsn-more')!.open).toBe(true);
    expect(text('.mgreason')).toBe('git failed');
  });
});

describe('PrsPanel — the folded readiness list', () => {
  type Readiness = DashboardState['prs'][number]['readiness'];
  const act = (kind: 'checks' | 'conflicts', label: string): Partial<Reason> =>
    kind === 'checks' ? { action: { act: 'send-ci-failure', label } } : { action: { act: 'resolve-conflicts', label, repo: REPO } };
  const two = (over: Partial<Reason>[] = [{}, {}]): Readiness => {
    const base = blockedBy(['checks', 'bad'], ['conflicts', 'warn']);
    return { ...base, reasons: base.reasons.map((r, i) => ({ ...r, ...over[i] })) };
  };
  const fold = (): HTMLDetailsElement => document.querySelector<HTMLDetailsElement>('details.prblock-fold')!;

  it('closes by default with the headline, one host-worded item per blocking reason, and no header count', () => {
    mount(stateWith([pr({ readiness: two() })]));
    expect(fold().open).toBe(false);
    expect(text('.prblock-head b')).toBe('Merge blocked');
    expect(texts('.prblock-item')).toEqual(['checks short', 'conflicts short']);
    expect(document.querySelector('.prblock-count')).toBeNull();
  });

  it('shows the actions on the summary line in reason order and not again in the body', () => {
    mount(stateWith([pr({ readiness: two([act('checks', 'Send CI failure'), act('conflicts', 'Resolve')]) })]));
    expect(texts('.prblock-acts button')).toEqual(['Send CI failure', 'Resolve']);
    expect(document.querySelectorAll('.prsn-line button')).toHaveLength(0);
  });

  it('does not toggle the disclosure when an action is clicked', () => {
    mount(stateWith([pr({ readiness: two([act('checks', 'Send CI failure'), {}]) })]));
    const click = new MouseEvent('click', { bubbles: true, cancelable: true });
    document.querySelector('.prblock-acts button')!.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(true);
    expect(fold().open).toBe(false);
  });

  it('shows a running reason as its run state with no action', () => {
    mount(stateWith([pr({ readiness: two([{ state: 'run', short: 'auto-fix round 1/3 runs' }, {}]) })]));
    expect(texts('.prblock-item')[0]).toBe('auto-fix round 1/3 runs');
    expect(document.querySelector('.prblock-item.prsn-run')).not.toBeNull();
    expect(document.querySelector('.prblock-acts')).toBeNull();
  });

  it('keeps the open choice across a push and lists the reason bodies open', () => {
    const state = (opened: string) => stateWith([pr({ opened, readiness: two([{ list: [{ text: 'unit' }] }, {}]) })]);
    const h = mount(state('opened 2 days ago'));
    fold().open = true;
    fold().dispatchEvent(new Event('toggle'));
    h.emit({ type: 'state', state: state('opened 3 days ago') });
    expect(fold().open).toBe(true);
    expect(text('.prsn-more .pck-row')).toBe('unit');
    expect(document.querySelector('details.prsn-more')).toBeNull();
  });

  it('has no outer disclosure for one blocking reason, and its list is a collapsed details', () => {
    mount(stateWith([pr({ readiness: blockedBy(['checks', 'bad']) })]));
    expect(document.querySelector('details.prblock-fold')).toBeNull();
    expect(text('.prblock-count')).toBe('1 reason');
    cleanup();
    const one1 = blockedBy(['checks', 'bad']);
    mount(stateWith([pr({ readiness: { ...one1, reasons: [{ ...one1.reasons[0]!, list: [{ text: 'unit' }] }] } })]));
    expect(document.querySelector('details.prblock-fold')).toBeNull();
    expect(document.querySelector<HTMLDetailsElement>('details.prsn-more')!.open).toBe(false);
  });

  it('counts only blocking reasons: one blocker beside an ok row is not folded', () => {
    mount(stateWith([pr({ readiness: blockedBy(['checks', 'ok'], ['conflicts', 'warn']) })]));
    expect(document.querySelector('details.prblock-fold')).toBeNull();
  });
});

describe('PrsPanel — Merge all', () => {
  const ready = (repo: string) => pr({ repo, canMerge: true, readiness: { ready: true, headline: 'Ready to merge', facts: '', reasons: [] } });
  const blocked = (repo: string) => pr({ repo, readiness: blockedBy(['checks', 'bad']) });
  const btn = () => document.querySelector<HTMLButtonElement>('.phead button.mgbtn:not(#prRefresh)')!;

  it('is absent below two open PRs', () => {
    mount(stateWith([ready('/a')]));
    expect(document.querySelector('.phead button.mgbtn')).toBeNull();
  });

  it('is the primary "Merge all" when every PR is ready, and posts one message', () => {
    const h = mount(stateWith([ready('/a'), ready('/b')]));
    expect(btn().textContent).toBe('Merge all');
    expect(btn().className).toBe('k-btn k-btn--primary k-btn--sm mgbtn');
    fireEvent.click(one('merge-all-prs'));
    expect(h.send.mergeAllPrs).toHaveBeenCalledTimes(1);
  });

  it('counts the ready PRs when some are blocked', () => {
    mount(stateWith([ready('/a'), blocked('/b')]));
    expect(btn().textContent).toBe('Merge 1 ready');
    expect(btn().disabled).toBe(false);
  });

  it('is disabled and secondary when none is ready', () => {
    mount(stateWith([blocked('/a'), blocked('/b')]));
    expect(btn().textContent).toBe('Merge all');
    expect(btn().disabled).toBe(true);
    expect(btn().title).toBe('No pull request is ready to merge');
    expect(btn().className).toBe('k-btn k-btn--secondary k-btn--sm mgbtn');
  });

  it('is disabled while an auto-fix round runs', () => {
    mount(stateWith([ready('/a'), ready('/b')], { roundRunning: true }));
    expect(btn().disabled).toBe(true);
    expect(btn().title).toBe('An auto-fix round is running');
    expect(byAct('merge-all-prs')).toHaveLength(0);
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

  it('adds the title, the byline, the diff size and the review facts to the details dialog', () => {
    mount(stateWith([pr({
      title: 'Add Merge all', author: 'ada',
      changes: { files: 1, additions: 5, deletions: 2, commits: 2 },
      review: { decision: 'CHANGES_REQUESTED', approvals: 0, required: null, requested: ['bob', 'core'] },
    })]));
    fireEvent.click(one('toggle-pr-info'));
    const pop = document.querySelector('.pinfo-pop')!;
    expect(pop.textContent).toContain('Add Merge all');
    expect(pop.querySelector('.pinfo-by')!.textContent).toBe('web #42 · by ada');
    expect(pop.textContent).toContain('+5 −2 · 1 file · 2 commits');
    expect(pop.textContent).toContain('Changes requested · requested from bob, core');
  });

  it('leaves the author out of the byline and shows no diff size when GitHub stated neither', () => {
    mount(stateWith([pr({ title: 'Only a title' })]));
    fireEvent.click(one('toggle-pr-info'));
    const pop = document.querySelector('.pinfo-pop')!;
    expect(pop.querySelector('.pinfo-by')!.textContent).toBe('web #42');
    expect(pop.textContent).not.toContain('+');
  });

  it('closes the details dialog on a click outside it', () => {
    mount(stateWith([pr()]));
    fireEvent.click(one('toggle-pr-info'));
    fireEvent.click(document.body);
    expect(document.querySelector('.pinfo-pop')).toBeNull();
  });
});

describe('PrsPanel — a non-blocking optional-checks note', () => {
  const note = (): DashboardState['prs'][number]['readiness'] => ({
    ready: true,
    headline: 'Ready to merge',
    facts: 'no review required',
    reasons: [
      {
        kind: 'checks',
        state: 'note',
        label: 'Optional checks failing',
        short: 'optional checks failing · 1',
        detail: '1 optional check failing',
        action: { act: 'send-ci-failure', label: 'Send CI failure' },
        list: [{ text: 'lint', url: 'https://ci/2' }],
      },
    ],
  });

  it('shows the ready line, the note row with its list and action, and no blocked count', () => {
    mount(stateWith([pr({ canMerge: true, readiness: note() })]));
    expect(text('.prready b')).toBe('Ready to merge');
    expect(document.querySelector('li.prsn.prsn-note[data-kind="checks"]')).not.toBeNull();
    expect(text('.prsn-label')).toBe('Optional checks failing');
    expect(texts('.prsn-line button')).toEqual(['Send CI failure']);
    expect(text('.pck-row')).toBe('lint');
    expect(document.querySelector('.prblock')).toBeNull();
    expect(document.body.textContent).not.toContain('blocked ·');
  });

  it('shows only the note, no blocked box, when GitHub did not confirm the merge', () => {
    const r = note();
    mount(stateWith([pr({ readiness: { ...r, ready: false, headline: 'Merge not confirmed', facts: 'GitHub: no answer yet' } })]));
    expect(document.querySelector('li.prsn.prsn-note[data-kind="checks"]')).not.toBeNull();
    expect(texts('.prsn-line button')).toEqual(['Send CI failure']);
    expect(document.querySelector('.prblock')).toBeNull();
    expect(document.querySelector('.prready')).toBeNull();
  });

  it('keeps the note action on its own row inside the folded list, beside the summary actions', () => {
    const base = note();
    const blockers = blockedBy(['review', 'bad'], ['conflicts', 'warn']).reasons;
    mount(stateWith([pr({ readiness: { ...base, ready: false, headline: 'Merge blocked', facts: '', reasons: [...base.reasons, ...blockers] } })]));
    expect(document.querySelector('details.prblock-fold')).not.toBeNull();
    expect(texts('.prsn-line button')).toEqual(['Send CI failure']);
    expect(texts('.prblock-item')).toEqual(['review short', 'conflicts short']);
  });
});
