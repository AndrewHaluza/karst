// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent } from '@testing-library/react';
import { openStore } from '../../../store/db.js';
import { parkGateStage } from '../../../store/stageBlocks.js';
import { setStage } from '../../../store/stages.js';
import { createTicket } from '../../../store/tickets.js';
import { buildDashboardState } from '../state.js';
import { installRuntimeDoubles } from './fixtures/prsPanelKit.js';
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

  it('shows an autopilot park (awaiting-merge, reason starts with auto-fix) with its reason', () => {
    mountRail(blockedState(block('awaiting-merge', { resumable: false, reason: 'auto-fix stopped: conflicts 2/2' })));
    expect(shown()).toBe(true);
    expect(banner().textContent).toContain('auto-fix stopped: conflicts 2/2');
    expect(banner().querySelector('[data-act="stage-resume"]')).toBeNull();
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
    expect(text('.ftitle')).toBe('Provider out of quota — UAT Tester');
    expect(text('.freason')).toBe(' · Provider quota exhausted until 5pm');
    expect(q('#blocked [data-act="stage-resume"]')).toBeNull();
  });

  it('names the review lane in the title when the park hit review', () => {
    mountRail(railState({ stageCurrent: 'review', currentStage: { stageKey: 'review', status: 'running', blocked: block('usage-limit', { resumable: false }) } }));
    expect(text('.ftitle')).toBe('Provider out of quota — Review findings');
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

describe('BlockedBanner — review stall (T845, T1001)', () => {
  const REASON = 'Review keeps finding new problems in a.ts (3 rounds) — likely a design problem, not a bug.';
  const view = (over: Record<string, unknown> = {}) => ({
    parkAt: 'P1', status: 'ready',
    rounds: [{ attempt: 0, runAt: AT, findings: [{ severity: 'critical', file: 'a.ts', line: 3, title: 'Bad split' }, { severity: 'low', file: null, line: null, title: 'Nit' }] }],
    diff: { fileCount: 2, stat: ' a.ts | 2 +-' }, current: { description: 'D', acceptanceCheck: 'C' }, cause: 'The scope is too wide.',
    options: [
      { kind: 'agent', label: 'Cut the scope', note: 'Remove the extra part.', description: 'New D', recommended: true },
      { kind: 'agent', label: 'Keep it', note: 'Keep and fix.', recommended: false },
    ],
    ...over,
  });
  const stalled = (stall: unknown) => blockedState(block('review-stalled', { resumable: false, reason: REASON }), { stall });

  it('names the stall, carries no Resume and no old stall answers', () => {
    mountRail(stalled(view()));
    expect(text('.ftitle')).toBe('Review is stalled');
    expect(q('#blocked [data-act="stage-resume"]')).toBeNull();
    expect(all('#blocked [data-act^="review-stall"]')).toHaveLength(0);
  });

  it('shows the evidence first, worst finding first, then the cause and the options', () => {
    mountRail(stalled(view()));
    const parts = all('#blocked [data-region]').map((r) => r.getAttribute('data-region'));
    expect(parts).toEqual(['stall-evidence', 'stall-options', 'stall-changes']);
    expect(text('[data-region="stall-evidence"]')).toContain('1 review round');
    expect(text('[data-region="stall-evidence"]')).toContain('2 files changed');
    expect(text('[data-region="stall-evidence"] li li')).toContain('critical');
    expect(banner().textContent).toContain('Likely cause: The scope is too wide.');
  });

  it('preselects the recommended option and shows one radio for one option', () => {
    mountRail(stalled(view()));
    const radios = all<HTMLInputElement>('#blocked input[type="radio"]');
    expect(radios.map((r) => r.checked)).toEqual([true, false]);
    cleanupRail();
    mountRail(stalled(view({ options: [{ kind: 'agent', label: 'Only', note: 'N', recommended: true }] })));
    expect(all('#blocked input[type="radio"]')).toHaveLength(1);
  });

  it('Apply posts the picked option with its edited note and one request id', () => {
    const h = mountRail(stalled(view()));
    fireEvent.click(all<HTMLInputElement>('#blocked input[type="radio"]')[1]!);
    const note = must<HTMLTextAreaElement>('#blocked [data-region="stall-changes"] textarea');
    fireEvent.change(note, { target: { value: 'My note' } });
    fireEvent.click(btn('stall-apply'));
    expect(h.send.stallApply).toHaveBeenCalledWith({ kind: 'agent', label: 'Keep it', note: 'My note' }, 'req-1');
  });

  it('sends a changed description only when the option changes it', () => {
    const h = mountRail(stalled(view()));
    fireEvent.click(btn('stall-apply'));
    expect(h.send.stallApply).toHaveBeenCalledWith({ kind: 'agent', label: 'Cut the scope', note: 'Remove the extra part.', description: 'New D' }, 'req-1');
  });

  it('disables Apply with a reason when the note is empty', () => {
    mountRail(stalled(view()));
    fireEvent.change(must<HTMLTextAreaElement>('#blocked [data-region="stall-changes"] textarea'), { target: { value: ' ' } });
    expect(btn('stall-apply').disabled).toBe(true);
  });

  it('says the findings stay unfixed for the accept option', () => {
    mountRail(stalled(view({ options: [{ kind: 'accept-docs', label: 'Accept the report as it is', note: 'The findings stay unfixed.', recommended: false }] })));
    expect(text('[data-region="stall-changes"]')).toContain('stay unfixed');
    expect(q('#blocked [data-region="stall-changes"] textarea')).toBeNull();
  });

  it('shows generating while there is no suggestion yet', () => {
    mountRail(stalled(null));
    expect(text('.stall-generating')).toContain('writing a suggestion');
    expect(q('#blocked [data-act="stall-apply"]')).toBeNull();
    // The user is never stuck: planning stays one click away while no row exists.
    expect(q('#blocked [data-act="stall-planning"]')).not.toBeNull();
    cleanupRail();
    mountRail(stalled(view({ status: 'generating', options: [] })));
    expect(q('#blocked [data-act="stall-apply"]')).toBeNull();
  });

  it('a failed suggestion offers Retry and planning, with no field', () => {
    const h = mountRail(stalled(view({ status: 'failed', options: [], usageLimit: true })));
    expect(banner().textContent).toContain('usage limit');
    expect(q('#blocked textarea')).toBeNull();
    fireEvent.click(btn('stall-retry'));
    expect(h.send.stallRetry).toHaveBeenCalledWith('req-1');
    fireEvent.click(btn('stall-planning'));
    expect(h.send.stallPlanning).toHaveBeenCalledTimes(1);
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
