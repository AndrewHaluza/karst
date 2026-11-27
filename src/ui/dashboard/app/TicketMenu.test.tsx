// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fireEvent } from '@testing-library/react';
import type { HostMessage } from '../messages.js';
import { $, has, headerState, installHeaderDoubles, mountHeader } from './fixtures/headerKit.js';

installHeaderDoubles();

const HERE = dirname(fileURLToPath(import.meta.url));

const gates: HostMessage = { type: 'gate-options', options: { uat: [{ name: 'lint', disabled: false }, { name: 'e2e', disabled: true }], review: [{ name: 'sec', disabled: false }] } };

describe('TicketMenu — items', () => {
  it('swaps Pause and Resume with the paused flag, and shows Create follow-up only at done', () => {
    const h = mountHeader(headerState());
    expect(has('#pauseItem', 'hidden')).toBe(false);
    expect(has('#resumeItem', 'hidden')).toBe(true);
    expect(has('#followUpItem', 'hidden')).toBe(true);
    h.emit({ type: 'state', state: headerState({ paused: true, stageCurrent: 'done' }) });
    expect(has('#pauseItem', 'hidden')).toBe(true);
    expect(has('#resumeItem', 'hidden')).toBe(false);
    expect(has('#followUpItem', 'hidden')).toBe(false);
  });

  it('posts each item once, runtime-pending', () => {
    const h = mountHeader(headerState({ stageCurrent: 'done' }));
    for (const [sel, name] of [['[data-act="edit-ticket"]', 'editTicket'], ['#pauseItem', 'pauseExecution'], ['#followUpItem', 'createFollowUpTicket']] as const) {
      fireEvent.click($(sel));
      fireEvent.click($(sel));
      expect(h.send[name], name).toHaveBeenCalledTimes(1);
    }
  });
});

describe('TicketMenu — Archive and labels', () => {
  it('posts archive-ticket once, runtime-pending, from a danger item after a divider', () => {
    const h = mountHeader(headerState());
    const item = $('#archiveTicket');
    expect(item.classList.contains('danger')).toBe(true);
    expect(item.getAttribute('title')).toBe('Archive ticket, hiding it from the active list');
    expect(item.previousElementSibling?.classList.contains('menuDivider')).toBe(true);
    fireEvent.click(item);
    fireEvent.click(item);
    expect(h.send.archiveTicket).toHaveBeenCalledTimes(1);
  });

  it('names no action with a trailing "…"', () => {
    mountHeader(headerState());
    const labels = [...document.querySelectorAll('#menuPopover .menuButton')].map((b) => (b.textContent ?? '').trim());
    expect(labels).toContain('Close');
    expect(labels).toContain('Detach from parent');
    for (const l of labels) expect(l).not.toMatch(/…$/);
  });
});

describe('TicketMenu — link switch', () => {
  it('follows the host `bind` push and posts the payload-free flip, leaving the value to the host', () => {
    const h = mountHeader(headerState());
    const box = $<HTMLInputElement>('#linkViews');
    expect(box.checked).toBe(false);
    h.emit({ type: 'bind', enabled: true });
    expect(box.checked).toBe(true);
    expect($('#linkViewsLabel').getAttribute('aria-checked')).toBe('true');
    fireEvent.click(box);
    expect(h.send.toggleBind).toHaveBeenCalledTimes(1);
    expect(h.send.toggleBind).toHaveBeenCalledWith();
    expect(box.checked).toBe(true);
    h.emit({ type: 'bind', enabled: false });
    expect(box.checked).toBe(false);
  });
});

describe('TicketMenu — gates', () => {
  const gateTabs = (): HTMLElement[] => Array.from(document.querySelectorAll<HTMLElement>('[role="tab"]'));
  const selectedTab = (): string | null => gateTabs().find((t) => t.getAttribute('aria-selected') === 'true')?.id ?? null;
  const panel = (): HTMLElement => $('[role="tabpanel"]');

  it('draws nothing until the first answer, then the blurb or the stage tabs', () => {
    const h = mountHeader(headerState());
    expect($('#menuGates').childElementCount).toBe(0);
    h.emit({ type: 'gate-options', options: { uat: [], review: [] } });
    expect($('#menuGates').textContent).toBe('No gates resolved for this ticket yet.');
    h.emit(gates);
    expect(document.querySelectorAll('.gateHead')).toHaveLength(0);
    expect($('[role="tablist"]').getAttribute('aria-label')).toBe('Gate stage');
    expect(gateTabs().map((t) => t.textContent)).toEqual(['UAT 2 · 1 off', 'Review 1']);
    expect(selectedTab()).toBe('gateTab-uat');
    expect(panel().getAttribute('aria-labelledby')).toBe('gateTab-uat');
    expect($('#gateTab-uat').getAttribute('aria-controls')).toBe('gateTabPanel');
    expect([...document.querySelectorAll('.gateRow .gateName')].map((e) => e.textContent)).toEqual(['lint', 'e2e']);
  });

  it('shows only the selected stage rows once the other tab is clicked', () => {
    const h = mountHeader(headerState());
    h.emit(gates);
    fireEvent.click($('#gateTab-review'));
    expect(selectedTab()).toBe('gateTab-review');
    expect(panel().getAttribute('aria-labelledby')).toBe('gateTab-review');
    expect([...document.querySelectorAll('.gateRow .gateName')].map((e) => e.textContent)).toEqual(['sec']);
    fireEvent.click($('#gateTab-uat'));
    expect(selectedTab()).toBe('gateTab-uat');
    expect([...document.querySelectorAll('.gateRow .gateName')].map((e) => e.textContent)).toEqual(['lint', 'e2e']);
  });

  it('opens on Review when the ticket is in review and on UAT for every other stage', () => {
    for (const stage of ['review'] as const) {
      const h = mountHeader(headerState({ stageCurrent: stage }));
      h.emit(gates);
      expect(selectedTab(), stage).toBe('gateTab-review');
      expect([...document.querySelectorAll('.gateRow .gateName')].map((e) => e.textContent)).toEqual(['sec']);
    }
    for (const stage of ['impl', 'uat', 'ship', 'done'] as const) {
      const h = mountHeader(headerState({ stageCurrent: stage }));
      h.emit(gates);
      expect(selectedTab(), stage).toBe('gateTab-uat');
      expect([...document.querySelectorAll('.gateRow .gateName')].map((e) => e.textContent)).toEqual(['lint', 'e2e']);
    }
  });

  it('falls back to UAT while no state has arrived yet', () => {
    const h = mountHeader(null);
    h.emit({ type: 'state', state: headerState() });
    h.emit(gates);
    expect(selectedTab()).toBe('gateTab-uat');
    expect(gateTabs()).toHaveLength(2);
  });

  it('keeps the picked tab while the menu is open, then resets to the current stage on the next open', () => {
    const h = mountHeader(headerState({ stageCurrent: 'impl' }));
    h.emit(gates);
    fireEvent.click($('#moreBtn'));
    expect(selectedTab()).toBe('gateTab-uat');
    fireEvent.click($('#gateTab-review'));
    expect(selectedTab()).toBe('gateTab-review');
    // A 1 Hz snapshot that changes the stage must not move the tab under the pointer.
    h.emit({ type: 'state', state: headerState({ stageCurrent: 'uat' }) });
    expect(selectedTab()).toBe('gateTab-review');
    fireEvent.click($('#moreBtn'));
    h.emit({ type: 'state', state: headerState({ stageCurrent: 'review' }) });
    fireEvent.click($('#moreBtn'));
    expect(selectedTab()).toBe('gateTab-review');
    // Close on UAT, reopen on impl: the reset follows the stage, not the last pick.
    fireEvent.click($('#moreBtn'));
    h.emit({ type: 'state', state: headerState({ stageCurrent: 'impl' }) });
    fireEvent.click($('#moreBtn'));
    expect(selectedTab()).toBe('gateTab-uat');
  });

  it('counts both a ticket-off and a Settings-off gate once each, and shows the count on the hidden tab', () => {
    const h = mountHeader(headerState());
    h.emit({
      type: 'gate-options',
      options: {
        uat: [{ name: 'a', disabled: false }, { name: 'b', disabled: true, configDisabled: true }],
        review: [{ name: 'x', disabled: false, configDisabled: true }, { name: 'y', disabled: true }],
      },
    });
    expect(gateTabs().map((t) => t.textContent)).toEqual(['UAT 2 · 1 off', 'Review 2 · 2 off']);
    expect(gateTabs().map((t) => t.querySelector('.gateTabOff')?.textContent)).toEqual([' · 1 off', ' · 2 off']);
    // The hidden tab's off gates stay visible while the other stage is listed.
    expect($('#gateTab-uat .gateTabOff').textContent).toBe(' · 1 off');
  });

  it('omits the off marker when a stage has no gate off', () => {
    const h = mountHeader(headerState());
    h.emit({ type: 'gate-options', options: { uat: [{ name: 'a', disabled: false }], review: [{ name: 'r', disabled: false }] } });
    expect(gateTabs().map((t) => t.querySelector('.gateTabOff'))).toEqual([null, null]);
    expect(gateTabs().map((t) => t.textContent)).toEqual(['UAT 1', 'Review 1']);
  });

  it('draws no tab row for a single stage and keeps its head', () => {
    const uatOnly = mountHeader(headerState());
    uatOnly.emit({ type: 'gate-options', options: { uat: [{ name: 'lint', disabled: false }], review: [] } });
    expect(document.querySelector('[role="tablist"]')).toBeNull();
    expect($('.gateHead').textContent).toBe('UAT');
    expect(document.querySelectorAll('.gateRow')).toHaveLength(1);

    const reviewOnly = mountHeader(headerState());
    reviewOnly.emit({ type: 'gate-options', options: { uat: [], review: [{ name: 'sec', disabled: false }] } });
    expect(document.querySelector('[role="tablist"]')).toBeNull();
    expect($('.gateHead').textContent).toBe('Review');
    expect([...document.querySelectorAll('.gateRow .gateName')].map((e) => e.textContent)).toEqual(['sec']);
  });

  it('roves tabIndex and moves the selection and focus with the arrow, Home and End keys', () => {
    const h = mountHeader(headerState({ stageCurrent: 'impl' }));
    h.emit(gates);
    expect(gateTabs().map((t) => t.tabIndex)).toEqual([0, -1]);

    $('#gateTab-uat').focus();
    expect(fireEvent.keyDown($('#gateTab-uat'), { key: 'ArrowRight' })).toBe(false);
    expect(selectedTab()).toBe('gateTab-review');
    expect(gateTabs().map((t) => t.tabIndex)).toEqual([-1, 0]);
    expect(document.activeElement).toBe($('#gateTab-review'));
    expect(panel().getAttribute('aria-labelledby')).toBe('gateTab-review');
    expect([...document.querySelectorAll('.gateRow .gateName')].map((e) => e.textContent)).toEqual(['sec']);

    fireEvent.keyDown($('#gateTab-review'), { key: 'ArrowRight' });
    expect(selectedTab()).toBe('gateTab-uat');
    expect(document.activeElement).toBe($('#gateTab-uat'));

    fireEvent.keyDown($('#gateTab-uat'), { key: 'ArrowLeft' });
    expect(selectedTab()).toBe('gateTab-review');
    fireEvent.keyDown($('#gateTab-review'), { key: 'ArrowLeft' });
    expect(selectedTab()).toBe('gateTab-uat');

    fireEvent.keyDown($('#gateTab-uat'), { key: 'End' });
    expect(selectedTab()).toBe('gateTab-review');
    expect(document.activeElement).toBe($('#gateTab-review'));
    fireEvent.keyDown($('#gateTab-review'), { key: 'Home' });
    expect(selectedTab()).toBe('gateTab-uat');
    expect(document.activeElement).toBe($('#gateTab-uat'));
  });

  it('ignores any other key without preventing it, and leaves the tab alone', () => {
    const h = mountHeader(headerState());
    h.emit(gates);
    $('#gateTab-uat').focus();
    const ev = new KeyboardEvent('keydown', { key: 'KeyA', bubbles: true, cancelable: true });
    $('#gateTab-uat').dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(false);
    expect(selectedTab()).toBe('gateTab-uat');
    expect(document.activeElement).toBe($('#gateTab-uat'));
  });

  it('labels each switch for what a click will do', () => {
    const h = mountHeader(headerState());
    h.emit(gates);
    const lint = $('[data-name="lint"]');
    expect(lint.getAttribute('aria-label')).toBe('Disable lint for this ticket');
    expect(lint.getAttribute('title')).toBe('Disable lint for this ticket');
    expect(lint.getAttribute('aria-checked')).toBe('true');
    expect(lint.getAttribute('role')).toBe('switch');
    const e2e = $('[data-name="e2e"]');
    expect(e2e.getAttribute('aria-label')).toBe('Enable e2e for this ticket');
    expect(e2e.getAttribute('aria-checked')).toBe('false');
    expect(e2e.closest('.gateRow')!.classList.contains('off')).toBe(true);
  });

  it('does not carry a pending switch across tabs that share a gate name', () => {
    const h = mountHeader(headerState());
    // Manifest gates resolve per stage independently: the same name may exist in both (UI-R26 keeps pending per control).
    h.emit({ type: 'gate-options', options: { uat: [{ name: 'unit', disabled: false }], review: [{ name: 'unit', disabled: false }] } });
    const uatUnit = $('[data-name="unit"]');
    fireEvent.click(uatUnit);
    expect(uatUnit.classList.contains('is-pending')).toBe(true);
    fireEvent.click($('#gateTab-review'));
    const reviewUnit = $('[data-name="unit"]');
    expect(reviewUnit).not.toBe(uatUnit);
    expect(reviewUnit.classList.contains('is-pending')).toBe(false);
    // The Review switch is its own control and still posts for its own stage.
    fireEvent.click(reviewUnit);
    expect(h.send.setDisabledGates).toHaveBeenLastCalledWith('review', 'unit', true, 'req-2');
  });

  it('posts the flip once per click on either tab, runtime-pending, and survives a repeated answer', () => {
    const h = mountHeader(headerState());
    h.emit(gates);
    const lint = $('[data-name="lint"]');
    fireEvent.click(lint);
    fireEvent.click(lint);
    expect(h.send.setDisabledGates).toHaveBeenCalledTimes(1);
    expect(h.send.setDisabledGates).toHaveBeenCalledWith('uat', 'lint', true, 'req-1');
    h.emit(gates);
    expect($('[data-name="lint"]')).toBe(lint);
    fireEvent.click($('[data-name="e2e"]'));
    expect(h.send.setDisabledGates).toHaveBeenLastCalledWith('uat', 'e2e', false, 'req-2');
    fireEvent.click($('#gateTab-review'));
    const sec = $('[data-name="sec"]');
    fireEvent.click(sec);
    fireEvent.click(sec);
    expect(h.send.setDisabledGates).toHaveBeenCalledTimes(3);
    expect(h.send.setDisabledGates).toHaveBeenLastCalledWith('review', 'sec', true, 'req-3');
    expect(sec.classList.contains('is-pending')).toBe(true);
  });
});

describe('TicketMenu — layout setting', () => {
  const radios = () => Array.from(document.querySelectorAll<HTMLButtonElement>('[role="radiogroup"] [role="radio"]'));

  it('is a labelled radiogroup of two icon + label options that follows the host `layout` push', () => {
    const h = mountHeader(headerState());
    const group = $('[role="radiogroup"]');
    expect(document.getElementById(group.getAttribute('aria-labelledby')!)?.textContent).toBe('Layout');
    expect(group.classList.contains('k-segmented')).toBe(true);
    expect(radios().map((r) => r.textContent)).toEqual(['Centered', 'Full width']);
    expect(radios().map((r) => r.getAttribute('aria-checked'))).toEqual(['true', 'false']);
    expect(radios().map((r) => r.tabIndex)).toEqual([0, -1]);
    h.emit({ type: 'layout', layout: 'full' });
    expect(radios().map((r) => r.getAttribute('aria-checked'))).toEqual(['false', 'true']);
    expect(radios().map((r) => r.tabIndex)).toEqual([-1, 0]);
  });

  it('posts the wanted mode once, runtime-pending, and keeps the old selection until the host answers', () => {
    const h = mountHeader(headerState());
    const full = radios()[1]!;
    fireEvent.click(full);
    fireEvent.click(full);
    expect(h.send.setLayout).toHaveBeenCalledTimes(1);
    expect(h.send.setLayout).toHaveBeenCalledWith('full', expect.any(String));
    expect(radios()[0]!.getAttribute('aria-checked')).toBe('true');
  });

  it('moves and selects with the arrow keys, wrapping at the ends', () => {
    const h = mountHeader(headerState());
    radios()[0]!.focus();
    fireEvent.keyDown(radios()[0]!, { key: 'ArrowRight' });
    expect(h.send.setLayout).toHaveBeenLastCalledWith('full', expect.any(String));
    expect(document.activeElement).toBe(radios()[1]);
    fireEvent.keyDown(radios()[1]!, { key: 'ArrowRight' });
    expect(h.send.setLayout).toHaveBeenLastCalledWith('centered', expect.any(String));
    fireEvent.keyDown(radios()[0]!, { key: 'Home' });
    expect(h.send.setLayout).toHaveBeenCalledTimes(2);
  });
});

/**
 * The page's own `.menuButton{display:flex}` comes after `.hidden{display:none}` at the same specificity, so a
 * class-hidden menu item stayed visible. Load the page rules and Header.css, as the webview does, and read the
 * computed `display`.
 */
function installPageStyles(): void {
  const page = readFileSync(join(HERE, '..', 'webview.html'), 'utf8');
  const css = [...page.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join('\n');
  for (const text of [css, readFileSync(join(HERE, 'Header.css'), 'utf8')]) {
    const el = document.createElement('style');
    el.textContent = text;
    document.head.appendChild(el);
  }
}

const shown = (sel: string): boolean => getComputedStyle($(sel)).display !== 'none';

describe('TicketMenu — computed visibility', () => {
  beforeEach(installPageStyles);
  afterEach(() => document.head.querySelectorAll('style').forEach((s) => s.remove()));

  it('open, unpaused ticket with no parent: hides Resume, Create follow-up, Detach and Reopen', () => {
    mountHeader(headerState({ canClose: true }));
    expect(shown('#pauseItem')).toBe(true);
    expect(shown('#closeTicket')).toBe(true);
    expect(shown('#archiveTicket')).toBe(true);
    for (const sel of ['#resumeItem', '#followUpItem', '#detachSubtask', '#reopenTicket']) {
      expect(shown(sel), sel).toBe(false);
    }
  });

  it('paused ticket: shows Resume, hides Pause', () => {
    mountHeader(headerState({ paused: true }));
    expect(shown('#resumeItem')).toBe(true);
    expect(shown('#pauseItem')).toBe(false);
  });

  it('closed sub-task: shows Reopen and Detach, hides Close; an archived ticket hides Archive', () => {
    mountHeader(headerState({ canClose: false, canReopen: true, canDetachSubtask: true, canArchive: false }));
    expect(shown('#reopenTicket')).toBe(true);
    expect(shown('#detachSubtask')).toBe(true);
    expect(shown('#closeTicket')).toBe(false);
    expect(shown('#archiveTicket')).toBe(false);
  });
});
