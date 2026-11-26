/**
 * COMPONENT-mode tests for the Ticketing tab (NDL-126 §9.5, T1371).
 *
 * The tab is ONE settings list in two sections — Board and Behavior — with the
 * same row grammar as the Accounts quota card (D829/@ui:UI-R39): label and one
 * help line at the left, the control in the right-hand column. Its distinctive
 * rules are the fetch lifecycle and "never silently drop a saved value":
 *
 * - a saved list / status the provider no longer offers stays VISIBLE and
 *   selected — dropping it would save an empty value away and quietly
 *   unconfigure a working board;
 * - the prerequisite hints, the loading copy, the empty-list copy and the
 *   stale-value copy are the vanilla strings, because they are what tell a user
 *   which prerequisite is missing (a disabled select always has one);
 * - the statuses load on their own, once, when the list id and the token are
 *   set (bug 1), and a list change re-arms them;
 * - each status select derives its options from ITS OWN saved value (bug 2):
 *   the start select must show the start status, never the ship status;
 * - "Don't change" is the first option and maps to `advanceOnX:false`, keeping
 *   the saved status string;
 * - the token flag is keychain state: setting or clearing it must never touch
 *   the draft, because the provider itself is chosen during first-time setup;
 * - leaving ClickUp clears every ClickUp-only key;
 * - the coherence rule (an unset status filled only for a toggle that is ON)
 *   belongs to the REDUCER and must not be re-derived here (R-X4) — asserted
 *   through the draft.
 */
// @vitest-environment jsdom
import { act } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Manifest, TicketingConfig } from '../../../../manifest/types.js';
import { TICKET_PROVIDER_IDS } from '../../../../model/ticketProviders.js';
import { AnnouncerProvider } from '../primitives/LiveRegion.js';
import { SettingsAppProvider, useSettingsApp } from '../SettingsAppContext.js';
import { createTestBridge, type TestBridge } from '../testBridge.js';
import { FIXTURE_STATE_PUSH } from '../testFixtures.js';
import type { SettingsState } from '../../state.js';
import { TicketingSection } from './TicketingSection.js';
import { AppProbe, readProbe, type AppProbeShape } from './AppProbe.js';

afterEach(cleanup);
beforeEach(() => {
  // Stand in for the injected provider runtime (R-X3 island).
  (globalThis as unknown as Record<string, unknown>).providerBadgeInto = (
    el: HTMLElement,
    provider: string,
  ) => {
    el.textContent = `badge:${provider}`;
  };
});

const asCfg = (block: Record<string, unknown>): TicketingConfig =>
  block as unknown as TicketingConfig;

function stateWith(ticketing: Record<string, unknown>, tokenConfigured = true): SettingsState {
  return {
    ...FIXTURE_STATE_PUSH,
    tokenConfigured,
    manifest: { ...FIXTURE_STATE_PUSH.manifest, ticketing: asCfg(ticketing) },
  };
}

function mountTicketing(state: SettingsState = FIXTURE_STATE_PUSH): {
  bridge: TestBridge;
  probe(): AppProbeShape;
} {
  const bridge = createTestBridge();
  const view = render(
    <AnnouncerProvider>
      <SettingsAppProvider bridge={bridge} initialSection="ticketing">
        <TicketingSection />
        <AppProbe />
      </SettingsAppProvider>
    </AnnouncerProvider>,
  );
  act(() => bridge.push({ type: 'state', state }));
  return { bridge, probe: () => readProbe(view.baseElement) };
}

const byLabel = (label: string): HTMLInputElement => {
  const control = [...document.querySelectorAll('input, select, textarea')].find((el) => {
    const id = el.getAttribute('id');
    if (!id) return false;
    return document.querySelector(`label[for="${id}"]`)?.textContent?.trim() === label;
  });
  if (!control) throw new Error(`no control labelled ${label}`);
  return control as HTMLInputElement;
};

const byAriaLabel = (label: string): Element => {
  const node = document.querySelector(`[aria-label="${label}"]`);
  if (!node) throw new Error(`no control labelled ${label}`);
  return node;
};

const cfgOf = (probe: () => AppProbeShape): Record<string, unknown> =>
  (probe().draft as { ticketing?: Record<string, unknown> }).ticketing ?? {};

/** The Board / Behavior section titles, in render order. */
const sectionTitles = (): string[] =>
  [...document.querySelectorAll('#section-ticketing [data-region] h3')].map(
    (n) => n.textContent ?? '',
  );

/** The connection line's text. */
function connectionText(): string {
  return document.querySelector('[data-region="ticketing-connection-status"]')?.textContent ?? '';
}

describe('TicketingSection — the page', () => {
  it('gives the page a header and two titled sections for ClickUp', () => {
    mountTicketing(stateWith({ provider: 'clickup' }));
    expect(document.querySelector('#section-ticketing')).not.toBeNull();
    expect(document.querySelector('.page-title')?.textContent).toBe('Ticketing');
    expect(document.querySelector('.page-desc')?.textContent).toBe(
      'Connect Karst to the board your tickets live on.',
    );
    // One list in two sections (the prototype's regions, @ui:UI-R39).
    expect(document.querySelector('[data-region="ticketing-board"]')).not.toBeNull();
    expect(document.querySelector('[data-region="ticketing-behavior"]')).not.toBeNull();
    expect(sectionTitles()).toEqual(['Board', 'Behavior']);
  });

  it('lays every row out with the shared row grammar (UI-R41)', () => {
    mountTicketing(stateWith({ provider: 'clickup' }));
    const rows = [...document.querySelectorAll('#section-ticketing .ticketing-row')];
    // Provider, Team ID, List, API token, search, sub-tasks, start, ship.
    expect(rows).toHaveLength(8);
    for (const row of rows) {
      const text = row.querySelector('.ticketing-row-text') ?? row.querySelector('label');
      expect(text, 'row has no label cell').not.toBeNull();
    }
    // The provider row keeps the pinned wrap and trigger (SET-30).
    expect(document.getElementById('provSelectWrap')?.classList.contains('ticketing-row')).toBe(true);
  });

  it('offers every provider from the imported vocabulary, in order', () => {
    mountTicketing();
    const options = Array.from(document.querySelectorAll('.provselect-opt')).map(
      (n) => n.getAttribute('data-value'),
    );
    expect(options).toEqual([...TICKET_PROVIDER_IDS]);
  });

  it('mounts the provider mark through the shared runtime (R-X3)', () => {
    mountTicketing();
    const trigger = document.getElementById('providerTrigger') as HTMLElement;
    expect(trigger.querySelector('.provbadge')?.textContent).toBe('badge:manual');
  });

  it('renders only the Provider row for a manual provider, and says why', () => {
    mountTicketing(stateWith({ provider: 'manual' }));
    expect(sectionTitles()).toEqual(['Board']);
    expect(document.querySelector('[data-region="ticketing-behavior"]')).toBeNull();
    expect(document.querySelectorAll('#section-ticketing .ticketing-row')).toHaveLength(1);
    expect(
      document.querySelector('[data-region="ticketing-board"] .k-field-help')?.textContent,
    ).toBe('Karst keeps tickets on its own. No board settings.');
    // No connection line and no reload for a manual board.
    expect(document.querySelector('[data-region="ticketing-connection-status"]')).toBeNull();
    expect(() => byAriaLabel('Reload lists and statuses from ClickUp')).toThrow();
  });

  it('defaults the search toggle ON for ClickUp', () => {
    mountTicketing(stateWith({ provider: 'clickup' }));
    expect(byLabel('Search tickets in Add ticket').checked).toBe(true);
  });
});

describe('TicketingSection — the provider trigger (SET-29, SET-30)', () => {
  it('names the trigger with the provider label and keeps one tab stop (SET-30)', () => {
    mountTicketing(stateWith({ provider: 'clickup' }));
    const trigger = document.getElementById('providerTrigger') as HTMLElement;
    expect(trigger.getAttribute('aria-label')).toBeNull();
    expect(trigger.textContent).toContain('ClickUp');
    expect(screen.getByRole('button', { name: 'Provider ClickUp' })).toBe(trigger);
    fireEvent.click(trigger);
    const opts = [
      ...document.getElementById('providerMenu')!.querySelectorAll<HTMLElement>('[role="option"]'),
    ];
    // One tab stop: Tab leaves the listbox instead of walking every option.
    expect(opts.filter((o) => o.tabIndex === 0)).toHaveLength(1);
    expect(opts.find((o) => o.getAttribute('data-value') === 'clickup')!.tabIndex).toBe(0);
  });

  it('Home and End move focus to the first and last option (SET-30)', () => {
    mountTicketing(stateWith({ provider: 'manual' }));
    fireEvent.click(document.getElementById('providerTrigger')!);
    const opts = [
      ...document.getElementById('providerMenu')!.querySelectorAll<HTMLElement>('[role="option"]'),
    ];
    const first = opts[0]!;
    const last = opts[opts.length - 1]!;
    last.focus();
    fireEvent.keyDown(last, { key: 'Home' });
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(first, { key: 'End' });
    expect(document.activeElement).toBe(last);
  });
});

describe('TicketingSection — the provider menu is keyboard-operable and dismissable', () => {
  const trigger = (): HTMLElement => document.getElementById('providerTrigger')!;
  const menu = (): HTMLElement => document.getElementById('providerMenu')!;
  const options = (): HTMLElement[] => [...menu().querySelectorAll<HTMLElement>('[role="option"]')];
  const isOpen = (): boolean => !menu().classList.contains('hidden');

  it('focuses the selected option on open, and arrows wrap', () => {
    mountTicketing();
    fireEvent.click(trigger());
    const selected = options().find((o) => o.getAttribute('aria-selected') === 'true')!;
    expect(document.activeElement).toBe(selected);
    const first = options()[0]!;
    const last = options()[options().length - 1]!;
    first.focus();
    fireEvent.keyDown(first, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(last);
    fireEvent.keyDown(last, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(first);
  });

  it('a pick returns focus to the trigger', () => {
    mountTicketing();
    fireEvent.click(trigger());
    fireEvent.keyDown(options()[0]!, { key: 'Enter' });
    expect(isOpen()).toBe(false);
    expect(document.activeElement).toBe(trigger());
  });

  it('Escape and an outside click close it', () => {
    mountTicketing();
    fireEvent.click(trigger());
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(isOpen()).toBe(false);
    expect(document.activeElement).toBe(trigger());
    fireEvent.click(trigger());
    fireEvent.mouseDown(document.body);
    expect(isOpen()).toBe(false);
  });
});

describe('TicketingSection — the token is keychain state, not draft state', () => {
  it('offers only the action that applies, with the state right before it', () => {
    mountTicketing(stateWith({ provider: 'clickup' }, false));
    expect(document.querySelector('.ticketing-token .status-pill')?.textContent).toContain('Not set');
    const button = screen.getByRole('button', { name: 'Set token' });
    expect(button).toBeTruthy();
    // Directly after the state, not at the far edge of the control column.
    expect(document.querySelector('.ticketing-token')?.lastElementChild).toBe(button);
    expect(() => screen.getByRole('button', { name: 'Clear token' })).toThrow();
  });

  it('swaps to Clear once the host reports a token', () => {
    const { bridge, probe } = mountTicketing(stateWith({ provider: 'clickup' }, false));
    act(() => bridge.push({ type: 'token-state', configured: true }));
    expect(document.querySelector('.ticketing-token .status-pill')?.textContent).toContain('Set');
    expect(screen.getByRole('button', { name: 'Clear token' })).toBeTruthy();
    expect(() => screen.getByRole('button', { name: 'Set token' })).toThrow();
    // …and the draft is untouched: the provider is chosen during first-time
    // setup, and a `state` push must never be the thing that carries it.
    expect(cfgOf(probe)).toMatchObject({ provider: 'clickup' });
    expect(probe().draft).toMatchObject({ ticketing: FIXTURE_STATE_PUSH.manifest.ticketing ?? {} });
  });

  it('posts set-token and enters pending on activation (R11)', () => {
    const { bridge } = mountTicketing(stateWith({ provider: 'clickup' }, false));
    const button = screen.getByRole('button', { name: 'Set token' });
    fireEvent.click(button);
    expect(bridge.last('set-token')).toBeDefined();
    expect(button.getAttribute('aria-busy')).toBe('true');
  });

  it('drops a second activation while in flight (R12)', () => {
    const { bridge } = mountTicketing(stateWith({ provider: 'clickup' }, false));
    const button = screen.getByRole('button', { name: 'Set token' });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(bridge.all('set-token')).toHaveLength(1);
  });

  it('clears on clear-token, and settles once the host answers', () => {
    const { bridge } = mountTicketing(stateWith({ provider: 'clickup' }, true));
    const button = screen.getByRole('button', { name: 'Clear token' });
    fireEvent.click(button);
    expect(bridge.last('clear-token')).toBeDefined();
    expect(button.getAttribute('aria-busy')).toBe('true');
    act(() => bridge.push({ type: 'token-state', configured: false }));
    expect(document.querySelector('.ticketing-token .status-pill')?.textContent).toContain('Not set');
  });

  it('ships the Clear control as secondary, not danger', () => {
    mountTicketing(stateWith({ provider: 'clickup' }, true));
    const button = screen.getByRole('button', { name: 'Clear token' });
    expect(button.className).toContain('k-btn--secondary');
    expect(button.className).not.toContain('k-btn--danger');
  });
});

describe('TicketingSection — leaving ClickUp clears what only ClickUp means', () => {
  it('drops the team, the behavior rows and the search toggle', () => {
    const { probe } = mountTicketing(
      stateWith({
        provider: 'clickup',
        teamId: '9001',
        listId: 'L1',
        advanceOnShip: true,
        shipStatus: 'done',
        advanceOnStart: true,
        startStatus: 'in progress',
        searchEnabled: true,
      }),
    );
    const manual = document.querySelector('[data-value="manual"]') as Element;
    fireEvent.click(manual);
    const cfg = cfgOf(probe);
    expect(cfg).toMatchObject({ provider: 'manual', advanceOnShip: false, advanceOnStart: false });
    expect(cfg).not.toHaveProperty('shipStatus');
    expect(cfg).not.toHaveProperty('startStatus');
    expect(cfg).not.toHaveProperty('searchEnabled');
  });
});

describe('TicketingSection — the list fetch lifecycle', () => {
  it('posts nothing until a team id AND a token exist', () => {
    const { bridge } = mountTicketing(stateWith({ provider: 'clickup' }, false));
    expect(bridge.all('fetch-ticket-lists')).toHaveLength(0);
    expect(document.querySelector('[data-region="ticketing-board"]')?.textContent).toContain(
      'Add a Team ID and API token to load lists.',
    );
  });

  it('auto-fetches once both prerequisites are met, then not again', () => {
    const { bridge } = mountTicketing(stateWith({ provider: 'clickup', teamId: '9001' }));
    expect(bridge.all('fetch-ticket-lists')).toHaveLength(1);
    expect(bridge.last('fetch-ticket-lists')).toMatchObject({ teamId: '9001' });
  });

  it('shows the loading copy and blocks a duplicate activation while in flight', () => {
    const { bridge } = mountTicketing(stateWith({ provider: 'clickup', teamId: '9001' }));
    const reload = byAriaLabel('Reload lists and statuses from ClickUp');
    expect(reload.getAttribute('aria-busy')).toBe('true');
    expect(document.body.textContent).toContain('Loading lists…');
    fireEvent.click(reload);
    expect(bridge.all('fetch-ticket-lists')).toHaveLength(1);
  });

  it('shows the provider lists once they land, and enables the control', () => {
    const { bridge } = mountTicketing(stateWith({ provider: 'clickup', teamId: '9001' }));
    act(() =>
      bridge.push({
        type: 'ticket-lists',
        lists: [
          { id: 'L1', name: 'Backlog', space: 'Core' },
          { id: 'L2', name: 'Backlog', space: 'Ops' },
        ],
      }),
    );
    const select = byLabel('List') as unknown as HTMLSelectElement;
    expect(Array.from(select.options).map((o) => o.value)).toEqual(['', 'L1', 'L2']);
    expect(Array.from(select.options).map((o) => o.label)).toContain('Core / Backlog');
    expect(select.disabled).toBe(false);
    expect(document.querySelector('[data-region="ticketing-board"]')?.textContent).toContain(
      'Karst creates and updates tickets in this list.',
    );
  });

  it('shows a saved list that the provider offers once, by its name', () => {
    const { bridge } = mountTicketing(stateWith({ provider: 'clickup', teamId: '9001', listId: 'L2' }));
    act(() =>
      bridge.push({
        type: 'ticket-lists',
        lists: [
          { id: 'L1', name: 'Backlog', space: 'Core' },
          { id: 'L2', name: 'Sprint', space: 'Core' },
        ],
      }),
    );
    const select = byLabel('List') as unknown as HTMLSelectElement;
    expect(Array.from(select.options).map((o) => o.value)).toEqual(['L1', 'L2']);
    expect(select.value).toBe('L2');
    expect(select.selectedOptions[0]?.label).toBe('Core / Sprint');
    expect(Array.from(select.options).map((o) => o.label)).not.toContain('L2');
  });

  it('keeps a saved list visible and selected when the provider no longer offers it', () => {
    const { bridge } = mountTicketing(stateWith({ provider: 'clickup', teamId: '9001', listId: 'L9' }));
    act(() => bridge.push({ type: 'ticket-lists', lists: [{ id: 'L1', name: 'Backlog', space: 'Core' }] }));
    const select = byLabel('List') as unknown as HTMLSelectElement;
    expect(Array.from(select.options).map((o) => o.value)).toEqual(['L9', 'L1']);
    expect(select.value).toBe('L9');
    expect(document.querySelector('[data-region="ticketing-board"]')?.textContent).toContain(
      '"L9" is no longer in this workspace.',
    );
  });

  it('says so when the workspace has no lists at all', () => {
    const { bridge } = mountTicketing(stateWith({ provider: 'clickup', teamId: '9001' }));
    act(() => bridge.push({ type: 'ticket-lists', lists: [] }));
    expect(document.querySelector('[data-region="ticketing-board"]')?.textContent).toContain(
      'This workspace has no lists.',
    );
    expect((byLabel('List') as unknown as HTMLSelectElement).disabled).toBe(true);
  });

  it('shows the host failure message inline and keeps the control locked', () => {
    const { bridge } = mountTicketing(stateWith({ provider: 'clickup', teamId: '9001' }));
    act(() => bridge.push({ type: 'ticket-lists-error', message: 'No token configured' }));
    expect(document.body.textContent).toContain('No token configured');
    expect((byLabel('List') as unknown as HTMLSelectElement).disabled).toBe(true);
  });

  it('re-arms the auto-fetch when the team id changes', () => {
    const { bridge } = mountTicketing(stateWith({ provider: 'clickup', teamId: '9001' }));
    act(() => bridge.push({ type: 'ticket-lists', lists: [] }));
    fireEvent.change(byLabel('Team ID'), { target: { value: '9002' } });
    expect(bridge.all('fetch-ticket-lists')).toHaveLength(2);
    expect(bridge.last('fetch-ticket-lists')).toMatchObject({ teamId: '9002' });
  });
});

describe('TicketingSection — the status fetch loads on its own (bug 1)', () => {
  it('posts both fetches once, without a click, when the prerequisites are set', () => {
    const { bridge, probe } = mountTicketing(
      stateWith({
        provider: 'clickup',
        teamId: '9001',
        listId: 'L1',
        advanceOnStart: false,
        advanceOnShip: false,
      }),
    );
    // Acceptance 2: exactly one of each, no click needed.
    expect(bridge.all('fetch-ticket-lists')).toHaveLength(1);
    expect(bridge.all('fetch-ticket-statuses')).toHaveLength(1);
    expect(bridge.last('fetch-ticket-statuses')).toMatchObject({ listId: 'L1', teamId: '9001' });
    // …and an off toggle needs no status, so the auto-load leaves the draft
    // clean: the topbar can still say "All changes saved".
    act(() => bridge.push({ type: 'ticket-lists', lists: [{ id: 'L1', name: 'Backlog', space: 'Core' }] }));
    act(() => bridge.push({ type: 'ticket-statuses', statuses: ['open', 'in progress', 'qa'] }));
    expect(probe().dirtySections).toEqual([]);
    expect(cfgOf(probe)).not.toHaveProperty('shipStatus');
    expect(cfgOf(probe)).not.toHaveProperty('startStatus');
  });

  it('does not fetch until a list id AND a token exist', () => {
    const { bridge } = mountTicketing(stateWith({ provider: 'clickup', teamId: '9001' }));
    expect(bridge.all('fetch-ticket-statuses')).toHaveLength(0);
    // …and the disabled select says which prerequisite is missing.
    const ship = byLabel('Status when Karst ships') as unknown as HTMLSelectElement;
    expect(ship.disabled).toBe(true);
    expect(document.body.textContent).toContain('Add a List ID and API token to load statuses.');
  });

  it('fills an unset status only for a toggle that is ON', () => {
    const { bridge, probe } = mountTicketing(
      stateWith({
        provider: 'clickup',
        teamId: '9001',
        listId: 'L1',
        advanceOnShip: true,
        advanceOnStart: true,
      }),
    );
    act(() => bridge.push({ type: 'ticket-statuses', statuses: ['open', 'in progress', 'Done'] }));
    // The REDUCER decides this, not the component (R-X4) — the draft proves it.
    expect(cfgOf(probe)).toMatchObject({ shipStatus: 'open', startStatus: 'in progress' });
  });

  it('never overwrites a status the user already chose', () => {
    const { bridge, probe } = mountTicketing(
      stateWith({
        provider: 'clickup',
        teamId: '9001',
        listId: 'L1',
        advanceOnShip: true,
        shipStatus: 'Done',
        advanceOnStart: true,
        startStatus: 'Blocked',
      }),
    );
    act(() => bridge.push({ type: 'ticket-statuses', statuses: ['open', 'Done', 'Blocked'] }));
    expect(cfgOf(probe)).toMatchObject({ shipStatus: 'Done', startStatus: 'Blocked' });
  });

  it('keeps a saved status the provider no longer lists, and says so', () => {
    const { bridge } = mountTicketing(
      stateWith({
        provider: 'clickup',
        teamId: '9001',
        listId: 'L1',
        advanceOnShip: true,
        shipStatus: 'Done',
      }),
    );
    act(() => bridge.push({ type: 'ticket-statuses', statuses: ['open'] }));
    const select = byLabel('Status when Karst ships') as unknown as HTMLSelectElement;
    expect(Array.from(select.options).map((o) => o.value)).toEqual(['', 'Done', 'open']);
    expect(select.value).toBe('Done');
    expect(document.body.textContent).toContain('"Done" is no longer in this list.');
  });

  it('says so when the list has no statuses at all', () => {
    const { bridge } = mountTicketing(
      stateWith({ provider: 'clickup', teamId: '9001', listId: 'L1', advanceOnShip: true }),
    );
    act(() => bridge.push({ type: 'ticket-statuses', statuses: [] }));
    expect(document.body.textContent).toContain('This list has no statuses.');
    expect((byLabel('Status when Karst ships') as unknown as HTMLSelectElement).disabled).toBe(true);
  });

  it('shows the failure inline and settles the fetch as a failure', () => {
    const { bridge } = mountTicketing(
      stateWith({ provider: 'clickup', teamId: '9001', listId: 'L1', advanceOnShip: true }),
    );
    act(() => bridge.push({ type: 'ticket-lists', lists: [{ id: 'L1', name: 'Backlog', space: 'Core' }] }));
    act(() => bridge.push({ type: 'ticket-statuses-error', message: 'ClickUp said no' }));
    expect(document.body.textContent).toContain('ClickUp said no');
    const reload = byAriaLabel('Reload lists and statuses from ClickUp');
    expect(reload.getAttribute('aria-busy')).toBeNull();
  });

  it('re-arms the status fetch when the list changes', () => {
    const { bridge } = mountTicketing(
      stateWith({ provider: 'clickup', teamId: '9001', listId: 'L1', advanceOnShip: true }),
    );
    act(() => bridge.push({ type: 'ticket-statuses', statuses: ['open'] }));
    act(() =>
      bridge.push({
        type: 'ticket-lists',
        lists: [
          { id: 'L1', name: 'Backlog', space: 'Core' },
          { id: 'L2', name: 'Ops', space: 'Core' },
        ],
      }),
    );
    fireEvent.change(byLabel('List'), { target: { value: 'L2' } });
    // A list change drops the old statuses and re-arms the auto-load.
    expect(bridge.all('fetch-ticket-statuses')).toHaveLength(2);
    expect(bridge.last('fetch-ticket-statuses')).toMatchObject({ listId: 'L2' });
  });
});

describe('TicketingSection — each status select shows its OWN saved value (bug 2)', () => {
  it('shows "in progress" on start and "qa" on ship before the statuses load', () => {
    mountTicketing(
      stateWith({
        provider: 'clickup',
        teamId: '9001',
        listId: 'L1',
        advanceOnStart: true,
        startStatus: 'in progress',
        advanceOnShip: true,
        shipStatus: 'qa',
      }),
    );
    // Acceptance 3: bug 2 showed the SHIP status in the start select because
    // both selects shared one derived view built from `cfg.shipStatus`.
    const start = byLabel('Status when work starts') as unknown as HTMLSelectElement;
    const ship = byLabel('Status when Karst ships') as unknown as HTMLSelectElement;
    expect(start.value).toBe('in progress');
    expect(ship.value).toBe('qa');
  });

  it('maps "Don\'t change" to the flag, and a status to flag + value', () => {
    const { bridge, probe } = mountTicketing(
      stateWith({
        provider: 'clickup',
        teamId: '9001',
        listId: 'L1',
        advanceOnShip: true,
        shipStatus: 'qa',
        advanceOnStart: true,
        startStatus: 'in progress',
      }),
    );
    const ship = byLabel('Status when Karst ships') as unknown as HTMLSelectElement;
    const start = byLabel('Status when work starts') as unknown as HTMLSelectElement;
    act(() => bridge.push({ type: 'ticket-statuses', statuses: ['in progress', 'qa'] }));
    expect(Array.from(ship.options).map((o) => o.value)).toEqual(['', 'in progress', 'qa']);
    expect(ship.options[0]?.label).toBe("Don't change");

    fireEvent.change(ship, { target: { value: '' } });
    expect(cfgOf(probe)).toMatchObject({ advanceOnShip: false, shipStatus: 'qa' });

    fireEvent.change(ship, { target: { value: 'qa' } });
    expect(cfgOf(probe)).toMatchObject({ advanceOnShip: true, shipStatus: 'qa' });

    fireEvent.change(start, { target: { value: '' } });
    expect(cfgOf(probe)).toMatchObject({ advanceOnStart: false, startStatus: 'in progress' });

    fireEvent.change(start, { target: { value: 'in progress' } });
    expect(cfgOf(probe)).toMatchObject({ advanceOnStart: true, startStatus: 'in progress' });
  });

  it('always explains a disabled status select', () => {
    const { bridge } = mountTicketing(stateWith({ provider: 'clickup', teamId: '9001' }));
    const ship = byLabel('Status when Karst ships') as unknown as HTMLSelectElement;
    expect(ship.disabled).toBe(true);
    expect(document.body.textContent).toContain('Add a List ID and API token to load statuses.');
    act(() => bridge.push({ type: 'ticket-statuses-error', message: 'ClickUp said no' }));
    expect(document.body.textContent).toContain('ClickUp said no');
  });
});

describe('TicketingSection — one reload control and the connection line', () => {
  it('renders one reload button that reloads lists AND statuses', () => {
    const { bridge } = mountTicketing(
      stateWith({ provider: 'clickup', teamId: '9001', listId: 'L1', advanceOnShip: true }),
    );
    // Auto-load has both in flight; answer them, then use the one button.
    act(() => bridge.push({ type: 'ticket-lists', lists: [{ id: 'L1', name: 'Backlog', space: 'Core' }] }));
    act(() => bridge.push({ type: 'ticket-statuses', statuses: ['open'] }));
    const reloads = [...document.querySelectorAll('#section-ticketing [aria-label*="Reload"]')];
    expect(reloads).toHaveLength(1);
    const reload = byAriaLabel('Reload lists and statuses from ClickUp');
    fireEvent.click(reload);
    expect(bridge.all('fetch-ticket-lists')).toHaveLength(2);
    expect(bridge.all('fetch-ticket-statuses')).toHaveLength(2);
    expect(reload.getAttribute('aria-busy')).toBe('true');
  });

  it('reports the loaded statuses on the connection line', () => {
    const { bridge } = mountTicketing(
      stateWith({ provider: 'clickup', teamId: '9001', listId: 'L1' }),
    );
    act(() => bridge.push({ type: 'ticket-lists', lists: [{ id: 'L1', name: 'Backlog', space: 'Core' }] }));
    act(() => bridge.push({ type: 'ticket-statuses', statuses: ['open', 'in progress', 'qa'] }));
    expect(connectionText()).toBe('Connected · 3 statuses loaded');
    expect(document.querySelector('[data-region="ticketing-connection-status"]')?.getAttribute('role'))
      .toBe('status');
  });

  it('makes a missing prerequisite the connection line', () => {
    mountTicketing(stateWith({ provider: 'clickup' }, false));
    expect(connectionText()).toBe('Add a Team ID and API token to load lists.');
  });
});

describe('TicketingSection — the Behavior rows', () => {
  it('writes the segmented sub-task mode and shows only its own meaning', () => {
    const { probe } = mountTicketing(stateWith({ provider: 'clickup', teamId: '9001', listId: 'L1' }));
    expect(document.body.textContent).toContain('Sub-tasks stay in Karst.');
    fireEvent.click(screen.getByRole('radio', { name: 'Link' }));
    expect(cfgOf(probe)).toMatchObject({ syncSubtasks: 'link' });
    expect(document.body.textContent).toContain(
      'A sub-task is a child task, and a blocking sub-task blocks its parent.',
    );
    expect(document.body.textContent).not.toContain('Sub-tasks stay in Karst.');
    fireEvent.click(screen.getByRole('radio', { name: 'Full' }));
    expect(cfgOf(probe)).toMatchObject({ syncSubtasks: 'full' });
    expect(document.body.textContent).toContain(
      "Link, plus the sub-task's own status updates.",
    );
    fireEvent.click(screen.getByRole('radio', { name: 'Off' }));
    expect(cfgOf(probe)).toMatchObject({ syncSubtasks: 'off' });
    // Leaving ClickUp drops it with the rest of the ClickUp-only keys.
    fireEvent.click(document.querySelector('[data-value="manual"]') as Element);
    expect(cfgOf(probe)).not.toHaveProperty('syncSubtasks');
  });

  it('writes the search toggle onto the draft', () => {
    const { probe } = mountTicketing(stateWith({ provider: 'clickup', teamId: '9001', listId: 'L1' }));
    fireEvent.click(byLabel('Search tickets in Add ticket'));
    expect(cfgOf(probe)).toMatchObject({ searchEnabled: false });
    expect(document.body.textContent).toContain(
      'The Key field searches this list: TODO tickets first, by priority.',
    );
  });
});

describe('TicketingSection — a reply lands only on the key it was asked for', () => {
  it('drops the statuses of list A when the list moved to B in flight, then loads B', () => {
    const { bridge, probe } = mountTicketing(
      stateWith({ provider: 'clickup', teamId: '9001', listId: 'LA', advanceOnShip: true }),
    );
    act(() =>
      bridge.push({
        type: 'ticket-lists',
        lists: [
          { id: 'LA', name: 'Alpha', space: 'Core' },
          { id: 'LB', name: 'Beta', space: 'Core' },
        ],
      }),
    );
    expect(bridge.all('fetch-ticket-statuses')).toHaveLength(1);
    fireEvent.change(byLabel('List'), { target: { value: 'LB' } });
    // A's reply arrives after the move: it says nothing about B.
    act(() => bridge.push({ type: 'ticket-statuses', statuses: ['a-open', 'a-done'] }));
    const ship = byLabel('Status when Karst ships') as unknown as HTMLSelectElement;
    const start = byLabel('Status when work starts') as unknown as HTMLSelectElement;
    for (const select of [ship, start]) {
      expect(Array.from(select.options).map((o) => o.value)).not.toContain('a-open');
    }
    expect(cfgOf(probe)).not.toHaveProperty('shipStatus');
    // …and B is asked for once the stale reply is gone.
    expect(bridge.all('fetch-ticket-statuses')).toHaveLength(2);
    expect(bridge.last('fetch-ticket-statuses')).toMatchObject({ listId: 'LB' });
    act(() => bridge.push({ type: 'ticket-statuses', statuses: ['b-open', 'b-done'] }));
    expect(Array.from(ship.options).map((o) => o.value)).toEqual(['', 'b-open', 'b-done']);
    expect(cfgOf(probe)).toMatchObject({ shipStatus: 'b-open' });
  });

  it('drops the lists of team A when the team moved to B in flight, then loads B', () => {
    const { bridge } = mountTicketing(stateWith({ provider: 'clickup', teamId: '9001' }));
    expect(bridge.all('fetch-ticket-lists')).toHaveLength(1);
    fireEvent.change(byLabel('Team ID'), { target: { value: '9002' } });
    act(() => bridge.push({ type: 'ticket-lists', lists: [{ id: 'LA', name: 'Alpha', space: 'Core' }] }));
    const list = byLabel('List') as unknown as HTMLSelectElement;
    expect(Array.from(list.options).map((o) => o.value)).not.toContain('LA');
    expect(bridge.all('fetch-ticket-lists')).toHaveLength(2);
    expect(bridge.last('fetch-ticket-lists')).toMatchObject({ teamId: '9002' });
    act(() => bridge.push({ type: 'ticket-lists', lists: [{ id: 'LB', name: 'Beta', space: 'Core' }] }));
    expect(Array.from(list.options).map((o) => o.value)).toContain('LB');
  });
});

describe('TicketingSection — a Discard or an Undo drops the statuses of the list it left', () => {
  /** Stand-in for the shell's Discard and Undo controls. */
  function DiscardControls() {
    const app = useSettingsApp();
    return (
      <>
        <button type="button" onClick={() => app.discard('ticketing')}>test-discard</button>
        <button type="button" onClick={() => app.undoDiscard()}>test-undo</button>
      </>
    );
  }

  it('reloads the statuses for the list the draft is on after each move', () => {
    const bridge = createTestBridge();
    render(
      <AnnouncerProvider>
        <SettingsAppProvider bridge={bridge} initialSection="ticketing">
          <TicketingSection />
          <DiscardControls />
        </SettingsAppProvider>
      </AnnouncerProvider>,
    );
    act(() =>
      bridge.push({
        type: 'state',
        state: stateWith({ provider: 'clickup', teamId: '9001', listId: 'LA', advanceOnShip: true, shipStatus: 'a1' }),
      }),
    );
    act(() =>
      bridge.push({
        type: 'ticket-lists',
        lists: [
          { id: 'LA', name: 'Alpha', space: 'Core' },
          { id: 'LB', name: 'Beta', space: 'Core' },
        ],
      }),
    );
    act(() => bridge.push({ type: 'ticket-statuses', statuses: ['a1'] }));
    fireEvent.change(byLabel('List'), { target: { value: 'LB' } });
    act(() => bridge.push({ type: 'ticket-statuses', statuses: ['b1'] }));
    expect(bridge.all('fetch-ticket-statuses')).toHaveLength(2);

    fireEvent.click(screen.getByText('test-discard'));
    expect(bridge.all('fetch-ticket-statuses')).toHaveLength(3);
    expect(bridge.last('fetch-ticket-statuses')).toMatchObject({ listId: 'LA' });
    const ship = byLabel('Status when Karst ships') as unknown as HTMLSelectElement;
    expect(Array.from(ship.options).map((o) => o.value)).not.toContain('b1');
    act(() => bridge.push({ type: 'ticket-statuses', statuses: ['a1'] }));

    fireEvent.click(screen.getByText('test-undo'));
    expect(bridge.all('fetch-ticket-statuses')).toHaveLength(4);
    expect(bridge.last('fetch-ticket-statuses')).toMatchObject({ listId: 'LB' });
  });
});

describe('TicketingSection — a remount does not settle on the cached reply', () => {
  it('keeps the reload busy until the NEW reply lands', () => {
    const bridge = createTestBridge();
    const tree = (shown: boolean) => (
      <AnnouncerProvider>
        <SettingsAppProvider bridge={bridge} initialSection="ticketing">
          {shown ? <TicketingSection /> : null}
        </SettingsAppProvider>
      </AnnouncerProvider>
    );
    const view = render(tree(true));
    act(() =>
      bridge.push({ type: 'state', state: stateWith({ provider: 'clickup', teamId: '9001', listId: 'L1' }) }),
    );
    act(() => bridge.push({ type: 'ticket-lists', lists: [{ id: 'L1', name: 'Backlog', space: 'Core' }] }));
    act(() => bridge.push({ type: 'ticket-statuses', statuses: ['open'] }));
    view.rerender(tree(false));
    view.rerender(tree(true));
    const reload = byAriaLabel('Reload lists and statuses from ClickUp');
    // The remount re-arms the list auto-load: it waits for ITS reply.
    expect(bridge.all('fetch-ticket-lists')).toHaveLength(2);
    expect(reload.getAttribute('aria-busy')).toBe('true');
    act(() => bridge.push({ type: 'ticket-lists', lists: [{ id: 'L1', name: 'Backlog', space: 'Core' }] }));
    expect(reload.getAttribute('aria-busy')).toBeNull();
    // A reload of the cached statuses waits for the NEW status reply too.
    fireEvent.click(reload);
    act(() => bridge.push({ type: 'ticket-lists', lists: [{ id: 'L1', name: 'Backlog', space: 'Core' }] }));
    expect(reload.getAttribute('aria-busy')).toBe('true');
    act(() => bridge.push({ type: 'ticket-statuses', statuses: ['open'] }));
    expect(reload.getAttribute('aria-busy')).toBeNull();
  });
});

describe('TicketingSection — a "Don\'t change" select shows no stale hint', () => {
  it('hides the saved status of a toggle that is off', () => {
    const { bridge } = mountTicketing(
      stateWith({
        provider: 'clickup',
        teamId: '9001',
        listId: 'L1',
        advanceOnShip: false,
        shipStatus: 'Gone',
      }),
    );
    act(() => bridge.push({ type: 'ticket-statuses', statuses: ['open'] }));
    const ship = byLabel('Status when Karst ships') as unknown as HTMLSelectElement;
    expect(ship.value).toBe('');
    expect(Array.from(ship.options).map((o) => o.value)).toEqual(['', 'open']);
    expect(document.body.textContent).not.toContain('"Gone" is no longer in this list.');
  });
});

/** Keeps the manifest import meaningful for the fixture's block shape. */
export type TicketingManifest = Pick<Manifest, 'ticketing'>;
