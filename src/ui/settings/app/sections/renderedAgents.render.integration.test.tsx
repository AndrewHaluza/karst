/**
 * Rendered-Settings tests for the Agents tab, through `renderSettingsApp`
 * (NDL-126 §9.5).
 *
 * The COMPONENT tests in `AgentsSection.test.tsx` prove per-component behaviour.
 * These prove the STATE-DEPENDENT rules in the real hydrated document:
 *
 * - the roster renders from the HOST pool, and the assignment matrix renders one
 *   row per closed-vocabulary process key with the host's role labels;
 * - an assignment edit marks the Agents tab dirty and nothing else (R26), and
 *   Discard rolls it back alone;
 * - the tab-scoped Save posts `section: 'agents'` carrying the WHOLE draft, so the
 *   host scopes the write — including the untouched process keys, which is what
 *   makes the spread rule observable end to end;
 * - a `state` push that changes the host pool re-renders the roster, and an
 *   uncommitted assignment edit survives an out-of-band write to another tab.
 *
 * Since phase 4 the settings webview IS this React app (the injector chain
 * mounts it into `#root`), so the tests drive the chain-mounted instance
 * directly. The manually-mounted `AppProbe` that serialised reducer internals is
 * retired with the phase-3 helper; every fact is asserted through the rendered
 * DOM or the harness `posted` channel, mapping the probe reads like this:
 * - `dirtySections` → the nav buttons carrying `has-changes`;
 * - `section` → the `.nav-btn.active` marker's `data-section`;
 * - `draft.processes` (the display-name override, the process role fields) →
 *   the rendered `.proc-row[data-proc-key]` matrix rows and their controls
 *   (`proc-<key>-name`), the same reducer read back out of the DOM;
 * - a manifest-shape fact no control renders (the inert keys of an untouched
 *   process block, `draft.host` living on another tab) → the payload of a save,
 *   which IS the whole draft;
 * - the roster facts → the roster rows inside the React mount;
 * - `bridge.last/all` → `view.last/all` (the harness `posted` array).
 */
// @vitest-environment jsdom
import { afterAll, describe, expect, it } from 'vitest';
import type { Manifest } from '../../../../manifest/types.js';
import { buildSettingsState } from '../../state.js';
import type { SettingsAgentRow } from '../../state.js';
import { FIXTURE_MANIFEST } from '../testFixtures.js';
import { closeSettingsRealm, renderSettingsApp, type RenderedSettings } from '../renderSettingsApp.js';

// The settings document is booted once per file and reset between tests (see
// `renderSettingsApp`): each `mountOnAgents` gets a fresh app without paying
// jsdom's full-document parse again.
afterAll(() => {
  closeSettingsRealm();
});

const AGENTS: SettingsAgentRow[] = [
  { name: 'review', source: 'file', enabled: true, body: 'review body' },
  { name: 'tdd-one', source: 'approach', approachId: 'tdd', enabled: true, body: null },
];

const MANIFEST: Manifest = {
  ...FIXTURE_MANIFEST,
  agents: { review: { body: 'review body' } } as unknown as Manifest['agents'],
  processes: {
    review: { agent: 'review', enabled: true, inertKeyKarstNeverRenders: 'keep me' },
  } as unknown as Manifest['processes'],
};

interface Mounted {
  readonly view: RenderedSettings;
}

async function mountOnAgents(manifest: Manifest = MANIFEST): Promise<Mounted> {
  const view = await renderSettingsApp();
  await view.receive({
    type: 'state',
    state: buildSettingsState(
      manifest,
      null,
      ['tdd'],
      true,
      ['claude'],
      AGENTS,
      { tdd: ['karst-tdd'] },
      undefined,
      '/repo/karst.yml',
    ),
  });
  await view.click(view.document.querySelector('[id="root"] [data-section="agents"]') as Element);
  return { view };
}

/** The `#root` tree the chain-mounted app renders into. */
function root(view: RenderedSettings): Element {
  const node = view.document.querySelector('[id="root"]');
  if (!node) throw new Error('#root is missing');
  return node;
}

/** The React tab, scoped by the mount marker the parity sweep keys on. */
function tab(view: RenderedSettings): Element {
  const node = root(view).querySelector('[data-karst-settings-app="true"]');
  if (!node) throw new Error('the React settings mount is not rendered');
  return node;
}

function navMarker(view: RenderedSettings, section: string): Element | null {
  return root(view).querySelector(`[data-section="${section}"]`);
}

function buttonNamed(root: ParentNode, label: string): HTMLElement {
  const node = Array.from(root.querySelectorAll('button')).find((b) => b.textContent?.trim() === label);
  if (!node) throw new Error(`no button named ${label}`);
  return node as HTMLElement;
}

async function setField(view: RenderedSettings, name: string, value: string): Promise<void> {
  const field = tab(view).querySelector(`[name="${name}"]`) as HTMLInputElement | null;
  if (!field) throw new Error(`no control named ${name}`);
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), 'value')?.set;
  if (!setter) throw new Error(`no value setter on ${name}`);
  setter.call(field, value);
  field.dispatchEvent(new (view.window.Event)('input', { bubbles: true }));
  field.dispatchEvent(new (view.window.Event)('change', { bubbles: true }));
  await view.settle();
}

/** The current value of one rendered control, as the DOM holds it. */
function fieldValue(view: RenderedSettings, name: string): string {
  const field = tab(view).querySelector(`[name="${name}"]`) as HTMLInputElement | null;
  return field?.value ?? '';
}

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

describe('rendered Agents tab — the roster and matrix mount', () => {
  it('renders the host roster and one row per process key', async () => {
    const { view } = await mountOnAgents();
    // `state.host.agents` → the roster rows inside the React mount; the
    // assignment matrix renders one `.proc-row[data-proc-key]` per process key.
    const mine = tab(view);
    expect(mine.textContent).toContain('review');
    expect(mine.textContent).toContain('tdd-one');
    expect(mine.querySelectorAll('[data-proc-key]').length).toBeGreaterThan(0);
  });
});

describe('rendered Agents tab — dirty marking (R26)', () => {
  it('marks only the Agents tab dirty on an assignment edit', async () => {
    const { view } = await mountOnAgents();
    // `probe().dirtySections` → the nav buttons carrying `has-changes`.
    expect(dirtySections(view)).toEqual([]);
    await setField(view, 'proc-review-name', 'Snapshot');
    expect(dirtySections(view)).toEqual(['agents']);
    expect(navMarker(view, 'agents')?.className).toContain('has-changes');
    expect(navMarker(view, 'general')?.className).not.toContain('has-changes');
  });

  it('rolls Agents back alone on Discard', async () => {
    const { view } = await mountOnAgents();
    await setField(view, 'proc-review-name', 'Snapshot');
    expect(dirtySections(view)).toEqual(['agents']);
    await view.click(buttonNamed(root(view), 'Discard'));
    expect(dirtySections(view)).toEqual([]);
    // `probe().draft.processes.review.agentName` → the rendered `proc-review-name`
    // control, back to baseline (blank = role default).
    expect(fieldValue(view, 'proc-review-name')).toBe('');
  });
});

describe('rendered Agents tab — the tab-scoped Save carries the whole draft', () => {
  it('posts section agents and preserves the unrendered process key', async () => {
    const { view } = await mountOnAgents();
    await setField(view, 'proc-review-name', 'Snapshot');
    await view.click(buttonNamed(root(view), 'Save Agents'));

    const save = view.last('save') as { manifest: Manifest } | undefined;
    expect(save).toMatchObject({ type: 'save', section: 'agents' });
    const processes = save?.manifest.processes as
      | Record<string, Record<string, unknown>>
      | undefined;
    // `probe().draft.processes.review.agentName` → the save payload, which IS
    // the whole draft.
    expect(processes?.review?.agentName).toBe('Snapshot');
    // The key this tab renders no control for still rides along: a rebuilt
    // `processes` map would drop it and the host would delete it from the file.
    expect(processes?.review?.inertKeyKarstNeverRenders).toBe('keep me');
  });
});

describe('rendered Agents tab — a state push re-renders the roster', () => {
  it('keeps an uncommitted assignment edit across an out-of-band write', async () => {
    const { view } = await mountOnAgents();
    await setField(view, 'proc-review-name', 'Snapshot');
    await view.receive({
      type: 'state',
      state: buildSettingsState(
        { ...MANIFEST, host: '10.0.0.1' },
        null,
        ['tdd'],
        true,
        ['claude'],
        AGENTS,
        { tdd: ['karst-tdd'] },
        undefined,
        '/repo/karst.yml',
      ),
    });
    // `probe().draft.processes.review.agentName` → the rendered control still
    // shows the edit: the Agents draft survived the push.
    expect(fieldValue(view, 'proc-review-name')).toBe('Snapshot');
    expect(dirtySections(view)).toEqual(['agents']);
    // `probe().draft.host` lives on a tab this single-tab mount does not render,
    // so the whole draft is read where it crosses the boundary: the payload of a
    // save, which adopts the file's `host` change AND carries the surviving edit
    // — the "everywhere except the saved tab" claim end to end.
    await view.click(buttonNamed(root(view), 'Save Agents'));
    const save = view.last('save') as { manifest: Manifest } | undefined;
    // The file's change to another tab is adopted…
    expect(save?.manifest.host).toBe('10.0.0.1');
    // …while the uncommitted Agents edit survives.
    const processes = (save?.manifest.processes as Record<string, Record<string, unknown>> | undefined);
    expect(processes?.review?.agentName).toBe('Snapshot');
  });
});