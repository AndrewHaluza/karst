// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { act, fireEvent } from '@testing-library/react';
import type { HostMessage } from '../messages.js';
import { installRuntimeDoubles, settled } from './fixtures/prsPanelKit.js';
import { deliverProcess, type DeliverRowInput } from '../../../model/inside/shipDeliver.js';
import { all, cleanupInside, insideState, must, mountInside, q, text, view } from './fixtures/insideKit.js';

installRuntimeDoubles();
afterEach(cleanupInside);

describe('Inside — the stage menu', () => {
  const menuState = (over: Record<string, unknown> = {}) =>
    insideState({
      stageCurrent: 'ship',
      sendBack: { available: true, stage: 'ship' },
      prFeedbackFix: { available: true, round: 1, items: 2 },
      ciFailure: { available: true, repos: ['r'] },
      rebase: { available: true, stage: 'ship' },
      ...over,
    });
  const trigger = () => must<HTMLButtonElement>('[data-stage-menu]');
  const items = () => all('.stageMenu .menuButton');

  it('renders no menu where the host offers no recovery, and no has-actions class', () => {
    mountInside(insideState({ stageCurrent: 'uat' }));
    expect(q('.stageMenuWrap')).toBeNull();
    expect(must('.inside-head').classList.contains('has-actions')).toBe(false);
  });

  it('offers it only on the stage the host names (send back / retry / rebase) and on Ship (PR feedback, CI)', () => {
    mountInside(menuState({ sendBack: { available: true, stage: 'uat' }, prFeedbackFix: { available: false }, ciFailure: { available: false, repos: [] }, rebase: { available: false } }));
    expect(q('.stageMenuWrap')).toBeNull();
    cleanupInside();
    mountInside(menuState({ sendBack: { available: false }, prFeedbackFix: { available: false }, ciFailure: { available: true, repos: ['r'] }, rebase: { available: false }, stageCurrent: 'impl', presentedStage: 'impl' }));
    expect(q('.stageMenuWrap')).toBeNull();
  });

  it('closed: one icon button with aria-haspopup/expanded; has-actions follows every menu action, retry included', () => {
    mountInside(menuState());
    expect(trigger().getAttribute('aria-label')).toBe('Actions — more actions for this stage');
    expect(trigger().title).toBe(trigger().getAttribute('aria-label'));
    expect(text(trigger())).toBe('Actions');
    expect(trigger().getAttribute('aria-haspopup')).toBe('menu');
    expect(trigger().getAttribute('aria-expanded')).toBe('false');
    expect(trigger().dataset.stageMenu).toBe('ship');
    expect(q('.stageMenu')).toBeNull();
    expect(must('.inside-head').classList.contains('has-actions')).toBe(true);
    cleanupInside();
    mountInside(insideState({ stageCurrent: 'uat', rerunGate: { available: true, stage: 'uat' } }));
    expect(q('.stageMenuWrap')).not.toBeNull();
    expect(must('.inside-head').classList.contains('has-actions')).toBe(true);
  });

  it('open: the ship items in order, each with its title and a wrapped label', () => {
    const h = mountInside(menuState());
    fireEvent.click(trigger());
    expect(trigger().getAttribute('aria-expanded')).toBe('true');
    expect(must('.stageMenu').getAttribute('role')).toBe('menu');
    // The host-picked main action (CI failure) is the visible button, so the menu does not repeat it.
    expect(items().map((b) => b.dataset.act)).toEqual(['address-pr-feedback', 'send-back-to-implement', 'rebase-on-base']);
    expect(items().map((b) => text(b.querySelector('.menuLabel')))).toEqual(['Address feedback', 'Send back to Implement', 'Rebase']);
    expect(all('.stageMenu .menuGroupTitle').map((g) => text(g))).toEqual(['Send to the agent', 'Branch']);
    expect(items().every((b) => text(b.querySelector('.menuDesc')) !== '')).toBe(true);
    expect(items().every((b) => b.getAttribute('role') === 'menuitem' && b.querySelector('svg.k-icon') !== null)).toBe(true);
    expect(items()[1]!.title).toBe('Send back to Implement — move this ticket back to Implement — UAT and Review will run again');
    expect(h.menuOpen).toEqual([true]);
  });

  it('the retry item leads and names the gate stage', () => {
    mountInside(insideState({ stageCurrent: 'review', sendBack: { available: true, stage: 'review' }, rerunGate: { available: true, stage: 'review' } }));
    fireEvent.click(trigger());
    expect(items().map((b) => b.dataset.act)).toEqual(['send-back-to-implement']);
    const main = must<HTMLButtonElement>('.stageMain');
    expect(main.dataset.act).toBe('rerun-gate');
    expect(main.dataset.stage).toBe('review');
    expect(text(main)).toBe('Retry');
    expect(main.className).toContain('k-btn--secondary');
    expect(main.title).toBe(main.getAttribute('aria-label'));
    expect(main.title.startsWith('Retry — ')).toBe(true);
    cleanupInside();
    mountInside(insideState({ stageCurrent: 'uat', rerunGate: { available: true, stage: 'uat' } }));
    expect(q('[data-stage-menu]')).toBeNull();
    expect(must('.stageMain').dataset.stage).toBe('uat');
  });

  it('the trigger toggles, Escape closes, a click elsewhere closes, a click inside the menu does not', () => {
    const h = mountInside(menuState());
    fireEvent.click(trigger());
    fireEvent.click(trigger());
    expect(q('.stageMenu')).toBeNull();
    fireEvent.click(trigger());
    fireEvent.click(must('.stageMenu'));
    expect(q('.stageMenu')).not.toBeNull();
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(q('.stageMenu')).toBeNull();
    fireEvent.click(trigger());
    fireEvent.click(document.body);
    expect(q('.stageMenu')).toBeNull();
    expect(h.menuOpen).toEqual([true, false, true, false, true, false]);
  });

  it('leaves an Escape another surface already handled alone', () => {
    mountInside(menuState());
    fireEvent.click(trigger());
    const esc = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    esc.preventDefault();
    act(() => {
      document.body.dispatchEvent(esc);
    });
    expect(q('.stageMenu')).not.toBeNull();
  });

  it.each([
    ['send-back-to-implement', 'sendBackToImplement', []],
    ['address-pr-feedback', 'addressPrFeedback', []],
    ['send-ci-failure', 'sendCiFailure', []],
    ['rebase-on-base', 'rebaseOnBase', []],
  ] as const)('%s posts %s once, closes the menu and cannot be started twice', (act, sender, args) => {
    const h = mountInside(menuState());
    // Send CI failure is the host-picked main action: a visible button, not a menu item.
    const click = (): void => {
      if (act === 'send-ci-failure') return void fireEvent.click(must(`.stageMain[data-act="${act}"]`));
      fireEvent.click(trigger());
      fireEvent.click(must(`.stageMenu [data-act="${act}"]`));
    };
    click();
    expect(h.send[sender]).toHaveBeenCalledTimes(1);
    expect(h.send[sender].mock.calls[0]).toEqual(args);
    expect(q('.stageMenu')).toBeNull();
    click();
    expect(h.send[sender]).toHaveBeenCalledTimes(1);
  });

  it('retry posts the stage and shares one request with send back (one confirmation dialog at a time)', () => {
    const h = mountInside(insideState({ stageCurrent: 'uat', sendBack: { available: true, stage: 'uat' }, rerunGate: { available: true, stage: 'uat' } }));
    fireEvent.click(must('.stageMain[data-act="rerun-gate"]'));
    expect(h.send.rerunGate.mock.calls).toEqual([['uat']]);
    fireEvent.click(trigger());
    fireEvent.click(must('.stageMenu [data-act="send-back-to-implement"]'));
    expect(h.send.sendBackToImplement).not.toHaveBeenCalled();
  });

  it('settles on the next settling snapshot, and a passive push keeps it in flight', () => {
    const h = mountInside(menuState());
    fireEvent.click(trigger());
    fireEvent.click(must('.stageMenu [data-act="send-back-to-implement"]'));
    h.emit({ type: 'state', state: menuState(), live: true, settlesActions: false } as HostMessage);
    expect(settled).toEqual([]);
    h.emit({ type: 'state', state: menuState({ stageCurrent: 'impl', presentedStage: 'impl' }) } as HostMessage);
    expect(settled).toEqual([['req-1', true, 'Sent back to Implement.']]);
  });

  it('reset stage (T831): offered on the failed gate, posts the message and settles on the receipt', () => {
    const state = (over: Record<string, unknown> = {}) =>
      insideState({ stageCurrent: 'fix', presentedStage: 'uat', resetStage: { available: true, stage: 'uat' }, ...over });
    const h = mountInside(state());
    fireEvent.click(trigger());
    expect(items().map((b) => b.dataset.act)).toEqual(['reset-stage']);
    expect(text(items()[0]!.querySelector('.menuLabel'))).toBe('Reset UAT');
    fireEvent.click(must('.stageMenu [data-act="reset-stage"]'));
    expect(h.send.resetStage).toHaveBeenCalledTimes(1);
    h.emit({ type: 'state', state: state({ stageCurrent: 'uat', presentedStage: 'uat', resetStage: { available: false, reason: 'stage' } }) } as HostMessage);
    expect(settled).toEqual([['req-1', true, 'Stage reset; re-running.']]);
  });

  it('shares Send CI failure with the pull request panel: started there, it is already in flight here', () => {
    const h = mountInside(menuState());
    act(() => h.ops().beginAction('ci', 'panel-1'));
    fireEvent.click(must('.stageMain[data-act="send-ci-failure"]'));
    expect(h.send.sendCiFailure).not.toHaveBeenCalled();
  });

  it('a pick (even of the stage already shown) closes the open menu', () => {
    const state = menuState({ rail: { main: [{ cell: { stageKey: 'ship', status: 'running' }, status: 'running', current: true, needsUser: false, needs: null, retry: null }] } });
    const h = mountInside(state, { withRail: true });
    fireEvent.click(trigger());
    expect(q('.stageMenu')).not.toBeNull();
    fireEvent.click(must('#rail .pick[data-stage="ship"]'));
    expect(q('.stageMenu')).toBeNull();
    expect(h.menuOpen).toEqual([true, false]);
  });

  it('survives a snapshot while open', () => {
    const h = mountInside(menuState());
    fireEvent.click(trigger());
    h.emit({ type: 'state', state: menuState() } as HostMessage);
    expect(q('.stageMenu')).not.toBeNull();
  });
});

describe('Inside — Deliver process row (T1072)', () => {
  const A = 'a'.repeat(40);
  const B = 'b'.repeat(40);
  const failure = { gate: 'unit', repo: 'r', exitCode: 2, headSha: A, summary: 'boom\nline two' };
  const auto = (over: Record<string, unknown> = {}) => ({ running: null, failures: [], takenOver: null, roundActive: false, headSha: A, ...over });
  /** The ship snapshot with the Deliver row the host builds from these facts. */
  const state = (input: Partial<DeliverRowInput> | null, stage = 'ship') => {
    const full = input ? { notOnPr: 2, inSandbox: 0, canDeliver: true, auto: null, ...input } : null;
    const row = full ? deliverProcess(full) : undefined;
    // The slice reads the kept failures from state.deliver (the same facts the host built the row from).
    const deliver = full ? { available: full.canDeliver, notOnPr: full.notOnPr, inSandbox: full.inSandbox, ...(full.auto ? { auto: full.auto } : {}) } : undefined;
    return insideState({ stageCurrent: stage, views: { [stage]: view(stage, { processes: row ? [row] : [] }) }, ...(deliver ? { deliver } : {}) });
  };
  const deliverRow = () => must('[data-proc-id="ship:deliver"]');

  it('renders the row with its name, detail, live region, Push and the console button', () => {
    mountInside(state({ notOnPr: 2, inSandbox: 1 }));
    const row = deliverRow();
    expect(text(must('.op-name-text', row))).toBe('Deliver');
    expect(text(must('[role="status"]', row))).toBe('2 commits not on the PR (1 still in the sandbox)');
    const push = must<HTMLButtonElement>('[data-act="deliver-to-pr"]');
    expect(text(push)).toBe('Push');
    expect(push.title).toBe(push.getAttribute('aria-label'));
    expect(push.title.startsWith('Push — ')).toBe(true);
    expect(push.className).toContain('k-btn--secondary');
  });

  it('shows no row when the host builds none', () => {
    mountInside(state(null));
    expect(q('[data-proc-id="ship:deliver"]')).toBeNull();
    expect(q('[data-act="deliver-to-pr"]')).toBeNull();
  });

  it('posts once with no request id, goes busy, and settles on the next settling push', () => {
    const h = mountInside(state({}));
    const btn = must<HTMLButtonElement>('[data-act="deliver-to-pr"]');
    expect(btn.hasAttribute('aria-busy')).toBe(false);
    fireEvent.click(btn);
    fireEvent.click(btn);
    expect(h.send.deliverToPr).toHaveBeenCalledTimes(1);
    expect(h.send.deliverToPr.mock.calls[0]).toEqual([]);
    expect(btn.getAttribute('aria-busy')).toBe('true');
    expect(btn.disabled).toBe(true);
    h.emit({ type: 'state', state: state({}), live: true, settlesActions: false } as HostMessage);
    expect(btn.disabled).toBe(true);
    h.emit({ type: 'state', state: state(null) } as HostMessage);
    expect(q('[data-act="deliver-to-pr"]')).toBeNull();
  });

  it('(a) shows no progress or failure region without an auto-deliver', () => {
    mountInside(state({}));
    expect(q('[data-region="deliver-progress"]')).toBeNull();
    expect(q('[data-region="deliver-gate-failures"]')).toBeNull();
  });

  it('(b) words gate n of m in the detail and the running row, and hints the enabled button', () => {
    mountInside(state({ auto: auto({ running: { n: 2, m: 5, gate: 'docs-graph' }, roundActive: true }) }));
    expect(text(must('[data-region="deliver-progress"]'))).toContain('Gate 2 of 5');
    expect(text(must('[role="status"]', deliverRow()))).toContain('gate 2 of 5');
    const btn = must<HTMLButtonElement>('[data-act="deliver-to-pr"]');
    expect(btn.disabled).toBe(false);
    expect(btn.title).toContain('auto-deliver runs gate 2/5 (docs-graph)');
  });

  it('(c) lists a failure on the current head as a fail row with its error behind Show', () => {
    mountInside(state({ auto: auto({ running: { n: 3, m: 5, gate: 'visual' }, failures: [failure], roundActive: true }) }));
    const region = must('[data-region="deliver-gate-failures"]');
    expect(text(region)).toContain('Gate unit failed');
    expect(text(region)).toContain(`on the current head ${'a'.repeat(9)}`);
    expect(must('details.ev-output summary', region).textContent).toBe('Show');
    expect(must('details.ev-output pre', region).textContent).toBe('boom\nline two');
  });

  it('(d) words the takeover and keeps the failure', () => {
    mountInside(state({ auto: auto({ takenOver: { failed: ['unit'], skipped: ['visual', 'docs'] }, failures: [failure] }) }));
    expect(text(must('[role="status"]', deliverRow()))).toContain('failed: unit');
    expect(q('[data-region="deliver-gate-failures"]')).not.toBeNull();
  });

  it('(e) groups a failure of an older head after a new push', () => {
    mountInside(state({ auto: auto({ headSha: B, failures: [failure] }) }));
    expect(text(must('[data-region="deliver-gate-failures"]'))).toContain(`on an older head ${'a'.repeat(9)}`);
    expect(must<HTMLButtonElement>('[data-act="deliver-to-pr"]').title).toContain('push the branch');
  });

  it('dismisses one gate through the host, as an x icon button with the full text', () => {
    const h = mountInside(state({ auto: auto({ failures: [failure] }) }));
    const btn = must<HTMLButtonElement>('[data-region="deliver-gate-failures"] [data-act="dismiss-deliver-failures"]');
    expect(btn.title).toBe(btn.getAttribute('aria-label'));
    fireEvent.click(btn);
    expect(h.send.dismissDeliverFailures).toHaveBeenCalledWith('unit');
  });

  it('the stage menu drops every kept failure at once, through the Delivery group', () => {
    const h = mountInside(state({ auto: auto({ failures: [failure] }) }));
    fireEvent.click(must('[data-stage-menu]'));
    expect(all('.stageMenu .menuGroupTitle').map((g) => text(g))).toEqual(['Delivery']);
    fireEvent.click(must('.stageMenu [data-act="dismiss-deliver-failures"]'));
    expect(h.send.dismissDeliverFailures).toHaveBeenCalledWith();
    expect(q('.stageMenu')).toBeNull();
  });

  it('shows the record without the button when nothing is left to push', () => {
    mountInside(state({ canDeliver: false, notOnPr: 0, auto: auto({ failures: [failure] }) }));
    expect(q('[data-act="deliver-to-pr"]')).toBeNull();
    expect(q('[data-region="deliver-gate-failures"]')).not.toBeNull();
  });

  it('keeps one className through the whole request (the runtime’s is-pending lives on it)', () => {
    mountInside(state({}));
    const btn = must<HTMLButtonElement>('[data-act="deliver-to-pr"]');
    const idle = btn.className;
    fireEvent.click(btn);
    expect([...btn.classList].filter((c) => c !== 'is-pending').join(' ')).toBe(idle);
  });
});
