// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent } from '@testing-library/react';
import { openStore } from '../../../store/db.js';
import { parkGateStage } from '../../../store/stageBlocks.js';
import { setStage } from '../../../store/stages.js';
import { createTicket } from '../../../store/tickets.js';
import { buildDashboardState } from '../state.js';
import { installRuntimeDoubles, settled } from './fixtures/prsPanelKit.js';
import { all, blockedState, cleanupRail, must, mountRail, q, railState, TICKET } from './fixtures/railKit.js';

installRuntimeDoubles();
afterEach(cleanupRail);

const AT = '2026-08-11T14:00:00.000Z';
const block = (kind: string, over: Record<string, unknown> = {}) => ({ kind, reason: 'api never became healthy', at: AT, resumable: true, ...over });
const banner = (): HTMLElement => must('#blocked');
const shown = (): boolean => !banner().classList.contains('hidden');
const text = (sel: string): string => q(`#blocked ${sel}`)?.textContent ?? '';
const btn = (act: string, extra = ''): HTMLButtonElement => must<HTMLButtonElement>(`#blocked [data-act="${act}"]${extra}`);

describe('BlockedBanner — when it shows', () => {
  it('stays hidden and empty before the first snapshot and with no block', () => {
    const h = mountRail(null);
    expect(shown()).toBe(false);
    expect(banner().childElementCount).toBe(0);
    h.emit({ type: 'state', state: blockedState(undefined) });
    expect(shown()).toBe(false);
    expect(banner().childElementCount).toBe(0);
  });

  it('shows a resumable fault and hides again when the block clears', () => {
    const h = mountRail(blockedState(block('boot-failed')));
    expect(shown()).toBe(true);
    expect(banner().classList.contains('fault')).toBe(true);
    h.emit({ type: 'state', state: blockedState(undefined) });
    expect(shown()).toBe(false);
    expect(banner().childElementCount).toBe(0);
  });

  it('keeps the non-resumable usage-limit and baseline-review blocks, but renders NOTHING for an awaiting-merge wait', () => {
    mountRail(blockedState(block('usage-limit', { resumable: false })));
    expect(shown()).toBe(true);
    cleanupRail();
    mountRail(blockedState(block('baseline-review', { resumable: false }), { baselineReview: [] }));
    expect(shown()).toBe(true);
    cleanupRail();
    mountRail(blockedState(block('awaiting-merge', { resumable: false })));
    expect(shown()).toBe(false);
    expect(banner().childElementCount).toBe(0);
  });

  it('reads the real host path: an awaiting-merge park renders no banner, an unmapped repository offers Resume', () => {
    const park = (kind: string, stage: 'ship' | 'uat', reason: string) => {
      const store = openStore(':memory:');
      const t = createTicket(store, { key: 'BLK-9', title: 'parked' });
      setStage(store, t.id, stage, { status: stage === 'ship' ? 'passed' : 'running', startedAt: '2026-08-09T10:00:00.000Z' });
      parkGateStage(store, { ticketId: t.id, stageKey: stage, kind: kind as never, reason, runAt: '2026-08-09T10:33:42.000Z', gates: [] });
      store.db.prepare('UPDATE tickets SET stage_current = ? WHERE id = ?').run(stage, t.id);
      const state = buildDashboardState(store, t.id);
      store.close();
      return state;
    };
    mountRail(park('awaiting-merge', 'ship', 'PR #412 is open and unmerged'));
    expect(shown()).toBe(false);
    expect(banner().childElementCount).toBe(0);
    cleanupRail();
    mountRail(park('unmapped-repository', 'uat', 'these worktrees match no repository in karst.yml: /unmapped'));
    expect(text('.freason')).toBe(' · these worktrees match no repository in karst.yml: /unmapped');
    expect(btn('stage-resume').dataset.stagekey).toBe('uat');
  });
});

describe('BlockedBanner — a resumable fault', () => {
  it('names the stage, shows the machine reason, and offers Resume on the block’s own key, never the rail’s data-stage', () => {
    mountRail(blockedState(block('boot-failed')));
    expect(text('.ftitle')).toBe('UAT is blocked');
    expect(text('.freason')).toBe(' · api never became healthy');
    const b = btn('stage-resume');
    expect(b.className).toBe('k-btn k-btn--primary k-btn--sm');
    expect(b.title).toBe('Clear the block and let karst try this stage again');
    expect(b.dataset.stagekey).toBe('uat');
    expect(b.hasAttribute('data-stage')).toBe(false);
    expect(b.closest('.facts')).not.toBeNull();
  });

  it('posts stage-resume with the ticket id, the stage key and a request id exactly once, and goes pending', () => {
    const h = mountRail(blockedState(block('boot-failed')));
    const b = btn('stage-resume');
    fireEvent.click(b);
    fireEvent.click(b);
    expect(h.send.stageResume).toHaveBeenCalledTimes(1);
    expect(h.send.stageResume).toHaveBeenCalledWith(TICKET, 'uat', 'req-1');
    expect(b.getAttribute('aria-busy')).toBe('true');
    expect(b.disabled).toBe(true);
  });

  it('keeps the pending Resume as the very same node, class and all, across a live push', () => {
    const h = mountRail(blockedState(block('boot-failed')));
    const b = btn('stage-resume');
    fireEvent.click(b);
    h.emit({ type: 'state', state: blockedState(block('boot-failed')), live: true });
    expect(btn('stage-resume')).toBe(b);
    expect(b.classList.contains('is-pending')).toBe(true);
    expect(b.className).toContain('k-btn--primary');
  });
});

describe('BlockedBanner — usage-limit park actions (D159, re-homed from the vanilla page)', () => {
  const parked = () => blockedState(block('usage-limit', { resumable: false, reason: 'Provider quota exhausted until 5pm' }));

  it('says why the stage stopped and carries no Resume', () => {
    mountRail(parked());
    expect(text('.ftitle')).toBe('Provider out of quota');
    expect(text('.freason')).toBe(' · Provider quota exhausted until 5pm');
    expect(q('#blocked [data-act="stage-resume"]')).toBeNull();
  });

  it('offers Pick agent/model…, Retry same and Dismiss, in that order and treatment', () => {
    mountRail(parked());
    const buttons = all<HTMLButtonElement>('#blocked .facts button');
    expect(buttons.map((b) => b.dataset.act)).toEqual(['usage-limit-pick', 'usage-limit-retry', 'usage-limit-dismiss']);
    expect(buttons.map((b) => b.textContent)).toEqual(['Pick agent/model…', 'Retry same', 'Dismiss']);
    expect(buttons.map((b) => b.className)).toEqual(['k-btn k-btn--primary k-btn--sm', 'k-btn k-btn--secondary k-btn--sm', 'k-btn k-btn--secondary k-btn--sm k-btn--ghost']);
    expect(buttons.map((b) => b.dataset.stagekey)).toEqual(['uat', 'uat', 'uat']);
  });

  it.each([
    ['usage-limit-pick', 'usageLimitPick'],
    ['usage-limit-retry', 'usageLimitRetry'],
    ['usage-limit-dismiss', 'usageLimitDismiss'],
  ] as const)('%s posts exactly once with the ticket id, the stage key and a request id, and is pending afterwards', (act, sender) => {
    const h = mountRail(parked());
    const b = btn(act);
    fireEvent.click(b);
    fireEvent.click(b);
    expect(h.send[sender]).toHaveBeenCalledTimes(1);
    expect(h.send[sender]).toHaveBeenCalledWith(TICKET, 'uat', 'req-1');
    expect(b.getAttribute('aria-busy')).toBe('true');
    for (const other of ['usageLimitPick', 'usageLimitRetry', 'usageLimitDismiss'] as const) {
      if (other !== sender) expect(h.send[other]).not.toHaveBeenCalled();
    }
    expect(h.send.stageResume).not.toHaveBeenCalled();
  });
});

describe('BlockedBanner — resource kill (T853)', () => {
  const killed = () => blockedState(block('resource-killed', { resumable: true, reason: 'Gate "unit" was killed (exit 137) in the sandbox.' }));

  it('names the fault and offers Run gate on host then Retry', () => {
    mountRail(killed());
    expect(text('.ftitle')).toBe('Gate ran out of memory');
    const buttons = all<HTMLButtonElement>('#blocked .facts button');
    expect(buttons.map((b) => b.dataset.act)).toEqual(['run-gate-on-host', 'stage-resume']);
    expect(buttons.map((b) => b.textContent)).toEqual(['Run gate on host', 'Retry']);
  });

  it('each button posts once with the ticket and stage', () => {
    const h = mountRail(killed());
    fireEvent.click(btn('run-gate-on-host'));
    fireEvent.click(btn('stage-resume'));
    expect(h.send.runGateOnHost).toHaveBeenCalledWith(TICKET, 'uat', 'req-1');
    expect(h.send.stageResume).toHaveBeenCalledTimes(1);
  });
});

describe('BlockedBanner — review stall (T845)', () => {
  const stalled = () => blockedState(block('review-stalled', { resumable: false, reason: 'Review keeps finding new problems in a.ts (3 rounds) — likely a design problem, not a bug.' }));

  it('names the stall, carries no Resume and offers the three answers in order', () => {
    mountRail(stalled());
    expect(text('.ftitle')).toBe('Review is stalled');
    expect(q('#blocked [data-act="stage-resume"]')).toBeNull();
    const buttons = all<HTMLButtonElement>('#blocked .facts button');
    expect(buttons.map((b) => b.dataset.act)).toEqual(['review-stall-hint', 'review-stall-continue', 'review-stall-rescope']);
    expect(buttons.map((b) => b.textContent)).toEqual(['Redesign hint…', 'Continue anyway', 'Re-scope']);
  });

  it.each([
    ['review-stall-hint', 'reviewStallHint'],
    ['review-stall-continue', 'reviewStallContinue'],
    ['review-stall-rescope', 'reviewStallRescope'],
  ] as const)('%s posts once with a request id', (act, sender) => {
    const h = mountRail(stalled());
    const b = btn(act);
    fireEvent.click(b);
    fireEvent.click(b);
    expect(h.send[sender]).toHaveBeenCalledTimes(1);
    expect(h.send[sender]).toHaveBeenCalledWith('req-1');
  });
});

describe('BlockedBanner — baseline review (@arch:BASELINE-REVIEW)', () => {
  const ROWS = [
    { index: 0, path: 'tests/visual/a/settings.png', label: 'a/settings.png', status: 'modified', oldSrc: 'vscode-webview://x/old.png', newSrc: 'vscode-webview://x/new.png', decision: 'pending', reason: null },
    { index: 1, path: 'tests/visual/b.png', label: 'b.png', status: 'added', oldSrc: null, newSrc: 'vscode-webview://x/b.png', decision: 'approved', reason: null },
    { index: 2, path: 'tests/visual/ledger.json', label: 'ledger.json', status: 'modified', oldSrc: null, newSrc: null, decision: 'rejected', reason: 'ledger grew' },
  ];
  const review = (rows: unknown = ROWS) => blockedState(block('baseline-review', { resumable: false, reason: '2 visual baseline(s) changed' }), { baselineReview: rows });
  const row = (n: number): HTMLElement => all('#blocked .blrow')[n]!;

  it('is "Review baselines" with a head count and one row per file, and no Resume', () => {
    mountRail(review());
    expect(text('.ftitle')).toBe('Review baselines');
    expect(text('.freason')).toBe('2 visual baseline(s) changed');
    expect(q('#blocked [data-act="stage-resume"]')).toBeNull();
    expect(text('.blhead span')).toBe('2 of 3 changed baselines need your approval');
    expect(btn('baseline-approve', '.bl-all').dataset.indices).toBe('0,2');
    expect(btn('baseline-approve', '.bl-all').dataset.blockId).toBe('baseline-review');
    expect(all('#blocked .blrow')).toHaveLength(3);
    expect(row(0).getAttribute('aria-label')).toBe('Baseline a/settings.png');
  });

  it('speaks in singular and drops Approve all when nothing is left to approve', () => {
    mountRail(review([ROWS[0]]));
    expect(text('.blhead span')).toBe('1 of 1 changed baseline needs your approval');
    cleanupRail();
    mountRail(review([ROWS[1]]));
    expect(text('.blhead span')).toBe('0 of 1 changed baseline need your approval');
    expect(q('#blocked .bl-all')).toBeNull();
  });

  it('states the decision as a word with a glyph, never colour alone', () => {
    mountRail(review());
    expect(all('#blocked .blstate').map((s) => s.textContent)).toEqual(['○ Needs review', '✓ Approved', '✕ Rejected']);
    expect(all('#blocked .blstate').map((s) => s.className)).toEqual(['blstate pending', 'blstate approved', 'blstate rejected']);
    expect(all('#blocked .bl-status').map((s) => s.textContent)).toEqual(['modified', 'new file', 'modified']);
    expect(row(2).textContent).toContain('Rejected: ledger grew');
    expect(row(2).textContent).toContain('No preview for this file type — open it from Source Control.');
  });

  it('allowlists the enums and coerces the index, so a newer host cannot inject markup or ids', () => {
    mountRail(review([{ ...ROWS[0], index: 7.9, status: 'weird', decision: 'odd' }]));
    expect(text('.bl-status')).toBe('modified');
    expect(text('.blstate')).toBe('○ Needs review');
    expect(btn('baseline-approve', ':not(.bl-all)').dataset.indices).toBe('7');
  });

  it('shows the difference of a modified image by default (both images stacked), and New for an added file', () => {
    mountRail(review());
    const diff = row(0).querySelector('.blstage .bldiff')!;
    expect([...diff.querySelectorAll('img')].map((i) => [i.getAttribute('src'), i.getAttribute('alt')])).toEqual([
      ['vscode-webview://x/old.png', 'Old a/settings.png'],
      ['vscode-webview://x/new.png', 'Difference for a/settings.png'],
    ]);
    expect(row(0).querySelector('.blstage .blnote')!.textContent).toBe('Unchanged pixels are black.');
    expect(row(1).querySelector('.blstage img')!.getAttribute('alt')).toBe('New b.png');
    expect(row(1).querySelector('[data-view="new"]')!.getAttribute('aria-pressed')).toBe('true');
  });

  it('toggles Old | New | Difference locally with aria-pressed, posting and pending nothing', () => {
    const h = mountRail(review());
    const old = row(0).querySelector<HTMLButtonElement>('[data-act="baseline-view"][data-view="old"]')!;
    fireEvent.click(old);
    expect(row(0).querySelector('[data-view="old"]')!.getAttribute('aria-pressed')).toBe('true');
    expect(row(0).querySelector('[data-view="diff"]')!.getAttribute('aria-pressed')).toBe('false');
    expect(row(0).querySelector('.bldiff')).toBeNull();
    expect(row(0).querySelector('.blstage img')!.getAttribute('alt')).toBe('Old a/settings.png');
    expect(old.hasAttribute('aria-busy')).toBe(false);
    for (const fn of Object.values(h.send)) expect(fn).not.toHaveBeenCalled();
    expect(all('#blocked .blseg button').map((b) => b.textContent)).toEqual(['Old', 'New', 'Difference', 'Old', 'New', 'Difference']);
  });

  it('says why an image is missing on the side that has none', () => {
    mountRail(review([{ ...ROWS[1], decision: 'pending' }]));
    fireEvent.click(row(0).querySelector('[data-view="old"]')!);
    expect(row(0).querySelector('.blstage .blnote')!.textContent).toBe('New file — there is no old image.');
    fireEvent.click(row(0).querySelector('[data-view="diff"]')!);
    expect(row(0).querySelector('.blstage .blnote')!.textContent).toBe('New file — nothing to compare.');
  });

  it('Approve and Approve all post the block id and indices only, with a request id, once each', () => {
    const h = mountRail(review());
    const all1 = btn('baseline-approve', '.bl-all');
    fireEvent.click(all1);
    fireEvent.click(all1);
    expect(h.send.baselineApprove).toHaveBeenCalledTimes(1);
    expect(h.send.baselineApprove).toHaveBeenCalledWith('baseline-review', [0, 2], 'req-1');
    expect(all1.getAttribute('aria-busy')).toBe('true');
    fireEvent.click(row(0).querySelector('[data-act="baseline-approve"]')!);
    expect(h.send.baselineApprove).toHaveBeenLastCalledWith('baseline-review', [0], 'req-2');
    expect(row(1).querySelector('[data-act="baseline-approve"]')).toBeNull();
  });

  it('Reject opens a focused reason field; an empty reason names the field, posts nothing and starts no pending state', () => {
    const h = mountRail(review());
    fireEvent.click(btn('baseline-reject-open', '[data-index="0"]'));
    const ta = must<HTMLTextAreaElement>('#blreason-0');
    expect(document.activeElement).toBe(ta);
    expect(ta.required).toBe(true);
    expect(must('label[for="blreason-0"]').textContent).toBe('Why is this wrong? The fix agent reads this.');
    expect(q('#blocked [data-act="baseline-reject-open"][data-index="0"]')).toBeNull();
    ta.blur();
    const send = btn('baseline-reject', '[data-index="0"]');
    fireEvent.click(send);
    expect(h.send.baselineReject).not.toHaveBeenCalled();
    expect(send.hasAttribute('aria-busy')).toBe(false);
    expect(ta.getAttribute('aria-invalid')).toBe('true');
    expect(ta.getAttribute('aria-describedby')).toBe('blreason-err-0');
    expect(must('#blreason-err-0').textContent).toBe('A reason is required.');
    expect(must('#blreason-err-0').getAttribute('role')).toBe('alert');
    expect(document.activeElement).toBe(ta);
  });

  it('Reject posts the trimmed typed reason with the entry index, a request id, once', () => {
    const h = mountRail(review());
    fireEvent.click(btn('baseline-reject-open', '[data-index="0"]'));
    fireEvent.input(must('#blreason-0'), { target: { value: '  button is clipped  ' } });
    const send = btn('baseline-reject', '[data-index="0"]');
    fireEvent.click(send);
    fireEvent.click(send);
    expect(h.send.baselineReject).toHaveBeenCalledTimes(1);
    expect(h.send.baselineReject).toHaveBeenCalledWith('baseline-review', 0, 'button is clipped', 'req-1');
    expect(send.getAttribute('aria-busy')).toBe('true');
  });

  it('counts a reason typed with a bare input event (the value set underneath React), like the vanilla field did', () => {
    const h = mountRail(review());
    fireEvent.click(btn('baseline-reject-open', '[data-index="0"]'));
    const ta = must<HTMLTextAreaElement>('#blreason-0');
    ta.value = 'wrong colour';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    fireEvent.click(btn('baseline-reject', '[data-index="0"]'));
    expect(h.send.baselineReject).toHaveBeenCalledWith('baseline-review', 0, 'wrong colour', 'req-1');
  });

  it('Cancel closes the form and keeps the draft for the next time it opens', () => {
    mountRail(review());
    fireEvent.click(btn('baseline-reject-open', '[data-index="0"]'));
    fireEvent.input(must('#blreason-0'), { target: { value: 'half a thought' } });
    fireEvent.click(btn('baseline-reject-cancel'));
    expect(q('#blreason-0')).toBeNull();
    expect(btn('baseline-reject-open', '[data-index="0"]')).not.toBeNull();
    fireEvent.click(btn('baseline-reject-open', '[data-index="0"]'));
    expect(must<HTMLTextAreaElement>('#blreason-0').value).toBe('half a thought');
  });

  it('keeps the open form, its draft and its focus across a live repaint, and drops it once the row is rejected', () => {
    const h = mountRail(review());
    fireEvent.click(btn('baseline-reject-open', '[data-index="0"]'));
    const ta = must<HTMLTextAreaElement>('#blreason-0');
    fireEvent.input(ta, { target: { value: 'draft' } });
    h.emit({ type: 'state', state: review(), live: true });
    expect(must('#blreason-0')).toBe(ta);
    expect(ta.value).toBe('draft');
    expect(document.activeElement).toBe(ta);
    h.emit({ type: 'state', state: review([{ ...ROWS[0], decision: 'rejected', reason: 'draft' }, ROWS[1], ROWS[2]]) });
    expect(q('#blreason-0')).toBeNull();
    expect(btn('baseline-reject-open', '[data-index="0"]')).not.toBeNull();
  });

  it('settles nothing by itself: a decision waits for the host’s action-result', () => {
    const h = mountRail(review());
    fireEvent.click(btn('baseline-approve', '.bl-all'));
    h.emit({ type: 'state', state: review() });
    expect(settled).toEqual([]);
  });
});

describe('BlockedBanner — slice selection (migration plan A4)', () => {
  it('does not render again for a push whose block is unchanged, and does for a changed reason', () => {
    const onRender = vi.fn();
    const make = (reason = 'x') => blockedState(block('boot-failed', { reason }), { clock: reason });
    const h = mountRail(make(), { onRender });
    const before = onRender.mock.calls.length;
    h.emit({ type: 'state', state: { ...make(), clock: 't2' } as never, live: true });
    expect(onRender.mock.calls.length).toBe(before);
    h.emit({ type: 'state', state: make('y') });
    expect(onRender.mock.calls.length).toBeGreaterThan(before);
    expect(text('.freason')).toBe(' · y');
  });

  it('is independent of the rail: a plain rail change leaves the banner node alone', () => {
    const h = mountRail(blockedState(block('boot-failed')));
    const node = must('#blocked .ftitle');
    h.emit({ type: 'state', state: { ...railState({ stageCurrent: 'uat' }), currentStage: { stageKey: 'uat', status: 'running', blocked: block('boot-failed') } } as never });
    expect(must('#blocked .ftitle')).toBe(node);
  });
});

describe('BlockedBanner — tester skipped (T861)', () => {
  const skipped = () =>
    blockedState(block('tester-skipped', { resumable: false, reason: 'tester observed nothing — uat:host probe not run' }));

  it('says what the tester did and carries no Resume', () => {
    mountRail(skipped());
    expect(shown()).toBe(true);
    expect(text('.freason')).toBe(' · The UAT tester observed nothing: uat:host probe not run');
    expect(q('#blocked [data-act="stage-resume"]')).toBeNull();
  });

  it('offers Re-run tester then Accept skip, in that order', () => {
    mountRail(skipped());
    const buttons = all<HTMLButtonElement>('#blocked .facts button');
    expect(buttons.map((b) => b.dataset.act)).toEqual(['tester-skipped-rerun', 'tester-skipped-accept']);
    expect(buttons.map((b) => b.textContent)).toEqual(['Re-run tester', 'Accept skip']);
  });

  it.each([
    ['tester-skipped-rerun', 'testerSkippedRerun'],
    ['tester-skipped-accept', 'testerSkippedAccept'],
  ] as const)('%s posts exactly once with a request id', (act, sender) => {
    const h = mountRail(skipped());
    const b = btn(act);
    fireEvent.click(b);
    fireEvent.click(b);
    expect(h.send[sender]).toHaveBeenCalledTimes(1);
    expect(h.send[sender]).toHaveBeenCalledWith('req-1');
    expect(h.send.stageResume).not.toHaveBeenCalled();
  });
});

describe('BlockedBanner — push diverged', () => {
  const diverged = () =>
    blockedState(
      block('push-diverged', {
        resumable: false,
        reason: '/repo/fe: origin/karst/x is at ' + 'c'.repeat(40) + ' with 1 commit(s) not in the branch:\nabc1234 fix: theirs',
      }),
    );

  it('offers only Fix push at first, with no Resume', () => {
    mountRail(diverged());
    expect(all<HTMLButtonElement>('#blocked .facts button').map((b) => b.textContent)).toEqual(['Fix push']);
    expect(q('#blocked [data-act="stage-resume"]')).toBeNull();
  });

  it('Fix push reveals the foreign commits and the two choices', () => {
    const h = mountRail(diverged());
    fireEvent.click(btn('push-diverged-fix'));
    expect(text('[data-role="foreign-commits"]')).toBe('abc1234 fix: theirs');
    expect(all<HTMLButtonElement>('#blocked button').map((b) => b.textContent)).toEqual(['Overwrite remote', 'Integrate']);
    fireEvent.click(btn('push-diverged-overwrite'));
    expect(h.send.pushDivergedOverwrite).toHaveBeenCalledWith('req-1');
  });
});
