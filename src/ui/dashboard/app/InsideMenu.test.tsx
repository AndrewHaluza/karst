// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { act, fireEvent } from '@testing-library/react';
import type { HostMessage } from '../messages.js';
import { installRuntimeDoubles, settled } from './fixtures/prsPanelKit.js';
import { all, cleanupInside, insideState, must, mountInside, q, text } from './fixtures/insideKit.js';

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

  it('closed: one icon button with aria-haspopup/expanded; has-actions follows send back, PR feedback, CI and rebase (not retry)', () => {
    mountInside(menuState());
    expect(trigger().getAttribute('aria-label')).toBe('Stage actions');
    expect(trigger().getAttribute('aria-haspopup')).toBe('menu');
    expect(trigger().getAttribute('aria-expanded')).toBe('false');
    expect(trigger().dataset.stageMenu).toBe('ship');
    expect(q('.stageMenu')).toBeNull();
    expect(must('.inside-head').classList.contains('has-actions')).toBe(true);
    cleanupInside();
    mountInside(insideState({ stageCurrent: 'uat', rerunGate: { available: true, stage: 'uat' } }));
    expect(q('.stageMenuWrap')).not.toBeNull();
    expect(must('.inside-head').classList.contains('has-actions')).toBe(false);
  });

  it('open: the ship items in order, each with its title and a wrapped label', () => {
    const h = mountInside(menuState());
    fireEvent.click(trigger());
    expect(trigger().getAttribute('aria-expanded')).toBe('true');
    expect(must('.stageMenu').getAttribute('role')).toBe('menu');
    expect(items().map((b) => b.dataset.act)).toEqual(['address-pr-feedback', 'send-ci-failure', 'rebase-on-base', 'send-back-to-implement']);
    expect(items().map((b) => text(b.querySelector('span')))).toEqual(['Address PR feedback', 'Send CI failure to agent', 'Rebase on base', 'Send back to Implement']);
    expect(items().every((b) => b.getAttribute('role') === 'menuitem' && b.querySelector('svg.k-icon') !== null)).toBe(true);
    expect(items()[3]!.title).toBe('Move this ticket back to Implement — UAT and Review will run again');
    expect(h.menuOpen).toEqual([true]);
  });

  it('the retry item leads and names the gate stage', () => {
    mountInside(insideState({ stageCurrent: 'review', sendBack: { available: true, stage: 'review' }, rerunGate: { available: true, stage: 'review' } }));
    fireEvent.click(trigger());
    expect(items().map((b) => b.dataset.act)).toEqual(['rerun-gate', 'send-back-to-implement']);
    expect(text(items()[0]!.querySelector('span'))).toBe('Retry Review');
    expect(items()[0]!.dataset.stage).toBe('review');
    cleanupInside();
    mountInside(insideState({ stageCurrent: 'uat', rerunGate: { available: true, stage: 'uat' } }));
    fireEvent.click(trigger());
    expect(text(items()[0]!.querySelector('span'))).toBe('Retry UAT');
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
    fireEvent.click(trigger());
    fireEvent.click(must(`.stageMenu [data-act="${act}"]`));
    expect(h.send[sender]).toHaveBeenCalledTimes(1);
    expect(h.send[sender].mock.calls[0]).toEqual(args);
    expect(q('.stageMenu')).toBeNull();
    fireEvent.click(trigger());
    fireEvent.click(must(`.stageMenu [data-act="${act}"]`));
    expect(h.send[sender]).toHaveBeenCalledTimes(1);
  });

  it('retry posts the stage and shares one request with send back (one confirmation dialog at a time)', () => {
    const h = mountInside(insideState({ stageCurrent: 'uat', sendBack: { available: true, stage: 'uat' }, rerunGate: { available: true, stage: 'uat' } }));
    fireEvent.click(trigger());
    fireEvent.click(must('.stageMenu [data-act="rerun-gate"]'));
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
    expect(text(items()[0]!.querySelector('span'))).toBe('Reset UAT');
    fireEvent.click(must('.stageMenu [data-act="reset-stage"]'));
    expect(h.send.resetStage).toHaveBeenCalledTimes(1);
    h.emit({ type: 'state', state: state({ stageCurrent: 'uat', presentedStage: 'uat', resetStage: { available: false, reason: 'stage' } }) } as HostMessage);
    expect(settled).toEqual([['req-1', true, 'Stage reset; re-running.']]);
  });

  it('shares Send CI failure with the pull request panel: started there, it is already in flight here', () => {
    const h = mountInside(menuState());
    act(() => h.ops().beginAction('ci', 'panel-1'));
    fireEvent.click(trigger());
    fireEvent.click(must('.stageMenu [data-act="send-ci-failure"]'));
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

describe('Inside — Deliver to PR', () => {
  const state = (dv: Record<string, unknown>, stage = 'ship') => insideState({ stageCurrent: stage, deliver: dv });

  it('states the undelivered count, with the sandbox part only when there is one', () => {
    mountInside(state({ available: true, notOnPr: 2, inSandbox: 1 }));
    const row = must('.inside-deliver');
    expect(row.getAttribute('role')).toBe('status');
    expect(text(row.querySelector('span'))).toBe('2 commits not on the PR (1 still in the sandbox)');
    cleanupInside();
    mountInside(state({ available: true, notOnPr: 1, inSandbox: 0 }));
    expect(text(must('.inside-deliver span'))).toBe('1 commit not on the PR');
  });

  it('is ship-only and host-gated', () => {
    mountInside(state({ available: true, notOnPr: 2, inSandbox: 0 }, 'impl'));
    expect(q('.inside-deliver')).toBeNull();
    cleanupInside();
    mountInside(state({ available: false, notOnPr: 2, inSandbox: 0 }));
    expect(q('.inside-deliver')).toBeNull();
  });

  it('posts once with no request id, goes busy, and settles on the next settling push', () => {
    const h = mountInside(state({ available: true, notOnPr: 2, inSandbox: 0 }));
    const btn = must<HTMLButtonElement>('[data-act="deliver-to-pr"]');
    expect(btn.hasAttribute('aria-busy')).toBe(false);
    fireEvent.click(btn);
    fireEvent.click(btn);
    expect(h.send.deliverToPr).toHaveBeenCalledTimes(1);
    expect(h.send.deliverToPr.mock.calls[0]).toEqual([]);
    expect(btn.getAttribute('aria-busy')).toBe('true');
    expect(btn.disabled).toBe(true);
    h.emit({ type: 'state', state: state({ available: true, notOnPr: 2, inSandbox: 0 }), live: true, settlesActions: false } as HostMessage);
    expect(btn.disabled).toBe(true);
    h.emit({ type: 'state', state: state({ available: true, notOnPr: 0, inSandbox: 0 }) } as HostMessage);
    expect(btn.disabled).toBe(false);
    expect(btn.hasAttribute('aria-busy')).toBe(false);
  });

  describe('auto-deliver of a resolved merge (T1018)', () => {
    const A = 'a'.repeat(40);
    const B = 'b'.repeat(40);
    const failure = { gate: 'unit', repo: 'r', exitCode: 2, headSha: A, summary: 'boom\nline two' };
    const auto = (over: Record<string, unknown> = {}) => ({ running: null, failures: [], takenOver: null, roundActive: false, headSha: A, ...over });
    const dv = (a: Record<string, unknown>) => state({ available: true, notOnPr: 2, inSandbox: 0, auto: a });

    it('(a) shows no progress or failure region without an auto-deliver', () => {
      mountInside(state({ available: true, notOnPr: 2, inSandbox: 0 }));
      expect(q('[data-region="deliver-progress"]')).toBeNull();
      expect(q('[data-region="deliver-gate-failures"]')).toBeNull();
    });

    it('(b) words gate n/m and hints the button, which stays enabled', () => {
      mountInside(dv(auto({ running: { n: 2, m: 5, gate: 'docs-graph' }, roundActive: true })));
      expect(text(must('[data-region="deliver-progress"]'))).toBe('Delivering resolved merge: gate 2/5 (docs-graph), push after the gates');
      const btn = must<HTMLButtonElement>('[data-act="deliver-to-pr"]');
      expect(btn.disabled).toBe(false);
      expect(btn.title).toBe('Auto-deliver runs gate 2/5 (docs-graph). Deliver now skips the remaining gates.');
      expect(must('.inside-deliver').getAttribute('role')).toBe('status');
    });

    it('(c) lists a failure on the current head and names it in the hint', () => {
      mountInside(dv(auto({ running: { n: 3, m: 5, gate: 'visual' }, failures: [failure], roundActive: true })));
      const region = must('[data-region="deliver-gate-failures"]');
      expect(text(region)).toContain(`On the current head ${'a'.repeat(9)}`);
      expect(text(region)).toContain(`Gate unit failed (exit 2) on ${'a'.repeat(9)}`);
      expect(must<HTMLButtonElement>('[data-act="deliver-to-pr"]').title).toBe(`Gate unit failed (exit 2) on ${'a'.repeat(9)}. Deliver now pushes it anyway.`);
    });

    it('(d) words the takeover with its failed and skipped gates and keeps the failure', () => {
      mountInside(dv(auto({ takenOver: { failed: ['unit'], skipped: ['visual', 'docs'] }, failures: [failure] })));
      expect(text(must('[data-region="deliver-progress"]'))).toBe('Delivery taken over by a manual Deliver; failed: unit; skipped: visual, docs');
      expect(q('[data-region="deliver-gate-failures"]')).not.toBeNull();
    });

    it('(e) groups a failure of an older head after a new push and gives no hint', () => {
      mountInside(dv(auto({ headSha: B, failures: [failure] })));
      expect(text(must('[data-region="deliver-gate-failures"]'))).toContain(`On an older head ${'a'.repeat(9)}`);
      expect(must<HTMLButtonElement>('[data-act="deliver-to-pr"]').title).toContain('push the branch');
    });

    it('dismisses one gate through the host', () => {
      const h = mountInside(dv(auto({ failures: [failure] })));
      fireEvent.click(must('[data-act="dismiss-deliver-failure"]'));
      expect(h.send.dismissDeliverFailures).toHaveBeenCalledWith('unit');
    });

    it('shows the record without the button when nothing is left to push', () => {
      mountInside(state({ available: false, notOnPr: 0, inSandbox: 0, auto: auto({ failures: [failure] }) }));
      expect(q('[data-act="deliver-to-pr"]')).toBeNull();
      expect(q('[data-region="deliver-gate-failures"]')).not.toBeNull();
    });
  });

  it('keeps one className through the whole request (the runtime’s is-pending lives on it)', () => {
    mountInside(state({ available: true, notOnPr: 2, inSandbox: 0 }));
    const btn = must<HTMLButtonElement>('[data-act="deliver-to-pr"]');
    const idle = btn.className;
    fireEvent.click(btn);
    expect([...btn.classList].filter((c) => c !== 'is-pending').join(' ')).toBe(idle);
  });
});
