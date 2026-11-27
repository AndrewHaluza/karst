// @vitest-environment jsdom
/**
 * The row-1 `P<n>` planning link and the card it reveals: the visible identifier IS the link (`@ui:UI-R09c`),
 * the card states the host's facts (`@ui:UI-R31`), its one action opens the artifacts folder, and the header
 * keeps one surface at a time across the ⋯ menu, the card and a PR popover (T1400).
 */
import { describe, expect, it } from 'vitest';
import { act, fireEvent, render } from '@testing-library/react';
import type { DashboardOriginView } from '../stateTypes.js';
import { createSender } from '../webviewSend.js';
import { DashboardAppProvider } from './DashboardAppContext.js';
import { pr } from './fixtures/prsPanelKit.js';
import { $, has, headerState, installHeaderDoubles, mountHeader, originView } from './fixtures/headerKit.js';
import { PrInfo } from './PrInfo.js';

installHeaderDoubles();

const noModel = (): DashboardOriginView => {
  const origin = originView();
  return { ...origin, session: { ...origin.session, model: null } };
};

describe('PlanningLink — the identifier is the navigation', () => {
  it('draws P17 for a ticket filed from a draft, and nothing for a hand-made ticket', () => {
    mountHeader(headerState({ origin: originView() }));
    expect($('#planLink').textContent).toBe('P17');
    expect($('#planLink').getAttribute('data-act')).toBe('plan-open');
    expect($('#planLink').getAttribute('data-session-id')).toBe('17');
    expect($('#planLink').getAttribute('aria-expanded')).toBe('false');
    // The card is the hover/focus surface: never a second tooltip stacked on top of it.
    expect($('#planLink').hasAttribute('data-tip')).toBe(false);
    expect($('#planLink').getAttribute('title')).toBeNull();
    mountHeader(headerState());
    expect(document.querySelector('#planLink')).toBeNull();
  });

  it('posts plan-open once, runtime-pending, and never twice while pending (UI-R11)', () => {
    const h = mountHeader(headerState({ origin: originView() }));
    fireEvent.click($('#planLink'));
    fireEvent.click($('#planLink'));
    expect(h.send.planOpen).toHaveBeenCalledTimes(1);
    expect(h.send.planOpen).toHaveBeenCalledWith(17, 'req-1');
    expect(has('#planLink', 'is-pending')).toBe(true);
  });
});

describe('PlanningCard — the host facts', () => {
  it('opens on keyboard focus with a labelled dialog, the session facts and one action', () => {
    mountHeader(headerState({ origin: originView() }));
    act(() => ($('#planLink') as HTMLButtonElement).focus());
    const dialog = document.querySelector<HTMLElement>('#planCard');
    expect(dialog).not.toBeNull();
    expect(dialog!.getAttribute('role')).toBe('dialog');
    expect($('#planLink').getAttribute('aria-expanded')).toBe('true');
    expect($('#planLink').getAttribute('aria-controls')).toBe('planCard');
    const title = document.getElementById(dialog!.getAttribute('aria-labelledby')!);
    expect(title!.textContent).toBe('P17 · Per-repo base branch override');
    expect(dialog!.querySelector('.planCardSub')!.textContent).toBe('Planning session · filed · Claude Code · Model Two');
    const rows = [...dialog!.querySelectorAll('.planCardTable tr')].map((tr) => [tr.querySelector('th')!.textContent, tr.querySelector('td')!.textContent]);
    expect(rows).toEqual([
      ['This ticket', 'from D88'],
      ['Drafts', '3 accepted · 1 pending · 0 discarded'],
      ['Started', expect.stringContaining('2026')],
    ]);
    // UI-R09c: P17 itself opens the session — no duplicate "Open session" button.
    expect([...dialog!.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['Artifacts']);
    expect(dialog!.textContent).toContain('Click P17 to open the session.');
  });

  it('leaves the model out of the subtitle when the session names none', () => {
    mountHeader(headerState({ origin: noModel() }));
    act(() => ($('#planLink') as HTMLButtonElement).focus());
    expect(document.querySelector('#planCard .planCardSub')!.textContent).toBe('Planning session · filed · Claude Code');
  });

  it('posts plan-artifacts once, runtime-pending, from the card button', () => {
    const h = mountHeader(headerState({ origin: originView() }));
    act(() => ($('#planLink') as HTMLButtonElement).focus());
    const artifacts = $('[data-act="plan-artifacts"]');
    fireEvent.click(artifacts);
    fireEvent.click(artifacts);
    expect(h.send.planArtifacts).toHaveBeenCalledTimes(1);
    expect(h.send.planArtifacts).toHaveBeenCalledWith(17, 'req-1');
    expect(has('[data-act="plan-artifacts"]', 'is-pending')).toBe(true);
  });
});

describe('PlanningCard — one header surface at a time', () => {
  it('closes an open ⋯ menu when the card opens', () => {
    mountHeader(headerState({ origin: originView() }));
    fireEvent.click($('#moreBtn'));
    expect(has('#menuPopover', 'open')).toBe(true);
    act(() => ($('#planLink') as HTMLButtonElement).focus());
    expect(document.querySelector('#planCard')).not.toBeNull();
    expect(has('#menuPopover', 'hidden')).toBe(true);
  });

  it('closes the open card when the ⋯ menu opens', () => {
    mountHeader(headerState({ origin: originView() }));
    act(() => ($('#planLink') as HTMLButtonElement).focus());
    expect(document.querySelector('#planCard')).not.toBeNull();
    fireEvent.click($('#moreBtn'));
    expect(document.querySelector('#planCard')).toBeNull();
    expect(has('#menuPopover', 'open')).toBe(true);
  });

  it('closes the open card when a PR popover opens', () => {
    mountHeader(headerState({ origin: originView() }));
    act(() => ($('#planLink') as HTMLButtonElement).focus());
    expect(document.querySelector('#planCard')).not.toBeNull();
    // A PR popover opened on mount claims the surface, the same way the toggle's click does.
    render(
      <DashboardAppProvider bridge={{ send: createSender({ postMessage: () => {} }), getState: () => null, setState: () => {}, subscribe: () => () => {} }}>
        <PrInfo p={pr()} open onToggle={() => {}} />
      </DashboardAppProvider>,
    );
    expect(document.querySelector('#planCard')).toBeNull();
  });
});
