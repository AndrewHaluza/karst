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
    expect(page.text()).toContain('Attributed to Karst');
    expect(page.text()).toContain('Unattributed (top 5)');
  });

  it('draws the trend as inline SVG with a polyline per series and labelled axes', async () => {
    const page = await mount('busy');
    expect(rows(page, 'svg polyline')).toHaveLength(2);
    expect(rows(page, '.chartY .yTick').length).toBe(fixture('busy').state.trend.yTicks.length);
    expect(rows(page, '.chartTicks text').length).toBe(fixture('busy').state.trend.timeTicks.length);
  });

  it('says it is measuring before the first sample', async () => {
    const page = await mount('idle');
    expect(page.text()).toContain('Measuring… (0 of 150 samples)');
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

  it('sorts by a header button: desc → asc → default for a numeric column, with aria-sort', async () => {
    const page = await mount('unattributed');
    const th = rows(page, '.utable th')[0]!;
    const btn = th.querySelector('button')!;
    await page.click(btn);
    expect(th.getAttribute('aria-sort')).toBe('descending');
    await page.click(btn);
    expect(th.getAttribute('aria-sort')).toBe('ascending');
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
    expect(page.text()).toContain('report-only — Karst cannot prove this process is safe to stop');
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

describe('Resources tab — production polish (RS-5, RS-8, RS-9, RS-11, RS-20..RS-26)', () => {
  it('keeps a waste row failure note when a new sample arrives (RS-5)', async () => {
    const page = await mount('waste');
    const stop = buttonLabelled(page, 'Stop');
    await page.click(stop);
    const sent = page.last('kill-server')!;
    await page.answer(sent.requestId!, false, 'Refused — the process is still running');
    const state = fixture('waste').state;
    await page.receive({
      type: 'state',
      state: { ...state, waste: state.waste.map((w) => ({ ...w, rssBytes: w.rssBytes + 1, rssDisplay: '6 MB' })) },
    });
    expect(page.handle.query('#panel-resources [role=alert]')?.textContent).toBe('Refused — the process is still running');
  });

  it('draws the y labels without a scale legend and states the trend as text (RS-8)', async () => {
    const page = await mount('busy');
    expect(rows(page, '.chartScale')).toHaveLength(0);
    expect(rows(page, '.chartY .yTick').length).toBeGreaterThan(0);
    expect(page.text()).toContain('CPU 35%, rising. RSS 80 MB.');
  });

  it('treats one sample as empty and says so, with no y ticks (RS-9)', async () => {
    const page = await renderResourcesApp({ hash: '#resources' });
    const base = fixture('busy').state;
    await page.receive({ type: 'state', state: { ...base, history: base.history.slice(0, 1) } });
    expect(page.text()).toContain('Measuring… (1 of 150 samples)');
    expect(rows(page, '.chartY .yTick')).toHaveLength(0);
    expect(rows(page, 'svg polyline')).toHaveLength(0);
  });

  it('shows a .k-empty instead of an empty attributed table (RS-20)', async () => {
    const page = await mount('idle');
    expect(rows(page, '.k-empty-title')[0]?.textContent).toBe('No Karst process runs now');
    expect(rows(page, '.k-empty-hint')[0]?.textContent).toBe('Start a ticket session to see its processes.');
  });

  it('shows the host-built attribution text and the sentence-case name (RS-22, RS-26)', async () => {
    const page = await mount('busy');
    const base = fixture('busy').state;
    await page.receive({
      type: 'state',
      state: {
        ...base,
        rows: [{ ...base.rows[0]!, attribution: 'attributable', attributionText: 'Proven Karst process' }],
        waste: [{ ...fixture('waste').state.waste[0]!, killable: false, serverId: null, reason: 'leaked Karst server' }],
        wasteCount: 1,
      },
    });
    expect(page.text()).toContain('Attributed to Karst');
    expect(page.text()).toContain('Proven Karst process');
    expect(page.text()).toContain('report-only — Karst cannot prove this process is safe to stop');
  });

  it('opens only the sample cadence and the recent trend, the rest in a closed details (RS-24)', async () => {
    const page = await renderResourcesApp({ hash: '#resources' });
    const base = fixture('busy').state;
    await page.receive({
      type: 'state',
      state: {
        ...base,
        facts: [
          { label: 'Samples', value: 'every 2 s', primary: true },
          { label: 'Recent CPU', value: 'steady', primary: true },
          { label: 'Snapshot cost', value: '1 × ps' },
          { label: 'Disk lane', value: 'panel open' },
        ],
      },
    });
    expect(rows(page, '#facts > .factRow')).toHaveLength(2);
    const details = rows(page, '#facts details')[0] as HTMLDetailsElement;
    expect(details.open).toBe(false);
    expect(details.querySelector('summary')?.textContent).toBe('Monitor details');
    expect(details.textContent).toContain('Snapshot cost');
  });

  it('marks Measure as a secondary control (RS-25)', async () => {
    const page = await mount('busy');
    expect(buttonLabelled(page, 'Measure').className).toContain('k-btn--secondary');
  });

  it('carries column priority and cell labels for the tier rules (RS-11)', async () => {
    const page = await mount('busy');
    const procs = rows(page, '#attrHead th').find((th) => th.textContent?.trim().startsWith('Procs'))!;
    expect(procs.getAttribute('data-priority')).toBe('3');
    expect(rows(page, '#attrBody tr:first-child td[data-label="Ticket"]')).toHaveLength(1);
    expect(rows(page, '#unkHead th').find((th) => th.textContent?.trim().startsWith('Procs'))!.getAttribute('data-priority')).toBe('3');
  });

  it('stamps the measured tier on the Resources view for the tier rules (RS-11)', async () => {
    const page = await mount('busy');
    expect(rows(page, '.rview')[0]?.getAttribute('data-tier')).toBe('wide');
  });

  it('follows the container width into the narrow and tight tiers (RS-11)', async () => {
    const page = await mount('busy');
    const callbacks: ResizeObserverCallback[] = [];
    (page.handle.window as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
      constructor(cb: ResizeObserverCallback) { callbacks.push(cb); }
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    };
    const grown = await renderResourcesApp({ hash: '#resources' });
    for (const m of fixtureMessages(fixture('busy'))) await grown.receive(m);
    const fire = async (width: number): Promise<void> => {
      for (const cb of callbacks) cb([{ contentRect: { width } }] as unknown as ResizeObserverEntry[], {} as ResizeObserver);
      await grown.settle();
    };
    await fire(650);
    expect(rows(grown, '.rview')[0]?.getAttribute('data-tier')).toBe('narrow');
    await fire(360);
    expect(rows(grown, '.rview')[0]?.getAttribute('data-tier')).toBe('tight');
    await fire(1200);
    expect(rows(grown, '.rview')[0]?.getAttribute('data-tier')).toBe('wide');
  });
});

describe('Resources tab — container rows and the VM overhead row', () => {
  const containerRow = {
    ticketKey: 'T7', ticketTitle: 'sandboxed', label: 'sandbox claude proxy', pid: 0, cpuPct: 3,
    cpuPctDisplay: '3%', rssBytes: 52_428_800, rssDisplay: '50.0 MB', procCount: 1, uptimeMs: null,
    uptimeDisplay: '', attribution: 'attributable' as const,
  };
  async function mountWith(extra: Record<string, unknown>): Promise<RenderedResources> {
    const page = await renderResourcesApp({ hash: '#resources' });
    const base = fixture('busy').state;
    await page.receive({ type: 'state', state: { ...base, rows: [...base.rows, containerRow], ...extra } } as never);
    return page;
  }

  it('shows a container row without a pid or a Kill, and the VM row outside the totals', async () => {
    const page = await mountWith({ vmOverhead: { cpuPctDisplay: '12%', rssDisplay: '3.0 GB' } });
    expect(page.text()).toContain('sandbox claude proxy');
    expect(rows(page, '#attrBody tr').some((tr) => tr.textContent!.includes('sandbox claude proxy') && tr.textContent!.includes('—') && !tr.querySelector('button'))).toBe(true);
    expect(rows(page, '#vmOverhead')[0]!.textContent).toContain('VM overhead / other · CPU 12% · RSS 3.0 GB');
    expect(rows(page, '#vmOverhead')[0]!.textContent).toContain('not counted in totals');
  });

  it('says so when docker stopped answering, and omits the VM row without a VM', async () => {
    const page = await mountWith({ vmOverhead: null, containersDegraded: true });
    expect(rows(page, '#containersDegraded')).toHaveLength(1);
    expect(rows(page, '#vmOverhead')).toHaveLength(0);
  });
});
