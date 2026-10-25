// @vitest-environment jsdom
/** The React stage rail and blocked banner must cooperate with the vanilla page: selection, Inside, persistence, the shared seams. */
import { afterEach, describe, expect, it } from 'vitest';
import { drainReactWork, renderWebview, renderWebviewReady, waitForSettingsReady, type RenderHandle } from '../../testing/renderHarness.js';
import { populatedStateFor, shipPreviewStateFor } from '../renderFixtures.js';
import type { DashboardState } from '../state.js';
import { buildStageRail } from '../../../model/stageRail.js';

let h: RenderHandle | null = null;
afterEach(() => { h?.close(); h = null; });

const open = async (state: DashboardState = populatedStateFor('impl')): Promise<RenderHandle> => {
  h = await renderWebviewReady('dashboard');
  h.receive({ type: 'state', state });
  await drainReactWork(h);
  return h;
};
const push = async (v: RenderHandle, state: DashboardState, extra: Record<string, unknown> = {}): Promise<void> => {
  v.receive({ type: 'state', state, ...extra });
  await drainReactWork(v);
};
const click = async (v: RenderHandle, sel: string): Promise<void> => {
  v.click(sel);
  await drainReactWork(v);
};
const escape = async (v: RenderHandle): Promise<void> => {
  v.document.body.dispatchEvent(new v.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  await drainReactWork(v);
};
const types = (v: RenderHandle, from: number): string[] => (v.posted.slice(from) as Array<{ type: string }>).map((m) => m.type);
const persistedSel = (v: RenderHandle): unknown => (v.state as { sel?: unknown } | undefined)?.sel;
const pressed = (v: RenderHandle): string[] => v.queryAll<HTMLElement>('#rail .pick').filter((p) => p.getAttribute('aria-pressed') === 'true').map((p) => p.dataset.stage!);
const viewing = (v: RenderHandle): string => v.query('#inside .vbar')?.textContent ?? '';

const withNeeds = (state: DashboardState, stage: string, cta: Record<string, unknown>): DashboardState => {
  const rail = buildStageRail(state.stepper, state.stepper, {
    current: stage, needsUser: true, needs: { detail: 'needs you', action: 'Do it', cta },
  } as unknown as Parameters<typeof buildStageRail>[2]);
  return { ...state, rail } as DashboardState;
};
const REPO = 'fixture:/repos/web';
const shipConfirm = (): DashboardState => withNeeds(shipPreviewStateFor('ready'), 'ship', { kind: 'ship-confirm' });
const mergeNeeds = (): DashboardState => {
  const s = populatedStateFor('ship');
  return withNeeds({ ...s, prs: [{ ...s.prs[0]!, canMerge: true, mergeBlockedReason: '' }] } as DashboardState, 'ship', { kind: 'merge', repo: REPO });
};
const blockedAt = (blocked: Record<string, unknown>, over: Record<string, unknown> = {}): DashboardState => {
  const s = populatedStateFor('uat');
  const cell = s.stepper.find((c) => c.stageKey === 'uat')!;
  return { ...s, currentStage: { ...cell, blocked: { reason: 'quota exhausted', at: '2026-08-12T10:00:00.000Z', resumable: false, ...blocked } }, ...over } as DashboardState;
};
const menuState = (): DashboardState => ({ ...populatedStateFor('ship'), sendBack: { available: true, stage: 'ship' } }) as DashboardState;

describe('React rail / vanilla Inside interop — stage selection', () => {
  it('a rail click selects the stage, re-renders the vanilla Inside for it, and the page persists sel', async () => {
    const v = await open();
    expect(pressed(v)).toEqual(['impl']);
    expect(viewing(v)).toBe('');
    const before = v.posted.length;
    await click(v, '#rail .pick[data-stage="scope"]');
    expect(pressed(v)).toEqual(['scope']);
    expect(viewing(v)).toMatch(/^Viewing Scope — not the current stage\./);
    expect(persistedSel(v)).toBe('scope');
    expect(v.posted.length).toBe(before);
    expect(v.errors).toEqual([]);
  });

  it('Back in the vanilla Inside returns the rail to the current stage, and persists the reset', async () => {
    const v = await open();
    await click(v, '#rail .pick[data-stage="uat"]');
    expect(pressed(v)).toEqual(['uat']);
    await click(v, '#inside [data-back]');
    expect(pressed(v)).toEqual(['impl']);
    expect(viewing(v)).toBe('');
    expect(persistedSel(v)).toBeNull();
  });

  it('keeps the selection across a state push, a live push and the next tick', async () => {
    const v = await open();
    await click(v, '#rail .pick[data-stage="review"]');
    await push(v, populatedStateFor('impl'));
    await push(v, populatedStateFor('impl'), { live: true });
    expect(pressed(v)).toEqual(['review']);
    expect(viewing(v)).toMatch(/Viewing Review/);
    expect(persistedSel(v)).toBe('review');
  });

  it('a new ship wait auto-selects Ship once in both the rail and Inside, and the user can leave it', async () => {
    const v = await open();
    await push(v, shipConfirm());
    expect(pressed(v)).toEqual(['ship']);
    expect(persistedSel(v)).toBe('ship');
    await click(v, '#rail .pick[data-stage="uat"]');
    await push(v, shipConfirm());
    expect(pressed(v)).toEqual(['uat']);
  });

  it('a reload restores the persisted selection in the rail and the Inside together', async () => {
    h = renderWebview('dashboard', { persistedState: { state: populatedStateFor('impl'), sel: 'uat' } });
    await waitForSettingsReady(h);
    await drainReactWork(h);
    expect(pressed(h)).toEqual(['uat']);
    expect(viewing(h)).toMatch(/^Viewing UAT/);
    expect(h.errors).toEqual([]);
  });

  it('tolerates a persisted state from before the envelope existed', async () => {
    h = renderWebview('dashboard', { persistedState: populatedStateFor('impl') });
    await waitForSettingsReady(h);
    await push(h, populatedStateFor('impl'));
    expect(pressed(h)).toEqual(['impl']);
    expect(h.errors).toEqual([]);
  });
});

describe('React rail / vanilla page interop — outside clicks and Escape', () => {
  it('a click inside the rail or the banner closes the header popovers', async () => {
    const v = await open(blockedAt({ kind: 'usage-limit' }));
    await click(v, '#agentButton');
    expect(v.query('#agentPopover')!.classList.contains('hidden')).toBe(false);
    await click(v, '#rail .pick[data-stage="uat"]');
    expect(v.query('#agentPopover')!.classList.contains('hidden')).toBe(true);
    await click(v, '#moreBtn');
    expect(v.query('#menuPopover')!.classList.contains('hidden')).toBe(false);
    await click(v, '#blocked .freason');
    expect(v.query('#menuPopover')!.classList.contains('hidden')).toBe(true);
  });

  it('selecting a stage in the rail closes the open Inside stage menu, as the vanilla rail click did', async () => {
    const v = await open(menuState());
    await click(v, '[data-stage-menu="ship"]');
    expect(v.query('[data-act="send-back-to-implement"]')).not.toBeNull();
    await click(v, '#rail .pick[data-stage="ship"]');
    expect(v.query('[data-act="send-back-to-implement"]')).toBeNull();
  });

  it('Escape still closes the open Inside stage menu', async () => {
    const v = await open(menuState());
    await click(v, '[data-stage-menu="ship"]');
    expect(v.query('[data-act="send-back-to-implement"]')).not.toBeNull();
    await escape(v);
    expect(v.query('[data-act="send-back-to-implement"]')).toBeNull();
  });

  it('Escape leaves an open baseline reject form, and its draft, alone', async () => {
    const rows = [{ index: 0, path: 'a.png', label: 'a.png', status: 'modified', oldSrc: null, newSrc: null, decision: 'pending', reason: null }];
    const v = await open(blockedAt({ kind: 'baseline-review' }, { baselineReview: rows }));
    await click(v, '[data-act="baseline-reject-open"]');
    const ta = v.query<HTMLTextAreaElement>('#blreason-0')!;
    ta.value = 'draft';
    ta.dispatchEvent(new v.window.Event('input', { bubbles: true }));
    await escape(v);
    expect(v.query('#blreason-0')).toBe(ta);
    expect(ta.value).toBe('draft');
  });
});

describe('React rail and banner — one post per click, one request per operation', () => {
  it.each([
    ['usage-limit-pick'],
    ['usage-limit-retry'],
    ['usage-limit-dismiss'],
  ])('park action %s posts exactly once with the exact payload, and is pending until the host answers', async (act) => {
    const v = await open(blockedAt({ kind: 'usage-limit' }));
    const before = v.posted.length;
    await click(v, `#blocked [data-act="${act}"]`);
    await click(v, `#blocked [data-act="${act}"]`);
    const sent = v.posted.slice(before) as Array<Record<string, unknown>>;
    expect(sent).toHaveLength(1);
    const { requestId, ...rest } = sent[0]!;
    expect(rest).toEqual({ type: act, ticketId: 942017, stageKey: 'uat' });
    expect(typeof requestId).toBe('string');
    const b = v.query<HTMLButtonElement>(`#blocked [data-act="${act}"]`)!;
    expect(b.getAttribute('aria-busy')).toBe('true');
    expect(b.disabled).toBe(true);
    // The host answers through action-result; the page's one handler settles the runtime request.
    v.receive({ type: 'action-result', requestId, ok: true });
    await drainReactWork(v);
    expect(b.hasAttribute('aria-busy')).toBe(false);
    expect(b.disabled).toBe(false);
  });

  it('Resume posts once, and a live push keeps it pending', async () => {
    const v = await open(blockedAt({ kind: 'boot-failed', resumable: true }));
    const before = v.posted.length;
    await click(v, '#blocked [data-act="stage-resume"]');
    await push(v, blockedAt({ kind: 'boot-failed', resumable: true }), { live: true });
    await click(v, '#blocked [data-act="stage-resume"]');
    expect(types(v, before)).toEqual(['stage-resume']);
    expect(v.query('#blocked [data-act="stage-resume"]')!.getAttribute('aria-busy')).toBe('true');
  });

  it('the rail Resolve conflicts button posts once with a request id', async () => {
    const s = withNeeds(populatedStateFor('ship'), 'ship', { kind: 'resolve-conflicts', repo: REPO });
    const v = await open(s);
    const before = v.posted.length;
    await click(v, '#rail .go[data-act="resolve-conflicts"]');
    await click(v, '#rail .go[data-act="resolve-conflicts"]');
    expect(v.posted.slice(before)).toEqual([expect.objectContaining({ type: 'resolve-conflicts', repo: REPO, requestId: expect.any(String) })]);
  });

  it('rail Merge and the PR panel Merge are one operation: one dialog, however the second click arrives', async () => {
    const v = await open(mergeNeeds());
    const before = v.posted.length;
    await click(v, '#rail .go[data-act="merge-pr"]');
    await click(v, '#prs .pacts .mgbtn:last-child');
    await click(v, '#rail .go[data-act="merge-pr"]');
    expect(v.posted.slice(before)).toEqual([{ type: 'merge-pr', repo: REPO }]);
    expect(v.query<HTMLButtonElement>('#prs .pacts .mgbtn:last-child')!.disabled).toBe(true);
    expect(v.query('#rail .go')!.getAttribute('aria-busy')).toBe('true');
  });

  it('the panel starting the merge holds the rail Merge just the same, and a merged answer settles both with the toast', async () => {
    const v = await open(mergeNeeds());
    const before = v.posted.length;
    await click(v, '#prs .pacts .mgbtn:last-child');
    expect(v.query('#rail .go')!.getAttribute('aria-busy')).toBe('true');
    await click(v, '#rail .go[data-act="merge-pr"]');
    expect(types(v, before)).toEqual(['merge-pr']);
    const merged = mergeNeeds();
    await push(v, { ...merged, prs: [{ ...merged.prs[0]!, status: 'merged' }] } as DashboardState);
    expect(v.query('#rail .go')?.hasAttribute('aria-busy') ?? false).toBe(false);
    expect(v.errors).toEqual([]);
  });

  it('rail Ship and the header Confirm ship are one operation too, from either side', async () => {
    const v = await open(shipConfirm());
    const before = v.posted.length;
    await click(v, '#rail .go[data-act="ship-ticket"]');
    await click(v, '#confirmShip');
    await click(v, '#rail .go[data-act="ship-ticket"]');
    expect(types(v, before)).toEqual(['ship-ticket']);
    expect(v.query('#confirmShip')!.textContent).toBe('Shipping…');
    await push(v, populatedStateFor('done'));
    expect(v.query('#toast')!.textContent).toBe('Shipped ✓');
    expect(v.query('#rail .go')).toBeNull();
    // A fresh request after the ship is possible again from the header side.
    await push(v, shipConfirm());
    const mark = v.posted.length;
    await click(v, '#confirmShip');
    await click(v, '#rail .go[data-act="ship-ticket"]');
    expect(types(v, mark)).toEqual(['ship-ticket']);
  });

  it('no longer announces merge or ship over the transitional seams the two React sides share now', async () => {
    const v = await open(mergeNeeds());
    const heard: string[] = [];
    for (const name of ['karst:prBegin', 'karst:prPending', 'karst:shipBegin', 'karst:shipState']) {
      v.window.addEventListener(name, (e) => heard.push(`${name}:${JSON.stringify((e as CustomEvent).detail)}`));
    }
    await click(v, '#rail .go[data-act="merge-pr"]');
    await push(v, shipConfirm());
    await click(v, '#confirmShip');
    expect(heard).toEqual([]);
  });

  it('Send CI failure is one operation with the Inside stage menu’s item: the Inside block is React now, so no seam carries it', async () => {
    const s = populatedStateFor('ship');
    const failing = { ...s, prs: [{ ...s.prs[0]!, checks: { state: 'failing', label: 'f', title: '', detailsLabel: '1', failing: [{ name: 'lint', url: '' }] } }], ciFailure: { available: true, repos: [REPO] }, sendBack: { available: true, stage: 'ship' } } as DashboardState;
    const v = await open(failing);
    const heard: unknown[] = [];
    v.window.addEventListener('karst:prBegin', (e) => heard.push((e as CustomEvent).detail));
    const before = v.posted.length;
    await click(v, '#prs .mg-ci-failing .mgbtn');
    await click(v, '[data-stage-menu="ship"]');
    await click(v, '.stageMenu [data-act="send-ci-failure"]');
    expect(types(v, before)).toEqual(['send-ci-failure']);
    expect(heard).toEqual([]);
  });
});
