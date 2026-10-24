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

const rows = (page: RenderedResources, selector: string) => page.handle.queryAll(`#panel-resources ${selector}`);
const buttonLabelled = (page: RenderedResources, label: string) =>
  page.handle.queryAll<HTMLButtonElement>('#panel-resources button').find((b) => b.textContent?.trim() === label)!;

describe('Resources tab — the cost view, unchanged under a tab', () => {
  it('renders nothing before the first state (no half-drawn panels)', async () => {
    const page = await renderResourcesApp({ hash: '#resources' });
    expect(rows(page, '.panel')).toHaveLength(0);
  });

  it('unsupported shows the explanatory note and no panels', async () => {
    const page = await mount('unsupported');
    expect(page.text()).toContain('Resource monitoring is not supported on this platform');
    expect(rows(page, '.panel')).toHaveLength(0);
  });

  it('degraded keeps the previous numbers on screen with the degraded note', async () => {
    const page = await mount('degraded');
    expect(page.text()).toContain('The last reading did not complete');
    expect(rows(page, '.panel').length).toBeGreaterThan(0);
  });

  it('renders one attributed row per entry and the pre-formatted strings', async () => {
    const page = await mount('busy');
    const state = fixture('busy').state;
    expect(rows(page, '.panel:nth-of-type(1) tbody tr, tbody tr').length).toBeGreaterThanOrEqual(state.rows.length);
    expect(page.text()).toContain(state.cpuPctDisplay);
    expect(page.text()).toContain(state.rssDisplay);
    expect(page.text()).toContain(state.sampleAgeDisplay);
    expect(page.text()).toContain('Attributed to karst');
    expect(page.text()).toContain('Unattributed (top 5)');
  });

  it('draws the trend as inline SVG with a polyline per series and labelled axes', async () => {
    const page = await mount('busy');
    expect(rows(page, 'svg polyline')).toHaveLength(2);
    expect(rows(page, '.chartY .yTick').length).toBe(fixture('busy').state.trend.yTicks.length);
    expect(rows(page, '.chartTicks text').length).toBe(fixture('busy').state.trend.timeTicks.length);
  });

  it('says "measuring" before the first sample', async () => {
    const page = await mount('idle');
    expect(page.text()).toContain('measuring…');
  });

  it('legend toggles mute a series locally and post nothing', async () => {
    const page = await mount('busy');
    const before = page.posted.length;
    const cpu = rows(page, '[data-series=cpu]')[0]!;
    expect(cpu.getAttribute('aria-pressed')).toBe('true');
    await page.click(cpu);
    expect(cpu.getAttribute('aria-pressed')).toBe('false');
    expect(rows(page, 'polyline.series-cpu.muted')).toHaveLength(1);
    await page.click(cpu);
    expect(rows(page, 'polyline.series-cpu.muted')).toHaveLength(0);
    expect(page.posted.length).toBe(before);
  });

  it('sorts by a header button: asc → desc → default, with aria-sort', async () => {
    const page = await mount('unattributed');
    const th = rows(page, '.utable th')[0]!;
    const btn = th.querySelector('button')!;
    await page.click(btn);
    expect(th.getAttribute('aria-sort')).toBe('ascending');
    await page.click(btn);
    expect(th.getAttribute('aria-sort')).toBe('descending');
    await page.click(btn);
    expect(th.getAttribute('aria-sort')).toBeNull();
  });

  it('a kill control posts kill-server with the server id and a request id, pending until answered', async () => {
    const page = await mount('waste');
    const stop = buttonLabelled(page, 'Stop');
    await page.click(stop);
    const sent = page.last('kill-server')!;
    expect(sent).toMatchObject({ type: 'kill-server', serverId: fixture('waste').state.waste[0]!.serverId });
    expect(sent.requestId).toBeTruthy();
    expect(stop.getAttribute('aria-busy')).toBe('true');
    await page.click(stop);
    expect(page.all('kill-server')).toHaveLength(1);
    await page.answer(sent.requestId!, false, 'Refused — the process is still running');
    expect(stop.getAttribute('aria-busy')).toBeNull();
    expect(page.handle.query('#panel-resources [role=alert]')?.textContent).toBe('Refused — the process is still running');
  });

  it('report-only waste carries its explanation as visible text, not a title', async () => {
    const state = { ...fixture('waste').state, waste: [{ ...fixture('waste').state.waste[0]!, killable: false, serverId: null }] };
    const page = await renderResourcesApp({ hash: '#resources' });
    await page.receive({ type: 'state', state });
    expect(page.text()).toContain('report-only — karst cannot prove this process is safe to stop');
  });

  it('Measure posts measure-disk and a disk push renders the rows', async () => {
    const page = await mount('busy');
    await page.click(buttonLabelled(page, 'Measure'));
    expect(page.last('measure-disk')?.requestId).toBeTruthy();
    const disk = fixture('busy').state.disk;
    await page.receive({ type: 'disk', rows: [...disk, { ...disk[0]!, path: 'fixture:/other', display: 'other/node_modules' }] });
    expect(rows(page, '.drow')).toHaveLength(disk.length + 1);
    expect(rows(page, 'progress.diskTrack')).toHaveLength(disk.length + 1);
    expect(rows(page, 'progress.diskTrack')[0]!.getAttribute('aria-label')).toContain(disk[0]!.display);
  });

  it('escapes hostile labels: no injected element, the text survives verbatim', async () => {
    const page = await mount('hostile');
    expect(page.handle.queryAll('script').filter((s) => (s.textContent ?? '').includes('alert(1)') && !s.textContent!.includes('acquireVsCodeApi')).length).toBe(0);
    expect(page.text()).toContain('<script>alert(1)</script>');
    expect(page.text()).toContain('A & B "quoted" <b>');
  });
});
