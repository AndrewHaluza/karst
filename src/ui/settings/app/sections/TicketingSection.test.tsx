/**
 * COMPONENT-mode tests for the Ticketing tab (NDL-126 §9.5).
 *
 * The tab's distinctive rules are its fetch lifecycle and its "never silently
 * drop the saved value" rule, so those carry most of the assertions:
 *
 * - a saved list / status the provider no longer offers stays VISIBLE and
 *   selected — dropping it would save an empty value away and quietly
 *   un-configure a working board;
 * - the prerequisite hints, the loading copy, the empty-list copy and the
 *   stale-value copy are the vanilla strings, because they are what tell a user
 *   which prerequisite is missing;
 * - no fetch is posted until the prerequisites are met, and posting one is the
 *   hook's job (R11/R12), not a hand-rolled pending flag;
 * - the token flag is keychain state: setting or clearing it must never touch the
 *   draft, because the provider itself is chosen during first-time setup;
 * - leaving ClickUp clears every ClickUp-only key;
 * - the coherence rule (an unset `shipStatus` filled from the first entry, an
 *   unset `startStatus` from the one named "in progress") belongs to the REDUCER
 *   and must not be re-derived here (R-X4) — asserted through the draft.
 */
// @vitest-environment jsdom
import { act } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Manifest, TicketingConfig } from '../../../../manifest/types.js';
import { TICKET_PROVIDER_IDS } from '../../../../model/ticketProviders.js';
import { AnnouncerProvider } from '../primitives/LiveRegion.js';
import { SettingsAppProvider } from '../SettingsAppContext.js';
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

const cfgOf = (probe: () => AppProbeShape): Record<string, unknown> =>
  (probe().draft as { ticketing?: Record<string, unknown> }).ticketing ?? {};

describe('TicketingSection — the page', () => {
  it('gives the page a header and the board-connection block', () => {
    mountTicketing();
    expect(document.querySelector('#section-ticketing')).not.toBeNull();
    expect(document.querySelector('.page-title')?.textContent).toBe('Ticketing');
    expect(document.getElementById('clickupFields')).not.toBeNull();
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

  it('hides the ClickUp-only cards for a manual provider', () => {
    mountTicketing(stateWith({ provider: 'manual' }));
    expect(document.getElementById('searchCard')).toBeNull();
    expect(document.getElementById('advanceCards')).not.toBeNull();
  });

  it('shows the search card for ClickUp, defaulting ON', () => {
    mountTicketing(stateWith({ provider: 'clickup' }));
    expect(document.getElementById('searchCard')).not.toBeNull();
    expect(byLabel('Search tickets in the Add/Edit ticket page').checked).toBe(true);
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
  it('offers only the action that applies', () => {
    mountTicketing(stateWith({ provider: 'clickup' }, false));
    expect(document.querySelector('.status-pill')?.textContent).toContain('No token');
    expect(screen.getByRole('button', { name: 'Set token' })).toBeTruthy();
    expect(() => screen.getByRole('button', { name: 'Clear token' })).toThrow();
  });

  it('swaps to Clear once the host reports a token', () => {
    const { bridge, probe } = mountTicketing(stateWith({ provider: 'clickup' }, false));
    act(() => bridge.push({ type: 'token-state', configured: true }));
    expect(document.querySelector('.status-pill')?.textContent).toContain('Token set');
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
    expect(document.querySelector('.status-pill')?.textContent).toContain('No token');
  });

  it('ships the Clear control as secondary, not danger', () => {
    mountTicketing(stateWith({ provider: 'clickup' }, true));
    const button = screen.getByRole('button', { name: 'Clear token' });
    expect(button.className).toContain('k-btn--secondary');
    expect(button.className).not.toContain('k-btn--danger');
  });
});

describe('TicketingSection — leaving ClickUp clears what only ClickUp means', () => {
  it('drops the team, the advance rows and the search toggle', () => {
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
    expect(document.querySelector('#listHint, .field-hint')?.textContent).toContain(
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
    const reload = document.querySelector('[aria-label="Reload lists from ClickUp"]') as Element;
    expect(reload.getAttribute('aria-busy')).toBe('true');
    expect(hintText()).toContain('Loading lists…');
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
    expect(hintText()).toBe('');
  });

  it('keeps a saved list visible and selected when the provider no longer offers it', () => {
    const { bridge } = mountTicketing(stateWith({ provider: 'clickup', teamId: '9001', listId: 'L9' }));
    act(() => bridge.push({ type: 'ticket-lists', lists: [{ id: 'L1', name: 'Backlog', space: 'Core' }] }));
    const select = byLabel('List') as unknown as HTMLSelectElement;
    expect(Array.from(select.options).map((o) => o.value)).toEqual(['L9', 'L1']);
    expect(select.value).toBe('L9');
    expect(hintText()).toContain('"L9" is no longer in this workspace.');
  });

  it('says so when the workspace has no lists at all', () => {
    const { bridge } = mountTicketing(stateWith({ provider: 'clickup', teamId: '9001' }));
    act(() => bridge.push({ type: 'ticket-lists', lists: [] }));
    expect(hintText()).toBe('This workspace has no lists.');
    expect((byLabel('List') as unknown as HTMLSelectElement).disabled).toBe(true);
  });

  it('shows the host failure message inline and keeps the control locked', () => {
    const { bridge } = mountTicketing(stateWith({ provider: 'clickup', teamId: '9001' }));
    act(() => bridge.push({ type: 'ticket-lists-error', message: 'No token configured' }));
    expect(hintText()).toContain('No token configured');
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

describe('TicketingSection — the status fetch lifecycle and the coherence rule', () => {
  function onShip(): ReturnType<typeof mountTicketing> {
    return mountTicketing(
      stateWith({
        provider: 'clickup',
        teamId: '9001',
        listId: 'L1',
        advanceOnShip: true,
        shipStatus: 'Done',
      }),
    );
  }

  it('does not fetch until a list id AND a token exist', () => {
    const { bridge } = mountTicketing(stateWith({ provider: 'clickup', teamId: '9001' }));
    expect(bridge.all('fetch-ticket-statuses')).toHaveLength(0);
  });

  it('fills an unset ship status with the FIRST entry and start with "in progress"', () => {
    const { bridge, probe } = mountTicketing(
      stateWith({
        provider: 'clickup',
        teamId: '9001',
        listId: 'L1',
        advanceOnShip: true,
        advanceOnStart: true,
      }),
    );
    const reload = document.querySelector('[aria-label="Reload statuses for this list"]') as Element;
    fireEvent.click(reload);
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
    const reload = document.querySelector('[aria-label="Reload statuses for this list"]') as Element;
    fireEvent.click(reload);
    act(() => bridge.push({ type: 'ticket-statuses', statuses: ['open', 'Done', 'Blocked'] }));
    expect(cfgOf(probe)).toMatchObject({ shipStatus: 'Done', startStatus: 'Blocked' });
  });

  it('keeps a saved status the provider no longer lists, and says so', () => {
    const { bridge } = onShip();
    const reload = document.querySelector('[aria-label="Reload statuses for this list"]') as Element;
    fireEvent.click(reload);
    act(() => bridge.push({ type: 'ticket-statuses', statuses: ['open'] }));
    const select = byLabel('Status after ship') as unknown as HTMLSelectElement;
    expect(Array.from(select.options).map((o) => o.value)).toEqual(['Done', 'open']);
    expect(statusHint()).toContain('"Done" is no longer in this list.');
  });

  it('says so when the list has no statuses at all', () => {
    const { bridge } = onShip();
    const reload = document.querySelector('[aria-label="Reload statuses for this list"]') as Element;
    fireEvent.click(reload);
    act(() => bridge.push({ type: 'ticket-statuses', statuses: [] }));
    expect(statusHint()).toBe('This list has no statuses.');
    expect((byLabel('Status after ship') as unknown as HTMLSelectElement).disabled).toBe(true);
  });

  it('shows the failure inline and settles the fetch as a failure', () => {
    const { bridge } = onShip();
    const reload = document.querySelector('[aria-label="Reload statuses for this list"]') as Element;
    fireEvent.click(reload);
    act(() => bridge.push({ type: 'ticket-statuses-error', message: 'ClickUp said no' }));
    expect(statusHint()).toContain('ClickUp said no');
    const again = document.querySelector('[aria-label="Reload statuses for this list"]') as Element;
    expect(again.getAttribute('aria-busy')).toBeNull();
  });

  it('drops the status cache when the list changes', () => {
    const { bridge } = onShip();
    const reload = document.querySelector('[aria-label="Reload statuses for this list"]') as Element;
    fireEvent.click(reload);
    act(() => bridge.push({ type: 'ticket-statuses', statuses: ['open'] }));
    // Give the workspace a second list so the change below is a real pick.
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
    // No re-fetch on its own — the statuses belong to the OLD list — but the stale
    // options are gone, so a status from the old list cannot be saved into the
    // new one. The REDUCER drops them: only the draft's key moved, and the
    // fetches belong to the reducer.
    expect(bridge.all('fetch-ticket-statuses')).toHaveLength(1);
    // The row stays (the toggle is still on) and the SAVED status stays visible —
    // it is never silently dropped — but the fetched list belongs to the old list,
    // so it is gone and the control is locked until the new one is fetched.
    const select = byLabel('Status after ship') as unknown as HTMLSelectElement;
    expect(select.disabled).toBe(true);
    expect(Array.from(select.options).map((o) => o.value)).toEqual(['Done']);
    expect(statusHint()).toBe('');
  });
});

describe('TicketingSection — the two advance rows', () => {
  it('hides each status select until its toggle is on', () => {
    mountTicketing(stateWith({ provider: 'clickup', teamId: '9001', listId: 'L1' }));
    expect(document.getElementById('advanceStatusRow')).toBeNull();
    expect(document.getElementById('startAdvanceStatusRow')).toBeNull();
    fireEvent.click(byLabel('Set the ticket status when karst ships'));
    expect(document.getElementById('advanceStatusRow')).not.toBeNull();
    expect(document.getElementById('startAdvanceStatusRow')).toBeNull();
  });

  it('labels both reload controls identically, and both drive one fetch', () => {
    const { bridge } = mountTicketing(
      stateWith({
        provider: 'clickup',
        teamId: '9001',
        listId: 'L1',
        advanceOnShip: true,
        advanceOnStart: true,
      }),
    );
    const reloads = Array.from(
      document.querySelectorAll('[aria-label="Reload statuses for this list"]'),
    );
    expect(reloads).toHaveLength(2);
    fireEvent.click(reloads[1] as Element);
    expect(bridge.all('fetch-ticket-statuses')).toHaveLength(1);
    expect(bridge.last('fetch-ticket-statuses')).toMatchObject({ listId: 'L1', teamId: '9001' });
  });

  it('writes the picked status onto the draft', () => {
    const { bridge, probe } = mountTicketing(
      stateWith({ provider: 'clickup', teamId: '9001', listId: 'L1', advanceOnShip: true }),
    );
    const reload = document.querySelector('[aria-label="Reload statuses for this list"]') as Element;
    fireEvent.click(reload);
    act(() => bridge.push({ type: 'ticket-statuses', statuses: ['open', 'Done'] }));
    fireEvent.change(byLabel('Status after ship'), { target: { value: 'Done' } });
    expect(cfgOf(probe)).toMatchObject({ advanceOnShip: true, shipStatus: 'Done' });
  });
});

describe('TicketingSection — sub-task sync', () => {
  it('writes the picked mode onto the draft and drops it when leaving ClickUp', () => {
    const { probe } = mountTicketing(stateWith({ provider: 'clickup', teamId: '9001', listId: 'L1' }));
    fireEvent.change(byLabel('Sync sub-tasks to the provider'), { target: { value: 'link' } });
    expect(cfgOf(probe)).toMatchObject({ syncSubtasks: 'link' });
    fireEvent.click(document.querySelector('[data-value="manual"]') as Element);
    expect(cfgOf(probe)).not.toHaveProperty('syncSubtasks');
  });
});

/** The hint under the list row. */
function hintText(): string {
  return [...document.querySelectorAll('.field-hint')].map((n) => n.textContent ?? '').join(' | ');
}

/** The hint under the ship-status row. */
function statusHint(): string {
  return document.getElementById('advanceStatusRow')?.textContent?.includes('This list has no statuses.') ?? false
    ? 'This list has no statuses.'
    : (document.querySelector('#advanceStatusRow .field-hint')?.textContent ?? '');
}

/** Keeps the manifest import meaningful for the fixture's block shape. */
export type TicketingManifest = Pick<Manifest, 'ticketing'>;
