// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { cleanup, fireEvent } from '@testing-library/react';
import { byAct, filterBox, many, mount, names, one, shared, srv, stateWith, text, installRuntimeDoubles } from './fixtures/serversPanelKit.js';

installRuntimeDoubles();

describe('ServersPanel — header', () => {
  it('renders nothing before the first snapshot', () => {
    mount(null);
    expect(text('#srvCount')).toBe('');
    expect(document.querySelector('#srvOps')!.childElementCount).toBe(0);
    expect(document.querySelector('#servers')!.childElementCount).toBe(0);
  });

  it('counts own and shared rows, and shows nothing for none', () => {
    mount(stateWith([srv(1, 'web'), srv(2, 'api')], [shared('db')]));
    expect(text('#srvCount')).toBe('3');
    cleanup();
    mount(stateWith([]));
    expect(text('#srvCount')).toBe('');
  });

  it('offers no ticket ops when nothing in scope can run', () => {
    mount(stateWith([], [], false));
    expect(document.querySelector('#srvOps')!.childElementCount).toBe(0);
  });

  it('with every service running disables Start, with the reason as label and title', () => {
    mount(stateWith([srv(1, 'web')]));
    const start = one('spin-servers');
    expect(start.disabled).toBe(true);
    expect(start.getAttribute('aria-label')).toBe('Every ticket service is already running');
    expect(start.getAttribute('title')).toBe('Every ticket service is already running');
    expect(one('restart-servers').disabled).toBe(false);
    expect(one('restart-servers').getAttribute('aria-label')).toBe('Restart all ticket services');
    expect(one('stop-servers').disabled).toBe(false);
    expect(one('server-logs-request').disabled).toBe(false);
    expect(one('env-overrides-open').getAttribute('aria-label')).toBe('Configure environment variables');
  });

  it('with no rows enables Start and disables Restart, Stop and Logs, each saying why', () => {
    mount(stateWith([]));
    expect(one('spin-servers').disabled).toBe(false);
    expect(one('spin-servers').getAttribute('aria-label')).toBe('Start all ticket services');
    expect(one('restart-servers').getAttribute('aria-label')).toBe('No ticket services to restart');
    expect(one('stop-servers').getAttribute('aria-label')).toBe('No ticket service is running');
    expect(one('server-logs-request').getAttribute('aria-label')).toBe('No services to show logs for');
    expect(one('server-logs-request').disabled).toBe(true);
    expect(one('env-overrides-open').disabled).toBe(false);
  });

  it('keeps Logs enabled when only shared rows exist', () => {
    mount(stateWith([], [shared('db')]));
    expect(one('server-logs-request').disabled).toBe(false);
  });

  it('disables Stop when no ticket service is running', () => {
    mount(stateWith([srv(1, 'web', { status: 'stopped' })]));
    expect(one('stop-servers').disabled).toBe(true);
    expect(one('spin-servers').disabled).toBe(false);
  });
});

describe('ServersPanel — empty states', () => {
  it('prompts to start when services can run but none do', () => {
    mount(stateWith([]));
    expect(text('#servers .estate .ehead')).toBe('No servers running');
    expect(document.querySelector('#servers .estate.dead')).toBeNull();
    expect(document.querySelector('#servers .emark svg.k-icon')).not.toBeNull();
  });

  it('states that nothing can run when no repository declares a service', () => {
    mount(stateWith([], [], false));
    expect(text('#servers .estate.dead .ehead')).toBe('No runnable services in scope');
    expect(text('#servers .esub')).toContain('without a service block');
  });
});

describe('ServersPanel — rows', () => {
  it('renders a running row with its status dot, address and the four row actions', () => {
    mount(stateWith([srv(1, 'web', { host: null, port: 4000 })]));
    const dot = document.querySelector('td.c-dot .glyph')!;
    expect(dot.className).toBe('glyph on');
    expect(dot.getAttribute('role')).toBe('img');
    expect(dot.getAttribute('aria-label')).toBe('running');
    expect(dot.getAttribute('title')).toBe('running');
    expect(text('td.c-addr .full')).toBe('localhost:4000');
    expect(text('td.c-addr .short')).toBe(':4000');
    expect(document.querySelector('td.c-addr')!.getAttribute('title')).toBe('localhost:4000');
    expect(document.querySelector('td.c-addr')!.className).toBe('c-addr');
    expect(byAct('open-server')).toHaveLength(1);
    expect(byAct('copy-server-url')).toHaveLength(1);
    expect(byAct('restart-server')).toHaveLength(1);
    expect(byAct('stop-server')).toHaveLength(1);
    expect(byAct('start-server')).toHaveLength(0);
  });

  it('renders a stopped row with a dash address and only Start', () => {
    mount(stateWith([srv(1, 'web', { status: 'stopped', host: null, port: null })]));
    expect(document.querySelector('td.c-dot .glyph')!.className).toBe('glyph off');
    expect(document.querySelector('td.c-addr')!.className).toBe('c-addr off');
    expect(text('td.c-addr')).toBe('—');
    expect(document.querySelector('td.c-addr')!.getAttribute('title')).toBe('offline — no address');
    expect(byAct('start-server')).toHaveLength(1);
    expect(byAct('open-server')).toHaveLength(0);
    expect(byAct('stop-server')).toHaveLength(0);
  });

  it('renders a failed row as a fault with its own words', () => {
    mount(stateWith([srv(1, 'web', { status: 'failed', host: null, port: null })]));
    expect(document.querySelector('td.c-dot .glyph')!.className).toBe('glyph failed');
    expect(document.querySelector('td.c-dot .glyph')!.getAttribute('aria-label')).toBe('failed');
    expect(text('td.c-addr')).toBe('failed to start');
    expect(document.querySelector('td.c-addr')!.getAttribute('title')).toBe('failed to start — see log');
    expect(byAct('start-server')).toHaveLength(1);
  });

  it('gives each icon action a matching aria-label and title, with the hue by tone', () => {
    mount(stateWith([srv(1, 'web')]));
    const expected: Array<[string, string, string]> = [
      ['open-server', 'Open in browser', 't-open'],
      ['copy-server-url', 'Copy URL', 't-copy'],
      ['restart-server', 'Restart', 't-restart'],
      ['stop-server', 'Stop', 't-stop'],
    ];
    for (const [act, label, tone] of expected) {
      const el = one(act, '[data-id="1"]');
      expect(el.getAttribute('aria-label')).toBe(label);
      expect(el.getAttribute('title')).toBe(label);
      expect(el.classList.contains(tone)).toBe(true);
      expect(el.classList.contains('k-iconbtn') && el.classList.contains('ib')).toBe(true);
    }
    expect(one('copy-server-url').hasAttribute('data-copy')).toBe(true);
    expect(one('open-server').hasAttribute('data-copy')).toBe(false);
  });

  it('titles the name cell with the service', () => {
    mount(stateWith([srv(1, 'web/admin')]));
    expect(document.querySelector('td.c-name')!.getAttribute('title')).toBe('web/admin');
  });

  it('groups own rows under a Ticket services caption and shows the shared ones under Shared services', () => {
    mount(stateWith([srv(1, 'web')], [shared('db', { baseBranch: 'main' })]));
    const heads = [...document.querySelectorAll('tr.srvgroup')];
    expect(heads.map((h) => h.querySelector('.gname')!.textContent)).toEqual(['Ticket services', 'Shared services']);
    expect(heads.map((h) => h.querySelector('.gcount')!.textContent)).toEqual(['1', '1']);
    expect(heads[0]!.querySelector('.gnote')!.textContent).toBe("run from this ticket's worktrees");
    expect(heads[1]!.querySelector('.gnote')!.textContent).toBe('one copy per repository, from the base branch');
    expect(document.querySelector('tr.srvgroup th')!.getAttribute('colspan')).toBe('5');
    expect(document.querySelector('tr.srvgroup th')!.getAttribute('scope')).toBe('colgroup');
  });

  it('keeps a shared-only stack truthful: a "No ticket services" line, no empty state', () => {
    mount(stateWith([], [shared('db')]));
    expect(text('.srvnone')).toBe('No ticket services');
    expect(document.querySelector('.estate')).toBeNull();
    expect(document.querySelector('tr.srvgroup .gcount')!.textContent).toBe('0');
  });

  it('renders a shared row read-only: branch chip, note, Open and Logs when they apply, always Manage', () => {
    mount(stateWith([], [shared('db')]));
    expect(text('.srvname')).toBe('db');
    expect(document.querySelector('.srvname')!.getAttribute('title')).toBe('db');
    expect(text('.srvbranch')).toBe('main');
    expect(document.querySelector('.srvbranch')!.className).toBe('srvbranch k-chip');
    expect(text('.srvnote')).toBe('shared with T9');
    expect(byAct('open-server')).toHaveLength(1);
    expect(byAct('server-logs-request')).toHaveLength(2); // header + the row's own Logs
    expect(byAct('open-resources')).toHaveLength(1);
    expect(byAct('stop-server')).toHaveLength(0);
    expect(byAct('start-server')).toHaveLength(0);
    expect(byAct('copy-server-url')).toHaveLength(0);
  });

  it('shows a stopped shared row as "— word", with no Open, and a missing reason instead of the sharers', () => {
    mount(stateWith([], [shared('db', { status: 'missing', id: null, host: null, port: null, logPath: null, baseBranch: null, missingReason: 'left the manifest' })]));
    expect(document.querySelector('td.c-dot .glyph')!.className).toBe('glyph failed');
    expect(document.querySelector('td.c-dot .glyph')!.getAttribute('aria-label')).toBe('missing');
    expect(text('td.c-addr')).toBe('— missing');
    expect(text('td.c-addr .offword')).toBe('missing');
    expect(document.querySelector('td.c-addr')!.getAttribute('title')).toBe('missing — no address');
    expect(text('.srvnote')).toBe('left the manifest');
    expect(document.querySelector('.srvbranch')).toBeNull();
    expect(byAct('open-server')).toHaveLength(0);
    expect(byAct('server-logs-request')).toHaveLength(1); // header only
    expect(byAct('open-resources')).toHaveLength(1);
  });

  it('words a stopped shared row "stopped" with the off dot', () => {
    mount(stateWith([], [shared('db', { status: 'stopped', host: null, port: null })]));
    expect(document.querySelector('td.c-dot .glyph')!.className).toBe('glyph off');
    expect(text('td.c-addr .offword')).toBe('stopped');
  });

  it('has the column header with a screen-reader-only status column', () => {
    mount(stateWith([srv(1, 'web')]));
    const heads = [...document.querySelectorAll('thead th')];
    expect(heads.map((h) => h.textContent)).toEqual(['Status', 'Service', 'Address', 'Actions']);
    expect(heads[0]!.querySelector('.sr')).not.toBeNull();
    expect(heads[2]!.getAttribute('colspan')).toBe('2');
  });
});

describe('ServersPanel — filter', () => {
  it('offers no filter up to six services', () => {
    mount(stateWith(many(6)));
    expect(filterBox()).toBeNull();
  });

  it('offers a labelled search input from the seventh service, counting both groups', () => {
    mount(stateWith(many(5), [shared('db'), shared('cache', { id: 91 })]));
    const box = filterBox();
    expect(box.type).toBe('search');
    expect(box.className).toBe('k-input');
    expect(box.placeholder).toBe('Filter 7 services…');
    expect(box.hasAttribute('data-filter')).toBe(true);
    expect(document.querySelector('label.sr[for="srvFilter"]')!.textContent).toBe('Filter services');
  });

  it('narrows both groups by a case-insensitive substring of the service name', () => {
    mount(stateWith(many(8), [shared('svc-db'), shared('cache', { id: 91 })]));
    fireEvent.change(filterBox(), { target: { value: ' SVC-1 ' } });
    expect(names()).toEqual(['svc-1']);
    expect(document.querySelectorAll('tr.srvgroup')).toHaveLength(1);
    fireEvent.change(filterBox(), { target: { value: 'svc-d' } });
    expect(names()).toEqual(['svc-db']);
    expect(text('tr.srvgroup .gname')).toBe('Shared services');
  });

  it('says so when nothing matches, quoting what was typed', () => {
    mount(stateWith(many(8)));
    fireEvent.change(filterBox(), { target: { value: 'zzz' } });
    expect(text('.nomatch')).toBe('No service matches “zzz”.');
    expect(document.querySelectorAll('tr.srvgroup')).toHaveLength(0);
  });

  it('keeps the same input element, so typing keeps focus', () => {
    mount(stateWith(many(8)));
    const box = filterBox();
    box.focus();
    fireEvent.change(box, { target: { value: 'svc-2' } });
    expect(filterBox()).toBe(box);
    expect(document.activeElement).toBe(box);
    expect(box.value).toBe('svc-2');
  });

  it('persists every change with the view state, beside the snapshot', () => {
    const h = mount(stateWith(many(8)));
    fireEvent.change(filterBox(), { target: { value: 'a' } });
    fireEvent.change(filterBox(), { target: { value: 'ab' } });
    expect(h.setState.mock.calls.map(([envelope]) => (envelope as { srvFilter: string }).srvFilter)).toEqual(['a', 'ab']);
    expect(h.setState).toHaveBeenLastCalledWith(expect.objectContaining({ state: stateWith(many(8)), sel: null, srvFilter: 'ab' }));
  });

  it('starts from the filter the page persisted', () => {
    mount(stateWith(many(8)), { state: stateWith(many(8)), srvFilter: 'svc-3' });
    expect(filterBox().value).toBe('svc-3');
    expect(names()).toEqual(['svc-3']);
  });

  it('ignores a persisted filter that is not a string', () => {
    mount(stateWith(many(8)), { state: stateWith(many(8)), srvFilter: 5 });
    expect(filterBox().value).toBe('');
  });

  it('shows everything again when the stack shrinks below the filter threshold', () => {
    const h = mount(stateWith(many(8)));
    fireEvent.change(filterBox(), { target: { value: 'svc-2' } });
    h.emit({ type: 'state', state: stateWith(many(3)) });
    expect(filterBox()).toBeNull();
    expect(names()).toEqual(['svc-1', 'svc-2', 'svc-3']);
  });
});

