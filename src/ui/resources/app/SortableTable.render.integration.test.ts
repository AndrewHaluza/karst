// @vitest-environment jsdom
import { afterAll, describe, expect, it } from 'vitest';
import { fixtureMessages, resourcesRenderFixtures } from '../renderFixtures.js';
import { closeResourcesRealm, renderResourcesApp, type RenderedResources } from './renderResourcesApp.js';

afterAll(closeResourcesRealm);

const fixture = (scenario: string) => resourcesRenderFixtures().find((f) => f.scenario === scenario)!;

async function mount(scenario: string): Promise<RenderedResources> {
  const page = await renderResourcesApp({ hash: '#resources' });
  for (const m of fixtureMessages(fixture(scenario))) await page.receive(m);
  return page;
}

describe('SortableTable in the Resources tab (RS-11, RS-21)', () => {
  it('gives every header button the thsort class so it inherits the th', async () => {
    const page = await mount('unattributed');
    const buttons = page.handle.queryAll('#panel-resources #unkHead th button');
    expect(buttons.length).toBeGreaterThan(0);
    expect(buttons.every((b) => b.classList.contains('thsort'))).toBe(true);
  });

  it('labels every cell with its column for the tight card layout', async () => {
    const page = await mount('unattributed');
    const tds = page.handle.queryAll('#panel-resources #unknownBody tr:first-child td');
    expect(tds.map((td) => td.getAttribute('data-label'))).toEqual(['PID', 'Command', 'CPU', 'RSS', 'Procs']);
  });

  it('starts a numeric column descending and a text column ascending', async () => {
    const page = await mount('unattributed');
    const ths = page.handle.queryAll('#panel-resources #unkHead th');
    const pid = ths.find((th) => th.textContent?.includes('PID'))!;
    await page.click(pid.querySelector('button')!);
    expect(pid.getAttribute('aria-sort')).toBe('descending');
    const cmd = ths.find((th) => th.textContent?.includes('Command'))!;
    await page.click(cmd.querySelector('button')!);
    expect(cmd.getAttribute('aria-sort')).toBe('ascending');
  });
});
