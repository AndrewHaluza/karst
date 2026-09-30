/**
 * Rendered-Settings tests for the Ticketing tab, through `renderWebviewReady`
 * (NDL-126 §9.5).
 *
 * The COMPONENT tests in `TicketingSection.test.tsx` prove per-component
 * behaviour. These prove the STATE-DEPENDENT rules in the real hydrated
 * document:
 *
 * - the tab's edits drive the Ticketing nav marker and the dirty dot (R26);
 * - tab-scoped Save posts the whole draft with `section: 'ticketing'`;
 * - the two ClickUp fetches enter pending on activation, are exposed as
 *   `aria-busy` (R11, R26), refuse a second activation (R12), and settle on
 *   their OWN replies rather than on `action-result` (R13) — the failure
 *   belongs inline next to the control, not only in a toast;
 * - the reducer's coherence rule reaches the draft and survives the round trip
 *   to the file (R-X4);
 * - a fetch pending window keeps the topbar Save's own lifecycle separate from
 *   the fetch's, so a re-render cannot confuse the two (R17, R18).
 */
// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import type { Manifest, TicketingConfig } from '../../../../manifest/types.js';
import { FIXTURE_STATE_PUSH } from '../testFixtures.js';
import { createTestBridge, type TestBridge } from '../testBridge.js';
import { renderSettingsApp, type RenderedSettings } from '../renderSettingsApp.js';
import type { SettingsState } from '../../state.js';
import type { AppProbeShape } from './AppProbe.js';

let open: RenderedSettings | null = null;

afterEach(() => {
  open?.close();
  open = null;
});

interface Mounted {
  readonly view: RenderedSettings;
  readonly bridge: TestBridge;
  probe(): AppProbeShape;
}

const asCfg = (block: Record<string, unknown>): TicketingConfig =>
  block as unknown as TicketingConfig;

async function mountOnTicketing(
  ticketing: Record<string, unknown> = { provider: 'clickup', teamId: '9001', listId: 'L1' },
  tokenConfigured = true,
): Promise<Mounted> {
  const bridge = createTestBridge();
  const view = await renderSettingsApp({ bridge });
  open = view;
  const state: SettingsState = {
    ...FIXTURE_STATE_PUSH,
    tokenConfigured,
    manifest: { ...FIXTURE_STATE_PUSH.manifest, ticketing: asCfg(ticketing) },
  };
  await view.receive({ type: 'state', state });
  await view.click(
    view.document.querySelector('[id="root"] [data-section="ticketing"]') as Element,
  );
  return {
    view,
    bridge,
    probe: () => {
      const node = view.document
        .querySelector('[id="root"]')
        ?.querySelector('[data-probe="app"]');
      if (!node) throw new Error('AppProbe is not mounted');
      return JSON.parse(node.getAttribute('data-state') ?? '{}') as AppProbeShape;
    },
  };
}

function root(view: RenderedSettings): Element {
  const node = view.document.querySelector('[id="root"]');
  if (!node) throw new Error('#root is missing');
  return node;
}

function saveButton(view: RenderedSettings): Element {
  const node = root(view).querySelector('button.k-btn--primary');
  if (!node) throw new Error('Save is not rendered');
  return node;
}

function byLabel(view: RenderedSettings, label: string): HTMLInputElement {
  const control = [...root(view).querySelectorAll('input, select, textarea')].find((el) => {
    const id = el.getAttribute('id');
    if (!id) return false;
    return view.document.querySelector(`label[for="${id}"]`)?.textContent?.trim() === label;
  });
  if (!control) throw new Error(`no control labelled ${label}`);
  return control as HTMLInputElement;
}

async function setField(
  view: RenderedSettings,
  label: string,
  value: string,
): Promise<void> {
  const field = byLabel(view, label);
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), 'value')?.set;
  if (!setter) throw new Error(`no value setter on the control labelled ${label}`);
  setter.call(field, value);
  field.dispatchEvent(new (view.window.Event)('input', { bubbles: true }));
  field.dispatchEvent(new (view.window.Event)('change', { bubbles: true }));
  await view.settle();
}

const byAriaLabel = (view: RenderedSettings, label: string): Element => {
  const node = root(view).querySelector(`[aria-label="${label}"]`);
  if (!node) throw new Error(`no control labelled ${label}`);
  return node;
};

const cfgOf = (probe: () => AppProbeShape): Record<string, unknown> =>
  (probe().draft as { ticketing?: Record<string, unknown> }).ticketing ?? {};

describe('rendered Settings — Ticketing tab mounts into the real document', () => {
  it('renders the page with no script errors', async () => {
    const { view } = await mountOnTicketing();
    expect(root(view).querySelector('[id="section-ticketing"]')).not.toBeNull();
    expect(root(view).querySelector('.page-title')?.textContent).toBe('Ticketing');
    expect(view.errors).toEqual([]);
  });

  it('marks the tab active and names it in the topbar', async () => {
    const { view, probe } = await mountOnTicketing();
    expect(root(view).querySelector('.nav-btn.active')?.getAttribute('data-section')).toBe(
      'ticketing',
    );
    expect(root(view).querySelector('.topbar-section')?.textContent).toBe('› Ticketing');
    expect(probe().section).toBe('ticketing');
  });

  it('renders the provider trigger through the shared runtime (R-X3)', async () => {
    const { view } = await mountOnTicketing();
    const trigger = byAriaLabel(view, 'Ticketing provider');
    expect(trigger.getAttribute('aria-haspopup')).toBe('listbox');
    // `aria-expanded` is derived from state, never written imperatively (R26).
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
  });
});

describe('rendered Settings — a ticketing edit drives the dirty markers (R26)', () => {
  it('lights the nav marker and Save once a field changes', async () => {
    const { view, probe } = await mountOnTicketing();
    expect(probe().dirtySections).toEqual([]);
    await setField(view, 'Team ID', '9002');
    expect(probe().dirtySections).toEqual(['ticketing']);
    expect(root(view).querySelector('[data-section="ticketing"]')?.classList.contains('has-changes'))
      .toBe(true);
    expect(root(view).querySelector('.dirty-dot')?.classList.contains('hidden')).toBe(false);
  });

  it('posts the whole draft with section "ticketing"', async () => {
    const { view, bridge } = await mountOnTicketing();
    await setField(view, 'Team ID', '9002');
    await view.click(saveButton(view));
    const save = bridge.last('save');
    expect(save).toMatchObject({ type: 'save', section: 'ticketing' });
    const manifest = (save as { manifest: Partial<Manifest> }).manifest;
    expect(manifest.ticketing).toMatchObject({ provider: 'clickup', teamId: '9002' });
  });
});

describe('rendered Settings — the list fetch settles on its own reply (R11–R13)', () => {
  it('enters pending on activation and exposes aria-busy', async () => {
    const { view } = await mountOnTicketing();
    const reload = byAriaLabel(view, 'Reload lists from ClickUp');
    expect(reload.getAttribute('aria-busy')).toBe('true');
    await view.click(reload);
    expect(reload.getAttribute('aria-busy')).toBe('true');
  });

  it('refuses a second activation while in flight (R12)', async () => {
    const { view, bridge } = await mountOnTicketing();
    const reload = byAriaLabel(view, 'Reload lists from ClickUp');
    await view.click(reload);
    await view.click(reload);
    expect(bridge.all('fetch-ticket-lists')).toHaveLength(1);
  });

  it('does NOT settle on action-result — these fetches have their own replies', async () => {
    const { view } = await mountOnTicketing();
    const reload = byAriaLabel(view, 'Reload lists from ClickUp');
    const id = view.posted.find((m) => m.type === 'fetch-ticket-lists')?.requestId;
    await view.receive({ type: 'action-result', requestId: id as string, ok: true });
    expect(reload.getAttribute('aria-busy')).toBe('true');
    await view.receive({ type: 'ticket-lists', lists: [] });
    expect(reload.getAttribute('aria-busy')).toBeNull();
  });

  it('shows the failure inline and settles as a failure', async () => {
    const { view } = await mountOnTicketing();
    const reload = byAriaLabel(view, 'Reload lists from ClickUp');
    await view.click(reload);
    await view.receive({ type: 'ticket-lists-error', message: 'Workspace unreadable' });
    expect(byAriaLabel(view, 'Reload lists from ClickUp').getAttribute('aria-busy')).toBeNull();
    expect(root(view).textContent).toContain('Workspace unreadable');
    // The terminal result is announced through the ONE live region (R27).
    expect(root(view).querySelectorAll('.k-live-region')).toHaveLength(1);
    expect(root(view).querySelector('.k-live-region')?.textContent).toContain(
      'Workspace unreadable',
    );
  });

  it('keeps a saved list selected once the provider answers', async () => {
    const { view } = await mountOnTicketing();
    await view.receive({
      type: 'ticket-lists',
      lists: [{ id: 'L1', name: 'Backlog', space: 'Core' }],
    });
    const select = byLabel(view, 'List') as unknown as HTMLSelectElement;
    expect(select.value).toBe('L1');
    expect(select.disabled).toBe(false);
  });
});

describe('rendered Settings — the reducer coherence rule reaches the file', () => {
  it('fills an unset ship status from the first entry and start from "in progress"', async () => {
    const { view, bridge, probe } = await mountOnTicketing({
      provider: 'clickup',
      teamId: '9001',
      listId: 'L1',
      advanceOnShip: true,
      advanceOnStart: true,
    });
    await view.click(byAriaLabel(view, 'Reload statuses for this list'));
    await view.receive({ type: 'ticket-statuses', statuses: ['open', 'in progress', 'Done'] });
    // The REDUCER made this decision (R-X4): the component re-derives nothing.
    expect(cfgOf(probe)).toMatchObject({ shipStatus: 'open', startStatus: 'in progress' });
    await view.click(saveButton(view));
    const save = bridge.last('save') as { manifest: { ticketing?: TicketingConfig } };
    expect(save.manifest.ticketing).toMatchObject({
      shipStatus: 'open',
      startStatus: 'in progress',
    });
  });

  it('announces the fetch result once and keeps the tab editable', async () => {
    const { view, probe } = await mountOnTicketing({
      provider: 'clickup',
      teamId: '9001',
      listId: 'L1',
      advanceOnShip: true,
    });
    await view.click(byAriaLabel(view, 'Reload statuses for this list'));
    await view.receive({ type: 'ticket-statuses', statuses: ['open', 'Done'] });
    expect(cfgOf(probe)).toMatchObject({ shipStatus: 'open' });
    const select = byLabel(view, 'Status after ship') as unknown as HTMLSelectElement;
    expect(select.disabled).toBe(false);
    expect(Array.from(select.options).map((o) => o.value)).toEqual(['open', 'Done']);
  });
});

describe('rendered Settings — the token flag never touches the draft', () => {
  it('posts set-token, shows pending, and leaves the draft alone', async () => {
    const { view, bridge, probe } = await mountOnTicketing(
      { provider: 'clickup', teamId: '9001' },
      false,
    );
    const before = cfgOf(probe);
    const button = [...root(view).querySelectorAll('button')].find(
      (b) => b.textContent === 'Set token',
    ) as Element;
    expect(button).toBeTruthy();
    await view.click(button);
    expect(bridge.last('set-token')).toBeDefined();
    expect(
      [...root(view).querySelectorAll('button')].find((b) => b.textContent === 'Set token')
        ?.getAttribute('aria-busy'),
    ).toBe('true');
    await view.receive({ type: 'token-state', configured: true });
    expect(root(view).textContent).toContain('Token set');
    expect(cfgOf(probe)).toEqual(before);
    expect(probe().dirtySections).toEqual([]);
  });

  it('re-arms the list auto-fetch once the token prerequisite lands', async () => {
    const { view, bridge } = await mountOnTicketing({ provider: 'clickup', teamId: '9001' }, false);
    expect(bridge.all('fetch-ticket-lists')).toHaveLength(0);
    await view.receive({ type: 'token-state', configured: true });
    expect(bridge.all('fetch-ticket-lists')).toHaveLength(1);
  });
});

describe('rendered Settings — leaving ClickUp clears the ClickUp-only keys', () => {
  it('drops the advance rows and the search card, and keeps the tab dirty', async () => {
    const { view, probe } = await mountOnTicketing({
      provider: 'clickup',
      teamId: '9001',
      listId: 'L1',
      advanceOnShip: true,
      shipStatus: 'Done',
      searchEnabled: true,
    });
    const manual = root(view).querySelector('[data-value="manual"]') as Element;
    await view.click(manual);
    expect(cfgOf(probe)).toMatchObject({ provider: 'manual', advanceOnShip: false });
    expect(cfgOf(probe)).not.toHaveProperty('shipStatus');
    expect(root(view).querySelector('[id="searchCard"]')).toBeNull();
    expect(probe().dirtySections).toEqual(['ticketing']);
  });
});
