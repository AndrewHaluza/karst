// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { cleanup, fireEvent } from '@testing-library/react';
import { byAct, filterBox, many, mount, names, one, shared, srv, stateWith, text, installRuntimeDoubles } from './fixtures/serversPanelKit.js';

installRuntimeDoubles();

describe('ServersPanel — header', () => {
  it('renders an empty body and no count before the first snapshot', () => {
    mount(null);
    expect(document.querySelector('.phead .count')).toBeNull();
    expect(document.querySelector('.phead .pops')).toBeNull();
    expect(document.querySelector('#servers')!.childElementCount).toBe(0);
  });

  it('counts own and shared rows, and shows nothing for none', () => {
    mount(stateWith([srv(1, 'web'), srv(2, 'api')], [shared('db')]));
    expect(text('.phead .count')).toBe('3');
    cleanup();
    mount(stateWith([]));
    expect(document.querySelector('.phead .count')).toBeNull();
  });

  it('offers no ticket ops when nothing in scope can run', () => {
    mount(stateWith([], [], false));
    expect(document.querySelector('.phead .pops button')).toBeNull();
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

describe('ServersPanel — summary', () => {
  const summary = (): string => text('.phead .sec-sum');

  it('says all running for a healthy ticket stack and carries the full text in the title', () => {
    mount(stateWith([srv(1, 'web'), srv(2, 'api')]));
    expect(summary()).toBe('all running');
    expect(document.querySelector('.phead .sec-sum')!.getAttribute('title')).toBe('all running');
  });

  it('counts only the non-zero parts of a mixed ticket stack', () => {
    mount(stateWith([srv(1, 'a'), srv(2, 'b', { status: 'failed' }), srv(3, 'c', { status: 'stopped' }), srv(4, 'd', { status: 'stopped' })]));
    expect(summary()).toBe('1 running · 1 failed · 2 offline');
    cleanup();
    mount(stateWith([srv(1, 'a'), srv(2, 'b', { status: 'stopped' })]));
    expect(summary()).toBe('1 running · 1 offline');
  });

  it('adds the shared part and never mixes its counts into the ticket part', () => {
    mount(stateWith([srv(1, 'web')], [shared('db')]));
    expect(summary()).toBe('all running · shared: ok');
    cleanup();
    mount(stateWith([srv(1, 'web')], [shared('db', { status: 'failed' }), shared('cache', { status: 'missing', id: null }), shared('q')]));
    expect(summary()).toBe('all running · shared: 2 failing');
  });

  it('has only the shared part when no ticket service exists, and no summary when nothing is in scope', () => {
    mount(stateWith([], [shared('db')]));
    expect(summary()).toBe('shared: ok');
    cleanup();
    mount(stateWith([]));
    expect(document.querySelector('.phead .sec-sum')).toBeNull();
  });
});

describe('ServersPanel — empty states', () => {
  it('prompts to start when services can run but none do, with a period and no button', () => {
    mount(stateWith([]));
    expect(text('#servers .estate .ehead')).toBe('No servers running.');
    expect(document.querySelector('#servers .estate.dead')).toBeNull();
    expect(document.querySelector('#servers .emark svg.k-icon')).not.toBeNull();
    expect(document.querySelector('#servers button')).toBeNull();
  });

  it('states that nothing can run when no repository declares a service', () => {
    mount(stateWith([], [], false));
    expect(text('#servers .estate.dead .ehead')).toBe('No runnable services in scope.');
    expect(text('#servers .esub')).toContain('without a service block');
  });
});

describe('ServersPanel — rows', () => {
  it('renders a running row with its dot, address link, copy and the Restart and Stop trail', () => {
    mount(stateWith([srv(1, 'web', { host: null, port: 4000 })]));
    const dot = document.querySelector('.krow-lead .glyph')!;
    expect(dot.className).toBe('glyph on');
    expect(dot.getAttribute('role')).toBe('img');
    expect(dot.getAttribute('aria-label')).toBe('running');
    expect(dot.getAttribute('title')).toBe('running');
    expect(text('.srvaddr .full')).toBe('localhost:4000');
    expect(text('.srvaddr .short')).toBe(':4000');
    expect(one('open-server').getAttribute('title')).toBe('Open localhost:4000 in the browser');
    expect(byAct('open-server')).toHaveLength(1);
    expect(byAct('copy-server-url')).toHaveLength(1);
    expect(byAct('restart-server')).toHaveLength(1);
    expect(byAct('stop-server')).toHaveLength(1);
    expect(byAct('start-server')).toHaveLength(0);
    expect(document.querySelector('.srvword')).toBeNull();
  });

  it('renders a stopped row with the word offline (dim) and only Start', () => {
    mount(stateWith([srv(1, 'web', { status: 'stopped', host: null, port: null })]));
    expect(document.querySelector('.krow-lead .glyph')!.className).toBe('glyph off');
    expect(document.querySelector('.srvword')!.className).toBe('srvword off');
    expect(text('.srvword')).toBe('offline');
    expect(byAct('start-server')).toHaveLength(1);
    expect(byAct('open-server')).toHaveLength(0);
    expect(byAct('stop-server')).toHaveLength(0);
  });

  it('renders a failed row as a fault with the word failed (danger), View logs and Start', () => {
    mount(stateWith([srv(1, 'web', { status: 'failed', host: null, port: null })]));
    expect(document.querySelector('.krow-lead .glyph')!.className).toBe('glyph failed');
    expect(document.querySelector('.krow-lead .glyph')!.getAttribute('aria-label')).toBe('failed');
    expect(document.querySelector('.srvword')!.className).toBe('srvword failed');
    expect(text('.srvword')).toBe('failed');
    expect(byAct('start-server')).toHaveLength(1);
    expect(byAct('server-logs-request')).toHaveLength(2); // header + the failed row's own
  });

  it('gives each icon action a matching aria-label and title, with the hue by tone', () => {
    mount(stateWith([srv(1, 'web')]));
    const expected: Array<[string, string, string]> = [
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

  it('titles the name with the service', () => {
    mount(stateWith([srv(1, 'web/admin')]));
    expect(document.querySelector('.srvname')!.getAttribute('title')).toBe('web/admin');
  });

  it('shows no group header for a ticket-only stack', () => {
    mount(stateWith([srv(1, 'web')]));
    expect(document.querySelector('.sec-group')).toBeNull();
  });

  it('groups own rows under Ticket services and the shared ones under Shared services, with the new notes', () => {
    mount(stateWith([srv(1, 'web')], [shared('db', { baseBranch: 'main' })]));
    const heads = [...document.querySelectorAll('.sec-group')];
    expect(heads.map((h) => h.querySelector('.gname')!.textContent)).toEqual(['Ticket services', 'Shared services']);
    expect(heads.map((h) => h.querySelector('.gcount')!.textContent)).toEqual(['1', '1']);
    expect(heads[0]!.querySelector('.gnote')!.textContent).toBe("run from this ticket's worktrees");
    expect(heads[1]!.querySelector('.gnote')!.textContent).toBe('reused across tickets · not touched by header actions');
  });

  it('keeps a shared-only stack truthful: a "No ticket services" row, no empty state', () => {
    mount(stateWith([], [shared('db')]));
    expect(text('.srvnone')).toBe('No ticket services — only shared ones are in scope.');
    expect(document.querySelector('.estate')).toBeNull();
    expect(document.querySelector('.sec-group .gcount')!.textContent).toBe('0');
  });

  it('renders a shared row read-only: branch pill, address, sub-line, Logs when it has a file, always Manage', () => {
    mount(stateWith([], [shared('db')]));
    expect(text('.srvname')).toBe('db');
    expect(document.querySelector('.srvname')!.getAttribute('title')).toBe('db');
    expect(text('.srvbranch')).toBe('main');
    expect(document.querySelector('.srvbranch')!.className).toBe('srvbranch k-chip');
    expect(text('.krow-sub .srvnote')).toBe('shared with T9');
    expect(byAct('open-server')).toHaveLength(1);
    expect(byAct('server-logs-request')).toHaveLength(2); // header + the row's own Logs
    expect(byAct('open-resources')).toHaveLength(1);
    expect(byAct('stop-server')).toHaveLength(0);
    expect(byAct('start-server')).toHaveLength(0);
    expect(byAct('copy-server-url')).toHaveLength(0);
  });

  it('shows a missing shared row with its word, a danger reason, and no Open or row Logs', () => {
    mount(stateWith([], [shared('db', { status: 'missing', id: null, host: null, port: null, logPath: null, baseBranch: null, missingReason: 'left the manifest' })]));
    expect(document.querySelector('.krow-lead .glyph')!.className).toBe('glyph failed');
    expect(document.querySelector('.krow-lead .glyph')!.getAttribute('aria-label')).toBe('missing');
    expect(text('.srvword')).toBe('missing');
    expect(document.querySelector('.srvword')!.className).toBe('srvword failed');
    expect(text('.krow-sub .srvnote')).toBe('left the manifest');
    expect(document.querySelector('.krow-sub .srvnote')!.className).toBe('srvnote fault');
    expect(document.querySelector('.srvbranch')).toBeNull();
    expect(byAct('open-server')).toHaveLength(0);
    expect(byAct('server-logs-request')).toHaveLength(1); // header only
    expect(byAct('open-resources')).toHaveLength(1);
  });

  it('words a stopped shared row "stopped" with the off dot', () => {
    mount(stateWith([], [shared('db', { status: 'stopped', host: null, port: null })]));
    expect(document.querySelector('.krow-lead .glyph')!.className).toBe('glyph off');
    expect(text('.srvword')).toBe('stopped');
  });

  it('offers View logs on a shared row only when it has a logPath', () => {
    mount(stateWith([], [shared('db', { logPath: null })]));
    expect(byAct('server-logs-request')).toHaveLength(1);
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
    expect(document.querySelectorAll('.sec-group')).toHaveLength(1);
    fireEvent.change(filterBox(), { target: { value: 'svc-d' } });
    expect(names()).toEqual(['svc-db']);
    expect(text('.sec-group .gname')).toBe('Shared services');
  });

  it('says so when nothing matches, quoting what was typed', () => {
    mount(stateWith(many(8)));
    fireEvent.change(filterBox(), { target: { value: 'zzz' } });
    expect(text('.nomatch')).toBe('No service matches “zzz”.');
    expect(document.querySelectorAll('.sec-group')).toHaveLength(0);
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

