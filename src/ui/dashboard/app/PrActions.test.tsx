// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent } from '@testing-library/react';
import { failing, installRuntimeDoubles, mc, mount, one, pr, refreshBtn, REPO, settled, stateWith, URL } from './fixtures/prsPanelKit.js';

installRuntimeDoubles();

const API = '/repos/api';
const apiPr = (over: Parameters<typeof pr>[0] = {}) => pr({ repo: API, repoDisplay: 'api', number: 7, url: 'https://github.com/o/api/pull/7', ...over });
const mergeable = { canMerge: true, mergeBlockedReason: '' };
const twoMergeable = () => stateWith([pr(mergeable), apiPr(mergeable)]);
/** The runtime's is-pending class is on the node, and React left the rest of className alone: it was never rewritten. */
function keepsClass(el: HTMLElement, base: string): void {
  expect(el.classList.contains('is-pending')).toBe(true);
  expect([...el.classList].filter((c) => c !== 'is-pending').join(' ')).toBe(base);
}
const mergeRows = (): HTMLButtonElement[] => [...document.querySelectorAll<HTMLButtonElement>('.pacts .mgbtn:last-child')];
const mergeOf = (): HTMLButtonElement => mergeRows()[0]!;

describe('PrsPanel — acts that carry a request id (settled by the host action-result)', () => {
  it('open-pr posts the URL once, prevents the navigation, and goes pending', () => {
    const h = mount(stateWith([pr()]));
    const a = one('open-pr');
    expect(fireEvent.click(a)).toBe(false);
    expect(h.send.openPr).toHaveBeenCalledTimes(1);
    expect(h.send.openPr).toHaveBeenCalledWith(URL, 'req-1');
    expect(a.getAttribute('aria-busy')).toBe('true');
    fireEvent.click(a);
    expect(h.send.openPr).toHaveBeenCalledTimes(1);
  });

  it('a failing check run opens through the same act with its own URL', () => {
    const h = mount(stateWith([pr({ checks: failing(['build', 'https://x.test/run/1']) })]));
    fireEvent.click(document.querySelector('details.pcks a[data-act="open-pr"]')!);
    expect(h.send.openPr).toHaveBeenCalledTimes(1);
    expect(h.send.openPr).toHaveBeenCalledWith('https://x.test/run/1', 'req-1');
  });

  it('the CI line lists the same run links, each posting once', () => {
    const h = mount(stateWith([pr({ checks: failing(['build', 'https://x.test/run/1']) })]));
    fireEvent.click(document.querySelector('.mg-ci-failing a[data-act="open-pr"]')!);
    expect(h.send.openPr).toHaveBeenCalledTimes(1);
  });

  it('copy-pr-url posts once, flashes through data-copied without touching className, and reverts', () => {
    vi.useFakeTimers();
    const h = mount(stateWith([pr()]));
    const b = one('copy-pr-url');
    const cls = b.className;
    fireEvent.click(b);
    expect(h.send.copyPrUrl).toHaveBeenCalledTimes(1);
    expect(h.send.copyPrUrl).toHaveBeenCalledWith(URL, 'req-1');
    expect(b.hasAttribute('data-copied')).toBe(true);
    expect(b.querySelector('.u')!.textContent).toBe('Copied ✓');
    keepsClass(b, cls);
    expect(b.getAttribute('aria-busy')).toBe('true');
    fireEvent.click(b);
    expect(h.send.copyPrUrl).toHaveBeenCalledTimes(1);
    act(() => {
      vi.advanceTimersByTime(1300);
    });
    expect(b.hasAttribute('data-copied')).toBe(false);
    expect(b.querySelector('.u')!.textContent).toBe(URL);
  });

  it('resolve-conflicts posts the repo with a request id exactly once and goes pending', () => {
    const h = mount(stateWith([pr()], { mergeChecks: [mc()] }));
    const b = one('resolve-conflicts');
    fireEvent.click(b);
    expect(h.send.resolveConflicts).toHaveBeenCalledTimes(1);
    expect(h.send.resolveConflicts).toHaveBeenCalledWith(REPO, 'req-1');
    expect(b.getAttribute('aria-busy')).toBe('true');
    fireEvent.click(b);
    expect(h.send.resolveConflicts).toHaveBeenCalledTimes(1);
  });
});

describe('PrsPanel — merge-pr (pending until the next settling state push)', () => {
  it('posts exactly {repo} with no request id, goes pending in the shared state, and announces nothing to the page', () => {
    const h = mount(twoMergeable());
    const b = mergeOf();
    fireEvent.click(b);
    expect(h.send.mergePr).toHaveBeenCalledTimes(1);
    expect(h.send.mergePr.mock.calls[0]).toEqual([REPO]);
    expect([...h.ops().getSnapshot().merging]).toEqual([REPO]);
    expect(b.getAttribute('aria-busy')).toBe('true');
    expect(b.disabled).toBe(true);
    expect(b.title).toBe('Confirm the merge in the dialog');
    expect(b.textContent).toBe('Merge');
    expect(b.hasAttribute('data-act')).toBe(false);
    keepsClass(b, 'k-btn k-btn--primary k-btn--sm mgbtn');
    fireEvent.click(b);
    expect(h.send.mergePr).toHaveBeenCalledTimes(1);
  });

  it('only the clicked repo goes pending', () => {
    mount(twoMergeable());
    fireEvent.click(mergeRows()[0]!);
    expect(mergeRows()[0]!.disabled).toBe(true);
    expect(mergeRows()[1]!.disabled).toBe(false);
    expect(mergeRows()[1]!.dataset.act).toBe('merge-pr');
  });

  it('survives a live push and a passive (non-settling) push', () => {
    const h = mount(twoMergeable());
    fireEvent.click(mergeRows()[0]!);
    const b = mergeRows()[0]!;
    h.emit({ type: 'state', state: twoMergeable(), live: true, settlesActions: false });
    h.emit({ type: 'state', state: twoMergeable(), settlesActions: false });
    expect(mergeRows()[0]).toBe(b);
    expect(b.getAttribute('aria-busy')).toBe('true');
    expect(b.disabled).toBe(true);
  });

  it('survives a push that changes the row, as long as it does not settle', () => {
    const h = mount(twoMergeable());
    fireEvent.click(mergeRows()[0]!);
    h.emit({ type: 'state', state: stateWith([pr({ ...mergeable, opened: 'opened 3 days ago' }), apiPr(mergeable)]), settlesActions: false });
    expect(mergeRows()[0]!.disabled).toBe(true);
    expect(mergeRows()[0]!.title).toBe('Confirm the merge in the dialog');
  });

  it('is cleared by a settling state push (explicit true or absent) and the Merge control is back', () => {
    const h = mount(twoMergeable());
    fireEvent.click(mergeRows()[0]!);
    h.emit({ type: 'state', state: twoMergeable() });
    expect(mergeRows()[0]!.disabled).toBe(false);
    expect(mergeRows()[0]!.dataset.act).toBe('merge-pr');
    expect(mergeRows()[0]!.hasAttribute('aria-busy')).toBe(false);
    fireEvent.click(mergeRows()[1]!);
    h.emit({ type: 'state', state: twoMergeable(), settlesActions: true });
    expect(mergeRows()[1]!.disabled).toBe(false);
  });

  it('is cleared on a settling push even when the PR landed (the Merge control goes away)', () => {
    const h = mount(twoMergeable());
    fireEvent.click(mergeRows()[0]!);
    h.emit({ type: 'state', state: stateWith([pr({ status: 'merged' }), apiPr(mergeable)]) });
    expect(mergeRows()).toHaveLength(1);
  });

  it('settles the runtime request itself on the settling push: unknown while the PR is open, merged once it landed', () => {
    const h = mount(twoMergeable());
    fireEvent.click(mergeRows()[0]!);
    h.emit({ type: 'state', state: twoMergeable() });
    expect(settled).toEqual([['req-1', null, undefined]]);
    fireEvent.click(mergeRows()[1]!);
    h.emit({ type: 'state', state: stateWith([pr(mergeable), apiPr({ status: 'merged' })]) });
    expect(settled[1]).toEqual(['req-2', true, 'Merged.']);
  });

  it('shows a merge that the stage rail started as pending, and the panel Merge then posts nothing', () => {
    const h = mount(twoMergeable());
    act(() => h.ops().beginMerge(API, 'rail-1'));
    expect(mergeRows()[1]!.disabled).toBe(true);
    expect(mergeRows()[1]!.getAttribute('aria-busy')).toBe('true');
    expect(mergeRows()[1]!.title).toBe('Confirm the merge in the dialog');
    expect(mergeRows()[0]!.disabled).toBe(false);
    h.emit({ type: 'state', state: twoMergeable(), live: true, settlesActions: false });
    expect(mergeRows()[1]!.disabled).toBe(true);
    h.emit({ type: 'state', state: twoMergeable() });
    expect(mergeRows()[1]!.disabled).toBe(false);
  });
});

describe('PrsPanel — dismiss-pr / undismiss-pr (pending until the next settling state push)', () => {
  const dismissable = (over: Parameters<typeof pr>[0] = {}) => pr({ canDismiss: true, status: 'closed', ...over });
  const dismissed = () => pr({ status: 'closed', dismissed: true, dismissedLabel: 'dismissed Aug 11' });

  it('dismiss posts {repo} only, goes pending with the in-dialog wording and keeps its label', () => {
    const h = mount(stateWith([dismissable()]));
    const b = one('dismiss-pr');
    fireEvent.click(b);
    expect(h.send.dismissPr).toHaveBeenCalledTimes(1);
    expect(h.send.dismissPr.mock.calls[0]).toEqual([REPO]);
    expect(h.send.undismissPr).not.toHaveBeenCalled();
    expect(b.getAttribute('aria-busy')).toBe('true');
    expect(b.disabled).toBe(true);
    expect(b.title).toBe('Confirm in the dialog');
    expect(b.textContent).toBe('Dismiss');
    expect(b.hasAttribute('data-act')).toBe(false);
    keepsClass(b, 'k-btn k-btn--secondary k-btn--sm mgbtn');
    fireEvent.click(b);
    expect(h.send.dismissPr).toHaveBeenCalledTimes(1);
  });

  it('undismiss posts {repo} only and its pending label is the short "Undo"', () => {
    const h = mount(stateWith([dismissed()]));
    const b = one('undismiss-pr');
    fireEvent.click(b);
    expect(h.send.undismissPr).toHaveBeenCalledTimes(1);
    expect(h.send.undismissPr.mock.calls[0]).toEqual([REPO]);
    expect(h.send.dismissPr).not.toHaveBeenCalled();
    expect(b.textContent).toBe('Undo');
    expect(b.title).toBe('Confirm in the dialog');
    expect(b.disabled).toBe(true);
  });

  it('is pending for that repo only', () => {
    mount(stateWith([dismissable(), apiPr({ canDismiss: true, status: 'closed' })]));
    fireEvent.click(document.querySelector('[data-act="dismiss-pr"]')!);
    expect(document.querySelectorAll('[data-act="dismiss-pr"]')).toHaveLength(1);
  });

  it('survives passive and live pushes, then clears on a settling push', () => {
    const h = mount(stateWith([dismissable()]));
    fireEvent.click(one('dismiss-pr'));
    h.emit({ type: 'state', state: stateWith([dismissable()]), live: true, settlesActions: false });
    expect(document.querySelector('.mgbtn[aria-busy="true"]')).not.toBeNull();
    expect(settled).toEqual([]);
    h.emit({ type: 'state', state: stateWith([dismissed()]) });
    expect(document.querySelector('.mgbtn[aria-busy="true"]')).toBeNull();
    expect(one('undismiss-pr').disabled).toBe(false);
  });

  it('settles the runtime request true when the PR is still listed, unknown when it vanished', () => {
    const h = mount(stateWith([dismissable()]));
    fireEvent.click(one('dismiss-pr'));
    h.emit({ type: 'state', state: stateWith([dismissable()]) });
    expect(settled).toEqual([['req-1', true, undefined]]);
    fireEvent.click(one('dismiss-pr'));
    h.emit({ type: 'state', state: stateWith([]) });
    expect(settled[1]).toEqual(['req-2', null, undefined]);
  });
});

describe('PrsPanel — refresh-prs (pending until the next settling state push)', () => {
  it('posts nothing but its type, goes pending and swaps its name in label and title together', () => {
    const h = mount(stateWith([pr()]));
    const b = refreshBtn();
    fireEvent.click(b);
    expect(h.send.refreshPrs).toHaveBeenCalledTimes(1);
    expect(h.send.refreshPrs.mock.calls[0]).toEqual([]);
    expect(b.getAttribute('aria-busy')).toBe('true');
    expect(b.disabled).toBe(true);
    expect(b.getAttribute('aria-label')).toBe('Re-checking pull requests…');
    expect(b.title).toBe('Re-checking pull requests…');
    keepsClass(b, 'k-iconbtn iconbtn');
    fireEvent.click(b);
    expect(h.send.refreshPrs).toHaveBeenCalledTimes(1);
  });

  it('works with zero PRs and before the first snapshot', () => {
    const h = mount(stateWith([]));
    fireEvent.click(refreshBtn());
    expect(h.send.refreshPrs).toHaveBeenCalledTimes(1);
  });

  it('survives passive pushes, then a settling push settles the request true and idles the control', () => {
    const h = mount(stateWith([pr()]));
    fireEvent.click(refreshBtn());
    h.emit({ type: 'state', state: stateWith([pr()]), live: true, settlesActions: false });
    expect(refreshBtn().disabled).toBe(true);
    expect(settled).toEqual([]);
    h.emit({ type: 'state', state: stateWith([pr()]) });
    expect(settled).toEqual([['req-1', true, undefined]]);
    expect(refreshBtn().getAttribute('aria-label')).toBe('Re-check pull request status and mergeability now');
    expect(refreshBtn().hasAttribute('aria-busy')).toBe(false);
  });

  it('a settling push with no PRs still ends the refresh', () => {
    const h = mount(stateWith([]));
    fireEvent.click(refreshBtn());
    h.emit({ type: 'state', state: stateWith([]), settlesActions: true });
    expect(settled).toEqual([['req-1', true, undefined]]);
  });
});

describe('PrsPanel — send-ci-failure (pending until the next settling state push, one flag for every row)', () => {
  const ciState = () =>
    stateWith([pr({ checks: failing(['a', null]) }), apiPr({ checks: failing(['b', null]) })], { ci: { available: true, repos: [REPO, API] } });
  const ciBtns = (): HTMLButtonElement[] => [...document.querySelectorAll<HTMLButtonElement>('.mg-ci-failing .mgbtn')];

  it('posts its type only and disables every row’s button, here and in the stage menu', () => {
    const h = mount(ciState());
    fireEvent.click(ciBtns()[0]!);
    expect(h.send.sendCiFailure).toHaveBeenCalledTimes(1);
    expect(h.send.sendCiFailure.mock.calls[0]).toEqual([]);
    expect(h.ops().isRunning('ci')).toBe(true);
    for (const b of ciBtns()) {
      expect(b.getAttribute('aria-busy')).toBe('true');
      expect(b.disabled).toBe(true);
      expect(b.title).toBe('Fetching the failing logs');
      expect(b.textContent).toBe('Send CI failure to agent');
      expect(b.hasAttribute('data-act')).toBe(false);
      expect([...b.classList].filter((c) => c !== 'is-pending').join(' ')).toBe('k-btn k-btn--secondary k-btn--sm mgbtn');
    }
    keepsClass(ciBtns()[0]!, 'k-btn k-btn--secondary k-btn--sm mgbtn');
    fireEvent.click(ciBtns()[1]!);
    expect(h.send.sendCiFailure).toHaveBeenCalledTimes(1);
  });

  it('survives passive pushes and clears on a settling one', () => {
    const h = mount(ciState());
    fireEvent.click(ciBtns()[0]!);
    h.emit({ type: 'state', state: ciState(), live: true, settlesActions: false });
    expect(ciBtns().every((b) => b.disabled)).toBe(true);
    h.emit({ type: 'state', state: ciState() });
    expect(ciBtns().every((b) => !b.disabled && b.dataset.act === 'send-ci-failure')).toBe(true);
    // The shared operations settle the runtime request on that push: the ticket did not move, which is unknown, never failed.
    expect(settled).toEqual([['req-1', null, 'The ticket was not moved.']]);
  });

  it('shows a request the Inside stage menu started as pending, and clears it on the same push', () => {
    const h = mount(ciState());
    act(() => h.ops().beginAction('ci', 'menu-1'));
    expect(ciBtns().every((b) => b.disabled && b.getAttribute('aria-busy') === 'true')).toBe(true);
    fireEvent.click(ciBtns()[0]!);
    expect(h.send.sendCiFailure).not.toHaveBeenCalled();
    h.emit({ type: 'state', state: ciState() });
    expect(ciBtns().every((b) => !b.disabled)).toBe(true);
    expect(settled).toEqual([['menu-1', null, 'The ticket was not moved.']]);
  });
});

describe('PrsPanel — every act posts exactly once', () => {
  it.each([
    ['merge-pr', 'mergePr', stateWith([pr({ canMerge: true, mergeBlockedReason: '' })])],
    ['dismiss-pr', 'dismissPr', stateWith([pr({ canDismiss: true, status: 'closed' })])],
    ['undismiss-pr', 'undismissPr', stateWith([pr({ dismissed: true, status: 'closed' })])],
    ['open-pr', 'openPr', stateWith([pr()])],
    ['copy-pr-url', 'copyPrUrl', stateWith([pr()])],
    ['resolve-conflicts', 'resolveConflicts', stateWith([pr()], { mergeChecks: [mc()] })],
    ['send-ci-failure', 'sendCiFailure', stateWith([pr({ checks: failing(['a', null]) })], { ci: { available: true, repos: [REPO] } })],
    ['refresh-prs', 'refreshPrs', stateWith([pr()])],
  ] as const)('%s calls %s once and no other sender', (act, fn, state) => {
    const h = mount(state);
    fireEvent.click(one(act));
    const calls = Object.entries(h.send).filter(([, f]) => f.mock.calls.length > 0);
    expect(calls.map(([name, f]) => [name, f.mock.calls.length])).toEqual([[fn, 1]]);
  });
});
