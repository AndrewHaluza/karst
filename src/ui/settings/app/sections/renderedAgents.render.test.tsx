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
 * Scoped to `[data-karst-settings-app="true"]`: `section-agents` still belongs to
 * the live VANILLA section until phase 4.
 */
// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import type { Manifest } from '../../../../manifest/types.js';
import { createTestBridge, type TestBridge } from '../testBridge.js';
import { buildSettingsState } from '../../state.js';
import type { SettingsAgentRow } from '../../state.js';
import { FIXTURE_MANIFEST } from '../testFixtures.js';
import { renderSettingsApp, type RenderedSettings } from '../renderSettingsApp.js';
import type { AppProbeShape } from './AppProbe.js';

let open: RenderedSettings | null = null;

afterEach(() => {
  open?.close();
  open = null;
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
  readonly bridge: TestBridge;
  probe(): AppProbeShape;
  last(type: string): Record<string, unknown> | undefined;
}

async function mountOnAgents(manifest: Manifest = MANIFEST): Promise<Mounted> {
  const bridge = createTestBridge();
  const view = await renderSettingsApp({ bridge });
  open = view;
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
  const probe = (): AppProbeShape => {
    const node = view.document.querySelector('[id="root"]')?.querySelector('[data-probe="app"]');
    if (!node) throw new Error('AppProbe is not mounted');
    return JSON.parse(node.getAttribute('data-state') ?? '{}') as AppProbeShape;
  };
  return {
    view,
    bridge,
    probe,
    last: (type: string) => bridge.last(type as never) as unknown as Record<string, unknown> | undefined,
  };
}

/** The React tab, scoped by the mount marker the parity sweep keys on. */
function tab(view: RenderedSettings): Element {
  const node = view.document.querySelector('[data-karst-settings-app="true"]');
  if (!node) throw new Error('the React settings mount is not rendered');
  return node;
}

function navMarker(view: RenderedSettings, section: string): Element | null {
  return view.document.querySelector(`[id="root"] [data-section="${section}"]`);
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

describe('rendered Agents tab — the roster and matrix mount', () => {
  it('renders the host roster and one row per process key', async () => {
    const { view } = await mountOnAgents();
    const mine = tab(view);
    expect(mine.textContent).toContain('review');
    expect(mine.textContent).toContain('tdd-one');
    expect(mine.querySelectorAll('[data-proc-key]').length).toBeGreaterThan(0);
  });
});

describe('rendered Agents tab — dirty marking (R26)', () => {
  it('marks only the Agents tab dirty on an assignment edit', async () => {
    const { view, probe } = await mountOnAgents();
    expect(probe().dirtySections).toEqual([]);
    await setField(view, 'proc-review-name', 'Snapshot');
    expect(probe().dirtySections).toEqual(['agents']);
    expect(navMarker(view, 'agents')?.className).toContain('has-changes');
    expect(navMarker(view, 'general')?.className).not.toContain('has-changes');
  });

  it('rolls Agents back alone on Discard', async () => {
    const { view, probe } = await mountOnAgents();
    await setField(view, 'proc-review-name', 'Snapshot');
    expect(probe().dirtySections).toEqual(['agents']);
    await view.click(buttonNamed(view.document.querySelector('[id="root"]') as Element, 'Discard'));
    expect(probe().dirtySections).toEqual([]);
  });
});

describe('rendered Agents tab — the tab-scoped Save carries the whole draft', () => {
  it('posts section agents and preserves the unrendered process key', async () => {
    const { view, last } = await mountOnAgents();
    await setField(view, 'proc-review-name', 'Snapshot');
    await view.click(buttonNamed(view.document.querySelector('[id="root"]') as Element, 'Save Agents'));

    const save = last('save');
    expect(save).toMatchObject({ type: 'save', section: 'agents' });
    const processes = (save?.manifest as Manifest | undefined)?.processes as
      | Record<string, Record<string, unknown>>
      | undefined;
    expect(processes?.review?.agentName).toBe('Snapshot');
    // The key this tab renders no control for still rides along: a rebuilt
    // `processes` map would drop it and the host would delete it from the file.
    expect(processes?.review?.inertKeyKarstNeverRenders).toBe('keep me');
  });
});

describe('rendered Agents tab — a state push re-renders the roster', () => {
  it('keeps an uncommitted assignment edit across an out-of-band write', async () => {
    const { view, probe } = await mountOnAgents();
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
    const draft = probe().draft as { host?: string; processes?: Record<string, Record<string, unknown>> };
    // The file's change to another tab is adopted…
    expect(draft.host).toBe('10.0.0.1');
    // …while the uncommitted Agents edit survives.
    expect(draft.processes?.review?.agentName).toBe('Snapshot');
  });
});
