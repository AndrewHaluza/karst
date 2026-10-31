// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent } from '@testing-library/react';
import type { DashboardState } from '../state.js';
import { mount, one, shared, srv, stateWith, installRuntimeDoubles } from './fixtures/serversPanelKit.js';

installRuntimeDoubles();

describe('ServersPanel — actions', () => {
  it.each([
    ['open-server', 'openServer', 1],
    ['copy-server-url', 'copyServerUrl', 1],
    ['restart-server', 'restartServer', 1],
    ['stop-server', 'stopServer', 1],
  ])('%s posts %s with the row id exactly once and goes pending', (act, fn, id) => {
    const h = mount(stateWith([srv(1, 'web')]));
    const btn = one(act, '[data-id="1"]');
    fireEvent.click(btn);
    expect(h.send[fn]).toHaveBeenCalledTimes(1);
    expect(h.send[fn]).toHaveBeenCalledWith(id, 'req-1');
    expect(btn.getAttribute('aria-busy')).toBe('true');
    fireEvent.click(btn);
    expect(h.send[fn]).toHaveBeenCalledTimes(1);
  });

  it('start-server posts the row id of a stopped row', () => {
    const h = mount(stateWith([srv(1, 'a'), srv(2, 'b', { status: 'stopped', host: null, port: null })]));
    fireEvent.click(one('start-server'));
    expect(h.send.startServer).toHaveBeenCalledWith(2, 'req-1');
  });

  it.each([
    ['spin-servers', 'spinServers', [srv(1, 'a', { status: 'stopped', host: null, port: null })]],
    ['restart-servers', 'restartServers', [srv(1, 'a')]],
    ['stop-servers', 'stopServers', [srv(1, 'a')]],
  ])('header %s posts %s once with a request id', (act, fn, servers) => {
    const h = mount(stateWith(servers));
    fireEvent.click(one(act));
    expect(h.send[fn]).toHaveBeenCalledTimes(1);
    expect(h.send[fn]).toHaveBeenCalledWith('req-1');
    fireEvent.click(one(act));
    expect(h.send[fn]).toHaveBeenCalledTimes(1);
  });

  it('a disabled header op posts nothing', () => {
    const h = mount(stateWith([srv(1, 'a')]));
    fireEvent.click(one('spin-servers'));
    expect(h.send.spinServers).not.toHaveBeenCalled();
  });

  it('shared Open posts the baseline row id; Manage posts open-resources', () => {
    const h = mount(stateWith([], [shared('db', { id: 90 })]));
    fireEvent.click(one('open-server'));
    expect(h.send.openServer).toHaveBeenCalledWith(90, 'req-1');
    fireEvent.click(one('open-resources'));
    expect(h.send.openResources).toHaveBeenCalledWith('req-2');
  });

  it('copy flashes the confirmation through data-copied, never a className change', () => {
    vi.useFakeTimers();
    mount(stateWith([srv(1, 'web')]));
    const btn = one('copy-server-url');
    const className = btn.className;
    fireEvent.click(btn);
    expect(btn.hasAttribute('data-copied')).toBe(true);
    expect(btn.getAttribute('aria-label')).toBe('Copied');
    expect(btn.className).toBe(className);
    act(() => {
      vi.advanceTimersByTime(1300);
    });
    expect(btn.hasAttribute('data-copied')).toBe(false);
    expect(btn.getAttribute('aria-label')).toBe('Copy URL');
  });

  it('Logs and Env ops are local: they open their overlay views and post nothing', () => {
    vi.stubGlobal('createServerLogsView', () => ({}));
    const h = mount(stateWith([srv(1, 'web')]));
    expect(h.overlays().getSnapshot()).toMatchObject({ logs: false, env: false });
    fireEvent.click(one('server-logs-request'));
    expect(h.overlays().getSnapshot()).toMatchObject({ logs: true, env: false });
    fireEvent.click(one('env-overrides-open'));
    expect(h.overlays().getSnapshot()).toMatchObject({ logs: false, env: true });
    vi.unstubAllGlobals();
    for (const fn of Object.values(h.send)) expect(fn).not.toHaveBeenCalled();
    expect(one('server-logs-request').hasAttribute('aria-busy')).toBe(false);
  });
});

describe('ServersPanel — slice selection (migration plan A4)', () => {
  it('does not re-render on a live push whose servers slice is structurally unchanged', () => {
    const onRender = vi.fn();
    const h = mount(stateWith([srv(1, 'web')]), null, onRender);
    const before = onRender.mock.calls.length;
    h.emit({ type: 'state', state: { ...stateWith([srv(1, 'web')]), clock: 'tick-1' } as unknown as DashboardState, live: true });
    h.emit({ type: 'state', state: { ...stateWith([srv(1, 'web')]), clock: 'tick-2' } as unknown as DashboardState, live: true });
    expect(onRender.mock.calls.length).toBe(before);

    h.emit({ type: 'state', state: stateWith([srv(1, 'web'), srv(2, 'api')]), live: true });
    expect(onRender.mock.calls.length).toBeGreaterThan(before);
    expect(document.querySelectorAll('td.c-name')).toHaveLength(2);
  });
});
