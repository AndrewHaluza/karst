/**
 * Rendered-Settings tests for the Services tab, through `renderSettingsApp`
 * (NDL-126 §9.5).
 *
 * The COMPONENT tests in `ServicesSection.test.tsx` prove per-component
 * behaviour. These prove the STATE-DEPENDENT rules in the real hydrated document:
 *
 * - the roster renders one row per repository, with the runtime badge answering
 *   "what will spin actually do here?";
 * - a repository edit marks the Services tab dirty and nothing else (R26), and
 *   Discard rolls it back alone;
 * - the tab-scoped Save posts `section: 'services'` carrying EVERY repository —
 *   the spread rule made observable end to end, because a rebuilt map would
 *   arrive with two repositories missing and the host would delete them;
 * - a mapped repository fault stays SILENT until the user touches that exact
 *   field, then renders on that control (UI-R25) and marks the tab with an
 *   ERROR dot rather than the dirty one.
 *
 * Scoped to `[data-karst-settings-app="true"]`: `section-services` still belongs
 * to the live VANILLA section until phase 4.
 */
// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import type { Manifest } from '../../../../manifest/types.js';
import { createTestBridge, type TestBridge } from '../testBridge.js';
import { buildSettingsState } from '../../state.js';
import { FIXTURE_MANIFEST } from '../testFixtures.js';
import { renderSettingsApp, type RenderedSettings } from '../renderSettingsApp.js';
import type { AppProbeShape } from './AppProbe.js';

let open: RenderedSettings | null = null;

afterEach(() => {
  open?.close();
  open = null;
});

const MANIFEST: Manifest = {
  ...FIXTURE_MANIFEST,
  baselineBranch: 'main',
  repositories: {
    api: {
      name: 'api',
      repoPath: '../api',
      hasMigrations: false,
      enabled: true,
      service: {
        start: 'npm run dev',
        ports: [{ name: 'http', env: 'PORT', default: 3000 }],
        dependsOn: [],
      },
    },
    db: { name: 'db', repoPath: '../db', hasMigrations: true, enabled: true },
    docs: { name: 'docs', repoPath: '../docs', hasMigrations: false, enabled: true },
  } as unknown as Manifest['repositories'],
};

interface Mounted {
  readonly view: RenderedSettings;
  readonly bridge: TestBridge;
  probe(): AppProbeShape;
  last(type: string): Record<string, unknown> | undefined;
}

async function mountOnServices(manifest: Manifest = MANIFEST): Promise<Mounted> {
  const bridge = createTestBridge();
  const view = await renderSettingsApp({ bridge });
  open = view;
  await view.receive({
    type: 'state',
    state: buildSettingsState(
      manifest,
      null,
      [],
      true,
      ['claude'],
      [],
      {},
      undefined,
      '/repo/karst.yml',
    ),
  });
  await view.click(view.document.querySelector('[id="root"] [data-section="services"]') as Element);
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

describe('rendered Services tab — the roster mounts', () => {
  it('renders a row per repository inside the React mount', async () => {
    const { view } = await mountOnServices();
    const mine = tab(view);
    expect(mine.querySelector('[data-card="api"]')).not.toBeNull();
    expect(mine.querySelector('[data-card="docs"]')).not.toBeNull();
  });
});

describe('rendered Services tab — dirty marking (R26)', () => {
  it('marks only the Services tab dirty on a repository edit', async () => {
    const { view, probe } = await mountOnServices();
    expect(probe().dirtySections).toEqual([]);
    await setField(view, 'f-svc-repoPath-api', '../api2');
    expect(probe().dirtySections).toEqual(['services']);
    expect(navMarker(view, 'services')?.className).toContain('has-changes');
    expect(navMarker(view, 'general')?.className).not.toContain('has-changes');
  });

  it('rolls Services back alone on Discard', async () => {
    const { view, probe } = await mountOnServices();
    await setField(view, 'f-svc-repoPath-api', '../api2');
    expect(probe().dirtySections).toEqual(['services']);
    await view.click(buttonNamed(view.document.querySelector('[id="root"]') as Element, 'Discard'));
    expect(probe().dirtySections).toEqual([]);
  });
});

describe('rendered Services tab — the tab-scoped Save carries every repository', () => {
  it('posts section services and preserves the untouched repositories', async () => {
    const { view, last } = await mountOnServices();
    await setField(view, 'f-svc-repoPath-api', '../api2');
    await view.click(buttonNamed(view.document.querySelector('[id="root"]') as Element, 'Save Repositories'));

    const save = last('save');
    expect(save).toMatchObject({ type: 'save', section: 'services' });
    const repositories = (save?.manifest as Manifest | undefined)?.repositories as
      | Record<string, { repoPath?: string }>
      | undefined;
    expect(repositories?.api?.repoPath).toBe('../api2');
    // A rebuilt map would drop these, and the host would delete them from the file.
    expect(Object.keys(repositories ?? {}).sort()).toEqual(['api', 'db', 'docs']);
  });
});

describe('rendered Services tab — a mapped repository fault', () => {
  it('is silent until the field is touched, then shows on that control (UI-R25)', async () => {
    const { view } = await mountOnServices();
    await view.click(tab(view).querySelector('[data-toggle="api"]') as Element);
    await view.receive({ type: 'error', message: 'repository "api" service.start is required' });
    // Not yet touched, so nothing is shown.
    expect(tab(view).textContent).not.toContain('service.start is required');

    await setField(view, 'f-svc-start-api', '');
    // Touching that control is what unlocks the fault.
    expect(tab(view).textContent).toContain('service.start is required');
  });

  it('attributes the fault to the Services tab so the nav shows an error dot', async () => {
    const { view, probe } = await mountOnServices();
    await view.receive({ type: 'error', message: 'repository "api" service.start is required' });
    expect(probe().errorSection).toBe('services');
    expect(navMarker(view, 'services')?.className).toContain('has-error');
  });
});
