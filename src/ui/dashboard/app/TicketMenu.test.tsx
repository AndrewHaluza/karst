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
  it('draws nothing until the first answer, then the blurb or one group per stage', () => {
    const h = mountHeader(headerState());
    expect($('#menuGates').childElementCount).toBe(0);
    h.emit({ type: 'gate-options', options: { uat: [], review: [] } });
    expect($('#menuGates').textContent).toBe('No gates resolved for this ticket yet.');
    h.emit(gates);
    expect([...document.querySelectorAll('.gateHead')].map((e) => e.textContent)).toEqual(['UAT', 'Review']);
    expect(document.querySelectorAll('.gateRow')).toHaveLength(3);
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

  it('posts the flip once per click, runtime-pending, and survives a repeated answer', () => {
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
