// @vitest-environment jsdom
import { afterAll, describe, expect, it } from 'vitest';
import { fixtureMessages, resourcesRenderFixtures } from '../renderFixtures.js';
import { closeResourcesRealm, renderResourcesApp, type RenderedResources } from './renderResourcesApp.js';

afterAll(closeResourcesRealm);

const fixture = (scenario: string) => resourcesRenderFixtures().find((f) => f.scenario === scenario)!;

async function mount(scenario: string, hash = '#servers'): Promise<RenderedResources> {
  const page = await renderResourcesApp({ hash });
  for (const m of fixtureMessages(fixture(scenario))) await page.receive(m);
  return page;
}

const q = (page: RenderedResources, selector: string) => page.handle.queryAll<HTMLElement>(`#panel-servers ${selector}`);
const one = (page: RenderedResources, selector: string) => q(page, selector)[0]!;
const sharedRow = (page: RenderedResources, service: string) => one(page, `.srow[data-service="${service}"]`);
const btn = (root: Element, label: string) =>
  [...root.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === label)!;
const names = (root: Element) => [...root.querySelectorAll('button')].map((b) => b.textContent?.trim());

describe('Servers tab — structure', () => {
  it('lays out toolbar, main and footer regions in stacking order', async () => {
    const page = await mount('servers-mixed');
    const regions = q(page, '[data-region]').map((e) => e.dataset.region);
    expect(regions).toEqual(['toolbar', 'main', 'footer']);
  });

  it('summary strip: running (ticket vs shared), idle shared, finished tickets with running rows', async () => {
    const page = await mount('servers-mixed');
    const stats = q(page, '.stat').map((s) => [s.querySelector('.k')!.textContent, s.querySelector('.v')!.textContent, s.querySelector('.n')!.textContent]);
    expect(stats).toEqual([
      ['Running', '4', '2 ticket · 2 shared'],
      ['Idle shared', '1', 'no live ticket, not kept running'],
      ['Finished tickets', '1', 'with servers still running'],
    ]);
  });

  it('Shared services group: status word, service, base-branch chip, port, dependents (done marked), kept running', async () => {
    const page = await mount('servers-mixed');
    const api = sharedRow(page, 'api');
    expect(api.querySelector('.smark-word')!.textContent).toBe('Running');
    expect(api.querySelector('.smark-shape')!.textContent).toBe('●');
    expect(api.querySelector('.sname')!.textContent).toBe('api');
    expect(api.querySelector('.chip-branch')!.textContent).toBe('develop');
    expect(api.querySelector('.saddr')!.textContent).toBe('localhost:4000');
    expect(api.querySelector('.deps')!.textContent).toContain('FEAT-100');
    expect(api.querySelector('.dep-done')!.textContent).toContain('done');
    expect(api.querySelector('.chip-kept')!.textContent).toBe('kept running');
    const db = sharedRow(page, 'db');
    expect(db.querySelector('.smark-word')!.textContent).toBe('Stopped');
    expect(db.querySelector('.smark-shape')!.textContent).toBe('○');
    expect(db.querySelector('.saddr')!.textContent).toBe('—');
    expect(db.querySelector('.chip-kept')).toBeNull();
  });

  it('offers the right verbs per state; the pin keeps a stable name and exposes aria-pressed', async () => {
    const page = await mount('servers-mixed');
    expect(names(sharedRow(page, 'api'))).toEqual(['Keep running', 'Restart', 'Stop', 'Open', 'Copy URL']);
    expect(names(sharedRow(page, 'db'))).toEqual(['Keep running', 'Start']);
    expect(btn(sharedRow(page, 'api'), 'Keep running').getAttribute('aria-pressed')).toBe('true');
    expect(btn(sharedRow(page, 'web'), 'Keep running').getAttribute('aria-pressed')).toBe('false');
  });

  it('Ticket stacks: key/title/stage, running count, Stop all, Logs, ticket rows', async () => {
    const page = await mount('servers-mixed');
    const groups = q(page, 'section.group[aria-labelledby^="ticket-"]');
    expect(groups).toHaveLength(3);
    const first = groups[0]!;
    expect(first.querySelector('.tkey')!.textContent).toBe('FEAT-100');
    expect(first.querySelector('.gname')!.textContent).toBe('Ticket 1');
    expect(first.querySelector('.stage')!.textContent).toBe('impl');
    expect(first.querySelector('.count')!.textContent).toBe('1 of 2 running');
    expect(btn(first, 'Stop all').disabled).toBe(false);
    expect(first.querySelectorAll('.srow')).toHaveLength(2);
    expect(names(first.querySelectorAll('.srow')[1]!)).toEqual(['Start']);
  });

  it('flags: done ticket, dependency down; Stop all is disabled when nothing runs', async () => {
    const page = await mount('servers-mixed');
    const [, done, down] = q(page, 'section.group[aria-labelledby^="ticket-"]');
    expect(done!.querySelector('.gflags')!.textContent).toContain('ticket done · servers still running');
    expect(down!.querySelector('.flag-down')!.textContent).toBe('dependency down: db');
    expect(btn(down!, 'Stop all').disabled).toBe(true);
    expect(btn(down!, 'Stop all').getAttribute('aria-describedby')).toBe(down!.querySelector('.count')!.id);
  });

  it('an archived group carries "clean up"', async () => {
    const page = await mount('servers-archived');
    const group = one(page, 'section.group[aria-labelledby^="ticket-"]');
    expect(group.querySelector('.gflags')!.textContent).toContain('archived · clean up');
    expect(group.querySelector('.gflags')!.textContent).not.toContain('ticket done');
  });

  it('a done group says "ticket done · servers still running"', async () => {
    const page = await mount('servers-done');
    expect(one(page, '.gflags').textContent).toBe('ticket done · servers still running');
  });

  it('has NO project-wide "Start all"', async () => {
    const page = await mount('servers-mixed');
    expect(page.text()).not.toMatch(/start all/i);
  });
});

describe('Servers tab — footer', () => {
  it('shows a legend with shape plus word for every status', async () => {
    const page = await mount('servers-mixed');
    const legend = one(page, '.legend-key').textContent!;
    for (const [shape, word] of [['●', 'Running'], ['○', 'Stopped'], ['✕', 'Failed']]) {
      expect(legend).toContain(shape);
      expect(legend).toContain(word);
    }
    expect(legend).toContain('kept running');
  });

  it('Stop idle is enabled and names what it will stop', async () => {
    const page = await mount('servers-idle');
    const footer = one(page, '[data-region=footer]');
    expect(btn(footer, 'Stop idle').disabled).toBe(false);
    expect(footer.querySelector('#stop-idle-why')!.textContent).toBe('Will stop: api, web');
  });

  it('Stop idle is disabled with a VISIBLE reason when nothing is idle (not title-only)', async () => {
    const page = await mount('servers-done');
    const footer = one(page, '[data-region=footer]');
    const stop = btn(footer, 'Stop idle');
    expect(stop.disabled).toBe(true);
    expect(stop.getAttribute('aria-describedby')).toBe('stop-idle-why');
    expect(footer.querySelector('#stop-idle-why')!.textContent).toMatch(/no idle shared service/i);
    await page.click(stop);
    expect(page.all('stop-idle')).toHaveLength(0);
  });

  it('Stop idle and Open logs post their verbs with a request id', async () => {
    const page = await mount('servers-idle');
    const footer = one(page, '[data-region=footer]');
    await page.click(btn(footer, 'Stop idle'));
    expect(page.last('stop-idle')?.requestId).toBeTruthy();
    await page.click(btn(footer, 'Open logs'));
    expect(page.last('open-logs')?.requestId).toBeTruthy();
  });
});

describe('Servers tab — empty and unavailable states', () => {
  it('no servers at all', async () => {
    const page = await mount('servers-none');
    expect(one(page, '[data-region=main]').textContent).toContain('No servers in this project yet');
    expect(q(page, '.stat')).toHaveLength(3);
    expect(btn(one(page, '[data-region=footer]'), 'Stop idle').disabled).toBe(true);
  });

  it('shared only: the ticket section says so', async () => {
    const page = await mount('servers-shared-only');
    expect(one(page, '.tickets .gempty').textContent).toContain('No ticket has servers');
    expect(q(page, '.srow').length).toBe(3);
  });

  it('tickets only: the shared section says so', async () => {
    const page = await mount('servers-tickets-only');
    expect(one(page, 'section[aria-labelledby=shared-heading] .gempty').textContent).toContain('No shared service has run yet');
  });

  it('unavailable names the reason and hides the summary', async () => {
    const page = await mount('servers-unavailable');
    expect(one(page, '[data-region=main]').textContent).toContain('Open a project with a karst.yml');
    expect(q(page, '[data-region=toolbar]')).toHaveLength(0);
  });

  it('before the first push it says it is reading', async () => {
    const page = await renderResourcesApp({ hash: '#servers' });
    expect(one(page, '[role=status]').textContent).toContain('Reading servers');
  });
});

describe('Servers tab — verbs, pending and results', () => {
  it.each([
    ['api', 'Restart', 'shared-restart', { repo: 'api' }],
    ['api', 'Stop', 'shared-stop', { repo: 'api' }],
    ['db', 'Start', 'shared-start', { repo: 'db' }],
  ] as const)('shared %s › %s posts %s with only the unit key', async (service, label, type, expected) => {
    const page = await mount('servers-mixed');
    await page.click(btn(sharedRow(page, service), label));
    expect(page.last(type)).toMatchObject({ type, ...expected, requestId: expect.any(String) });
  });

  it('the pin toggle posts the NEW value', async () => {
    const page = await mount('servers-mixed');
    await page.click(btn(sharedRow(page, 'web'), 'Keep running'));
    expect(page.last('shared-pin')).toMatchObject({ repo: 'web', pinned: true });
    await page.click(btn(sharedRow(page, 'api'), 'Keep running'));
    await page.answer(page.all('shared-pin')[0]!.requestId!, true);
    await page.click(btn(sharedRow(page, 'api'), 'Keep running'));
    expect(page.last('shared-pin')).toMatchObject({ repo: 'api', pinned: false });
  });

  it('a ticket row posts its server id; Stop all and Logs post the ticket id', async () => {
    const page = await mount('servers-mixed');
    const group = one(page, 'section.group[aria-labelledby^="ticket-"]');
    const row = group.querySelector('.srow')!;
    await page.click(btn(row, 'Restart'));
    expect(page.last('server-restart')).toMatchObject({ serverId: 900110 });
    await page.answer(page.last('server-restart')!.requestId!, true);
    await page.click(btn(row, 'Stop'));
    expect(page.last('server-stop')).toMatchObject({ serverId: 900110 });
    await page.answer(page.last('server-stop')!.requestId!, true);
    await page.click(btn(row, 'Open'));
    expect(page.last('server-open')).toMatchObject({ serverId: 900110 });
    await page.answer(page.last('server-open')!.requestId!, true);
    await page.click(btn(row, 'Copy URL'));
    expect(page.last('server-copy')).toMatchObject({ serverId: 900110 });
    await page.click(btn(group, 'Stop all'));
    expect(page.last('ticket-stop-all')).toMatchObject({ ticketId: 900200 });
    await page.answer(page.last('ticket-stop-all')!.requestId!, true);
    await page.click(btn(group, 'Logs'));
    expect(page.last('ticket-logs')).toMatchObject({ ticketId: 900200 });
  });

  it('pending: only the pressed control is busy, the rest of the row is disabled, geometry keeps its labels', async () => {
    const page = await mount('servers-mixed');
    const row = sharedRow(page, 'api');
    const labelsBefore = names(row);
    await page.click(btn(row, 'Stop'));
    expect(btn(row, 'Stop').getAttribute('aria-busy')).toBe('true');
    expect(btn(row, 'Restart').getAttribute('aria-busy')).toBeNull();
    expect(btn(row, 'Restart').disabled).toBe(true);
    expect(names(row)).toEqual(labelsBefore);
    await page.click(btn(row, 'Restart'));
    expect(page.all('shared-restart')).toHaveLength(0);
    // another row is unaffected
    expect(btn(sharedRow(page, 'web'), 'Stop').disabled).toBe(false);
  });

  it('a success settles the row back to idle with no error note', async () => {
    const page = await mount('servers-mixed');
    const row = sharedRow(page, 'api');
    await page.click(btn(row, 'Stop'));
    await page.answer(page.last('shared-stop')!.requestId!, true);
    expect(btn(row, 'Stop').getAttribute('aria-busy')).toBeNull();
    expect(btn(row, 'Stop').disabled).toBe(false);
    expect(row.querySelector('.rownote')).toBeNull();
  });

  it('a failure shows the host reason as visible alert text and frees the row', async () => {
    const page = await mount('servers-mixed');
    const row = sharedRow(page, 'api');
    await page.click(btn(row, 'Stop'));
    await page.answer(page.last('shared-stop')!.requestId!, false, 'api was not stopped — its process is still running.');
    expect(row.querySelector('[role=alert]')!.textContent).toBe('api was not stopped — its process is still running.');
    expect(btn(row, 'Stop').disabled).toBe(false);
    // and it announces through the page's one live region (UI-R27)
    expect(page.handle.query('.k-live-region')!.textContent).toContain('api was not stopped');
  });

  it('a request the host never answers is "unknown": row stays locked until a fresh read lands', async () => {
    const { vi } = await import('vitest');
    vi.useFakeTimers();
    try {
      const page = await mount('servers-mixed');
      const row = sharedRow(page, 'api');
      await page.click(btn(row, 'Stop'));
      expect(row.querySelector('[role=alert]')!.textContent).toContain('No answer from the host');
      expect(btn(row, 'Stop').disabled).toBe(true);
      await page.receive({ type: 'servers', state: fixture('servers-mixed').servers! });
      await page.receive({ type: 'servers', state: fixture('servers-mixed').servers! });
      expect(btn(sharedRow(page, 'api'), 'Stop').disabled).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('re-renders from a fresh push without losing a row that is still there', async () => {
    const page = await mount('servers-mixed');
    await page.receive({ type: 'servers', state: fixture('servers-shared-only').servers! });
    expect(q(page, 'section.group[aria-labelledby^="ticket-"]')).toHaveLength(0);
    expect(sharedRow(page, 'api')).toBeTruthy();
  });
});

describe('Servers tab — hostile and long content', () => {
  it('escapes hostile names and wraps long ones (no element injected)', async () => {
    const page = await mount('servers-hostile');
    expect(page.text()).toContain('<script>alert(1)</script>');
    expect(page.handle.queryAll('script').filter((s) => (s.textContent ?? '').includes('alert(1)') && !(s.textContent ?? '').includes('acquireVsCodeApi'))).toHaveLength(0);
    expect(one(page, '.sname').className).toContain('sname');
    expect(page.text()).toContain('Z'.repeat(120));
  });
});
