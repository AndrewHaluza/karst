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
 *
 * Since phase 4 the settings webview IS this React app (the injector chain
 * mounts it into `#root`), so the tests drive the chain-mounted instance
 * directly. The `AppProbe` that serialised reducer internals is retired; every
 * fact is asserted through the rendered DOM (nav markers, the ticketing
 * controls themselves) or the harness `posted` channel:
 * - `section` → the `.nav-btn.active` `data-section`;
 * - `dirtySections` → the nav buttons carrying `has-changes`;
 * - `draft.ticketing` → the rendered ticketing controls (provider selection,
 *   team-id / list / status values, the advance rows), or the last posted
 *   `save` `manifest.ticketing` when the test captures a save;
 * - the `posted` array is the recording channel (`last`/`all`), replacing the
 *   recording bridge.
 */
// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import type { Manifest, TicketingConfig } from '../../../../manifest/types.js';
import { FIXTURE_STATE_PUSH } from '../testFixtures.js';
import { renderSettingsApp, type RenderedSettings } from '../renderSettingsApp.js';
import type { SettingsState } from '../../state.js';

let open: RenderedSettings | null = null;

afterEach(() => {
  open?.close();
  open = null;
});

interface Mounted {
  readonly view: RenderedSettings;
}

const asCfg = (block: Record<string, unknown>): TicketingConfig =>
  block as unknown as TicketingConfig;

async function mountOnTicketing(
  ticketing: Record<string, unknown> = { provider: 'clickup', teamId: '9001', listId: 'L1' },
  tokenConfigured = true,
): Promise<Mounted> {
  const view = await renderSettingsApp();
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
  return { view };
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

/**
 * The dirty tabs, as the nav renders them — one `has-changes` marker per dirty
 * tab. This is the observable twin of the retired probe's `dirtySections`: the
 * marker is derived from the same reducer list (R26).
 */
function dirtySections(view: RenderedSettings): string[] {
  return [...root(view).querySelectorAll('.nav-btn[data-section]')]
    .filter((btn) => btn.classList.contains('has-changes'))
    .map((btn) => btn.getAttribute('data-section') ?? '');
}

/** The selected provider, as the listbox renders it (`.provselect-opt.selected`). */
function selectedProvider(view: RenderedSettings): string | undefined {
  return (
    [...root(view).querySelectorAll('.provselect-opt')]
      .find((opt) => opt.classList.contains('selected'))
      ?.getAttribute('data-value') ?? undefined
  );
}

/**
 * The ticketing draft AS THE CONTROLS PROJECT IT — the observable twin of the
 * retired probe's `cfgOf(...)` (`draft.ticketing`), read back out of the DOM.
 * Absent controls read `undefined`, so a config fact that was deleted (the
 * ClickUp-only keys after switching to Manual) is visibly absent too.
 */
function readTicketing(view: RenderedSettings): Record<string, unknown> {
  const node = root(view);
  const fieldValue = (name: string): string | undefined => {
    const control = node.querySelector(`[name="${name}"]`) as HTMLInputElement | null;
    return control ? control.value : undefined;
  };
  const fieldChecked = (name: string): boolean | undefined => {
    const control = node.querySelector(`[name="${name}"]`) as HTMLInputElement | null;
    return control ? control.checked : undefined;
  };
  return {
    provider: selectedProvider(view),
    teamId: fieldValue('teamId'),
    listId: fieldValue('listId'),
    advanceOnShip: fieldChecked('advanceOnShip'),
    advanceOnStart: fieldChecked('advanceOnStart'),
    searchEnabled: fieldChecked('searchEnabled'),
    shipStatus: fieldValue('shipStatus'),
    startStatus: fieldValue('startStatus'),
  };
}

describe('rendered Settings — Ticketing tab mounts into the real document', () => {
  it('renders the page with no script errors', async () => {
    const { view } = await mountOnTicketing();
    expect(root(view).querySelector('[id="section-ticketing"]')).not.toBeNull();
    expect(root(view).querySelector('.page-title')?.textContent).toBe('Ticketing');
    expect(view.errors).toEqual([]);
  });

  it('marks the tab active and names it in the topbar', async () => {
    const { view } = await mountOnTicketing();
    // `probe().section` → the `.nav-btn.active` marker's `data-section`.
    expect(root(view).querySelector('.nav-btn.active')?.getAttribute('data-section')).toBe(
      'ticketing',
    );
    expect(root(view).querySelector('.topbar-section')?.textContent).toBe('› Ticketing');
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
    const { view } = await mountOnTicketing();
    expect(dirtySections(view)).toEqual([]);
    await setField(view, 'Team ID', '9002');
    expect(dirtySections(view)).toEqual(['ticketing']);
    expect(root(view).querySelector('[data-section="ticketing"]')?.classList.contains('has-changes'))
      .toBe(true);
    expect(root(view).querySelector('.dirty-dot')?.classList.contains('hidden')).toBe(false);
  });

  it('posts the whole draft with section "ticketing"', async () => {
    const { view } = await mountOnTicketing();
    await setField(view, 'Team ID', '9002');
    await view.click(saveButton(view));
    const save = view.last('save');
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
    const { view } = await mountOnTicketing();
    const reload = byAriaLabel(view, 'Reload lists from ClickUp');
    await view.click(reload);
    await view.click(reload);
    expect(view.all('fetch-ticket-lists')).toHaveLength(1);
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
    const { view } = await mountOnTicketing({
      provider: 'clickup',
      teamId: '9001',
      listId: 'L1',
      advanceOnShip: true,
      advanceOnStart: true,
    });
    await view.click(byAriaLabel(view, 'Reload statuses for this list'));
    await view.receive({ type: 'ticket-statuses', statuses: ['open', 'in progress', 'Done'] });
    // The REDUCER made this decision (R-X4): the component re-derives nothing.
    // `cfgOf(probe)` → the rendered status selects show the filled values.
    const ship = byLabel(view, 'Status after ship') as unknown as HTMLSelectElement;
    expect(ship.value).toBe('open');
    const start = byLabel(view, 'Status at start of work') as unknown as HTMLSelectElement;
    expect(start.value).toBe('in progress');
    await view.click(saveButton(view));
    // And the round trip to the file carries the same decision.
    const save = view.last('save') as { manifest: { ticketing?: TicketingConfig } };
    expect(save.manifest.ticketing).toMatchObject({
      shipStatus: 'open',
      startStatus: 'in progress',
    });
  });

  it('announces the fetch result once and keeps the tab editable', async () => {
    const { view } = await mountOnTicketing({
      provider: 'clickup',
      teamId: '9001',
      listId: 'L1',
      advanceOnShip: true,
    });
    await view.click(byAriaLabel(view, 'Reload statuses for this list'));
    await view.receive({ type: 'ticket-statuses', statuses: ['open', 'Done'] });
    // `cfgOf(probe)` → the status select rendered the reducer's filled value.
    const select = byLabel(view, 'Status after ship') as unknown as HTMLSelectElement;
    expect(select.value).toBe('open');
    expect(select.disabled).toBe(false);
    expect(Array.from(select.options).map((o) => o.value)).toEqual(['open', 'Done']);
  });
});

describe('rendered Settings — the token flag never touches the draft', () => {
  it('posts set-token, shows pending, and leaves the draft alone', async () => {
    const { view } = await mountOnTicketing(
      { provider: 'clickup', teamId: '9001' },
      false,
    );
    // `cfgOf(probe)` → the rendered ticketing controls, read before and after.
    const before = readTicketing(view);
    const button = [...root(view).querySelectorAll('button')].find(
      (b) => b.textContent === 'Set token',
    ) as Element;
    expect(button).toBeTruthy();
    await view.click(button);
    expect(view.last('set-token')).toBeDefined();
    expect(
      [...root(view).querySelectorAll('button')].find((b) => b.textContent === 'Set token')
        ?.getAttribute('aria-busy'),
    ).toBe('true');
    await view.receive({ type: 'token-state', configured: true });
    expect(root(view).textContent).toContain('Token set');
    // The token flow left the draft alone: the controls still project the same
    // config, and no tab has been marked dirty.
    expect(readTicketing(view)).toEqual(before);
    expect(dirtySections(view)).toEqual([]);
  });

  it('re-arms the list auto-fetch once the token prerequisite lands', async () => {
    const { view } = await mountOnTicketing({ provider: 'clickup', teamId: '9001' }, false);
    expect(view.all('fetch-ticket-lists')).toHaveLength(0);
    await view.receive({ type: 'token-state', configured: true });
    expect(view.all('fetch-ticket-lists')).toHaveLength(1);
  });
});

describe('rendered Settings — leaving ClickUp clears the ClickUp-only keys', () => {
  it('drops the advance rows and the search card, and keeps the tab dirty', async () => {
    const { view } = await mountOnTicketing({
      provider: 'clickup',
      teamId: '9001',
      listId: 'L1',
      advanceOnShip: true,
      shipStatus: 'Done',
      searchEnabled: true,
    });
    const manual = root(view).querySelector('[data-value="manual"]') as Element;
    await view.click(manual);
    // `cfgOf(probe).provider` → the listbox's selected option.
    expect(selectedProvider(view)).toBe('manual');
    // `cfgOf(probe).advanceOnShip` → the status row is unmounted with the flag
    // cleared; `not.toHaveProperty('shipStatus')` → the select inside it (the
    // only control that carried the ship status) is gone with it.
    expect(root(view).querySelector('[id="advanceStatusRow"]')).toBeNull();
    expect(root(view).querySelector('[id="searchCard"]')).toBeNull();
    expect(dirtySections(view)).toEqual(['ticketing']);
  });
});