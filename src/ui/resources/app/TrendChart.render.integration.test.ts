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

describe('TrendChart in the Resources tab (RS-8, RS-9)', () => {
  it('keeps the y labels and the time ticks inside the plot band, with no scale legend', async () => {
    const page = await mount('busy');
    const wrap = page.handle.query('#panel-resources .chartWrap')!;
    expect(wrap.querySelector('.plot')).not.toBeNull();
    expect(wrap.querySelector('.chartY')).not.toBeNull();
    expect(wrap.querySelector('.chartTicks')).not.toBeNull();
    expect(wrap.querySelector('.chartScale')).toBeNull();
    expect(wrap.querySelectorAll('.chartY .yTick').length).toBe(fixture('busy').state.trend.yTicks.length);
  });

  it('reads as empty with one sample: a sentence, no lines, no y ticks', async () => {
    const page = await mount('idle-one-sample');
    expect(page.text()).toContain('Measuring… (1 of 150 samples)');
    expect(page.handle.queryAll('#panel-resources .chartY .yTick')).toHaveLength(0);
    expect(page.handle.queryAll('#panel-resources polyline')).toHaveLength(0);
  });
});
