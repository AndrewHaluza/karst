// @vitest-environment jsdom
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { fixtureMessages, resourcesRenderFixtures } from '../renderFixtures.js';
import { closeResourcesRealm, renderResourcesApp, type RenderedResources } from './renderResourcesApp.js';

afterAll(closeResourcesRealm);

const fixture = (scenario: string) => resourcesRenderFixtures().find((f) => f.scenario === scenario)!;

async function mount(scenario: string, hash = ''): Promise<RenderedResources> {
  const page = await renderResourcesApp({ hash });
  for (const m of fixtureMessages(fixture(scenario))) await page.receive(m);
  return page;
}

const tab = (page: RenderedResources, id: 'servers' | 'resources') => page.handle.query<HTMLButtonElement>(`#tab-${id}`)!;
const panel = (page: RenderedResources, id: 'servers' | 'resources') => page.handle.query<HTMLElement>(`#panel-${id}`)!;
const selected = (page: RenderedResources) =>
  page.handle.queryAll('[role=tab]').find((t) => t.getAttribute('aria-selected') === 'true')?.id;

describe('shell', () => {
  let page: RenderedResources;
  beforeEach(async () => {
    page = await renderResourcesApp();
  });

  it('asks the host for state exactly once on mount', () => {
    expect(page.all('request-state')).toHaveLength(1);
  });

  it('titles the page "Servers & resources" and renders both tabs in a labelled tablist', () => {
    expect(page.handle.query('h1')?.textContent).toBe('Servers & resources');
    expect(page.handle.queryAll('[role=tab]').map((t) => t.textContent)).toEqual(['Servers', 'Resources']);
    expect(page.handle.query('[role=tablist]')?.getAttribute('aria-label')).toBeTruthy();
  });

  it('opens on Resources when nothing asked for a tab (the historical default)', () => {
    expect(selected(page)).toBe('tab-resources');
    expect(panel(page, 'resources').hidden).toBe(false);
    expect(panel(page, 'servers').hidden).toBe(true);
  });

  it('wires each tab to its panel (aria-controls / aria-labelledby) and marks the regions', () => {
    for (const id of ['servers', 'resources'] as const) {
      expect(tab(page, id).getAttribute('aria-controls')).toBe(`panel-${id}`);
      expect(panel(page, id).getAttribute('aria-labelledby')).toBe(`tab-${id}`);
      expect(panel(page, id).getAttribute('role')).toBe('tabpanel');
      expect(panel(page, id).dataset.region).toBe(id);
    }
    expect(page.handle.query('[data-region=header]')).not.toBeNull();
  });

  it('roving tabindex: only the selected tab is in the tab order', () => {
    expect(tab(page, 'resources').tabIndex).toBe(0);
    expect(tab(page, 'servers').tabIndex).toBe(-1);
  });
});

describe('tab selection', () => {
  it('restores the tab from the hash on open (#servers)', async () => {
    const page = await renderResourcesApp({ hash: '#servers' });
    expect(selected(page)).toBe('tab-servers');
    expect(panel(page, 'servers').hidden).toBe(false);
  });

  it('ignores an unknown hash', async () => {
    const page = await renderResourcesApp({ hash: '#nonsense' });
    expect(selected(page)).toBe('tab-resources');
  });

  it('a click selects the tab, writes the hash, and persists it for a reload', async () => {
    const page = await renderResourcesApp();
    await page.click(tab(page, 'servers'));
    expect(selected(page)).toBe('tab-servers');
    expect(page.handle.window.location.hash).toBe('#servers');
    expect(page.handle.state).toEqual({ tab: 'servers' });
  });

  it('the host asking for a tab (karst.openServers) selects it, repeatably', async () => {
    const page = await renderResourcesApp();
    await page.receive({ type: 'show-tab', tab: 'servers' });
    expect(selected(page)).toBe('tab-servers');
    await page.click(tab(page, 'resources'));
    await page.receive({ type: 'show-tab', tab: 'servers' });
    expect(selected(page)).toBe('tab-servers');
  });

  it('Back (a hashchange) moves the selection and keeps the hash the source of truth', async () => {
    const page = await renderResourcesApp();
    await page.click(tab(page, 'servers'));
    page.handle.window.location.hash = '#resources';
    await page.settle();
    await page.settle();
    expect(selected(page)).toBe('tab-resources');
    expect(page.handle.window.location.hash).toBe('#resources');
  });

  it('keeps the selection when the page is resized', async () => {
    const page = await renderResourcesApp({ hash: '#servers' });
    page.handle.window.dispatchEvent(new page.handle.window.Event('resize'));
    await page.settle();
    expect(selected(page)).toBe('tab-servers');
  });

  it.each([
    ['ArrowRight', 'resources', 'servers'],
    ['ArrowLeft', 'servers', 'resources'],
    ['Home', 'resources', 'servers'],
    ['End', 'servers', 'resources'],
  ] as const)('%s from %s selects and focuses %s', async (key, from, to) => {
    const page = await renderResourcesApp({ hash: `#${from}` });
    page.handle.document.body.focus();
    await page.key(tab(page, from), key);
    expect(selected(page)).toBe(`tab-${to}`);
    expect(page.document.activeElement?.id).toBe(`tab-${to}`);
  });

  it('wraps: ArrowRight on the last tab goes to the first', async () => {
    const page = await renderResourcesApp({ hash: '#resources' });
    await page.key(tab(page, 'resources'), 'ArrowRight');
    expect(selected(page)).toBe('tab-servers');
  });

  it('ignores keys that are not tab navigation', async () => {
    const page = await renderResourcesApp({ hash: '#servers' });
    await page.key(tab(page, 'servers'), 'a');
    expect(selected(page)).toBe('tab-servers');
  });
});

describe('Refresh', () => {
  it('posts refresh with a request id, pending until the host answers', async () => {
    const page = await mount('busy');
    const btn = page.handle.queryAll<HTMLButtonElement>('button').find((b) => b.textContent === 'Refresh')!;
    await page.click(btn);
    const sent = page.last('refresh')!;
    expect(sent.requestId).toBeTruthy();
    expect(btn.getAttribute('aria-busy')).toBe('true');
    await page.answer(sent.requestId!, true);
    expect(btn.getAttribute('aria-busy')).toBeNull();
  });
});
