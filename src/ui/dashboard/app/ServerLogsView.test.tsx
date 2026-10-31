// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup } from '@testing-library/react';
import type { DashboardState } from '../state.js';
import { mountOverlays, must, press, type OverlayHarness } from './fixtures/overlaysKit.js';

const state = { ticketId: 7, key: 'FEAT-7', title: 'Seven' } as unknown as DashboardState;

interface Opts {
  post(msg: unknown): void;
  onClose(): void;
}
interface Api {
  open: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  handleInitial: ReturnType<typeof vi.fn>;
  handleOutput: ReturnType<typeof vi.fn>;
}
let created: Array<{ opts: Opts; api: Api }> = [];
let factory: ReturnType<typeof vi.fn>;

beforeEach(() => {
  created = [];
  factory = vi.fn((opts: Opts) => {
    const api: Api = { open: vi.fn(), close: vi.fn(() => opts.onClose()), handleInitial: vi.fn(), handleOutput: vi.fn() };
    created.push({ opts, api });
    return api;
  });
  vi.stubGlobal('createServerLogsView', factory);
});

const open = (h: OverlayHarness): void => h.act(() => h.overlays.openLogs());
const key = press;

describe('ServerLogsView — the thin wrapper over the shared runtime', () => {
  it('opens the shared surface and asks the host for the logs exactly once', () => {
    const h = mountOverlays(state);
    expect(created).toHaveLength(0);
    open(h);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(created[0]!.api.open).toHaveBeenCalledTimes(1);
    expect(h.send.serverLogsRequest).toHaveBeenCalledTimes(1);
    open(h);
    expect(created[0]!.api.open).toHaveBeenCalledTimes(1);
    expect(h.send.serverLogsRequest).toHaveBeenCalledTimes(1);
  });

  it('feeds the host’s answers to the surface while it is open, and only then', () => {
    const h = mountOverlays(state);
    h.emit({ type: 'server-log-output', service: 'web', text: 'before' } as never);
    open(h);
    h.emit({ type: 'server-logs', servers: [{ service: 'web', content: 'a' }] } as never);
    h.emit({ type: 'server-log-output', service: 'web', text: 'b\n' } as never);
    expect(created[0]!.api.handleInitial).toHaveBeenCalledWith([{ service: 'web', content: 'a' }]);
    expect(created[0]!.api.handleOutput.mock.calls).toEqual([['web', 'b\n']]);
  });

  it('tolerates an answer with no servers', () => {
    const h = mountOverlays(state);
    open(h);
    h.emit({ type: 'server-logs' } as never);
    expect(created[0]!.api.handleInitial).toHaveBeenCalledWith([]);
  });

  it('routes the surface’s detach to the typed sender', () => {
    const h = mountOverlays(state);
    open(h);
    created[0]!.opts.post({ type: 'server-logs-detach' });
    created[0]!.opts.post({ type: 'something-else' });
    expect(h.send.serverLogsDetach).toHaveBeenCalledTimes(1);
    expect(h.send.serverLogsClose).not.toHaveBeenCalled();
  });

  it('closes when the surface’s own Close fires: the stack follows and the host hears it once', () => {
    const h = mountOverlays(state);
    open(h);
    created[0]!.opts.onClose();
    expect(h.overlays.getSnapshot().logs).toBe(false);
    expect(h.send.serverLogsClose).toHaveBeenCalledTimes(1);
    expect(created[0]!.api.close).not.toHaveBeenCalled();
  });

  it('closes the surface when the stack closes it (Escape), telling the host once', () => {
    const h = mountOverlays(state);
    open(h);
    key('Escape');
    expect(h.overlays.getSnapshot().logs).toBe(false);
    expect(created[0]!.api.close).toHaveBeenCalledTimes(1);
    expect(h.send.serverLogsClose).toHaveBeenCalledTimes(1);
  });

  it('reuses one surface across opens', () => {
    const h = mountOverlays(state);
    open(h);
    h.act(() => h.overlays.closeLogs());
    open(h);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(created[0]!.api.open).toHaveBeenCalledTimes(2);
    expect(h.send.serverLogsRequest).toHaveBeenCalledTimes(2);
  });

  it('closes the surface if the app goes away while it is open', () => {
    const h = mountOverlays(state);
    open(h);
    cleanup();
    expect(created[0]!.api.close).toHaveBeenCalledTimes(1);
    void h;
  });

  it('pages and jumps the log host by key', () => {
    const h = mountOverlays(state);
    const host = document.createElement('div');
    host.id = 'logsHost';
    Object.defineProperty(host, 'clientHeight', { value: 140 });
    Object.defineProperty(host, 'scrollHeight', { value: 1000 });
    document.body.append(host);
    open(h);
    expect(key('PageDown').defaultPrevented).toBe(true);
    expect(host.scrollTop).toBe(100);
    key('PageUp');
    expect(host.scrollTop).toBe(0);
    key('End');
    expect(host.scrollTop).toBe(1000);
    key('Home');
    expect(host.scrollTop).toBe(0);
    expect(key('Home', { ctrlKey: true }).defaultPrevented).toBe(false);
    expect(must('#logsHost')).toBe(host);
  });
});

describe('ServerLogsView — shared DrillHeader', () => {
  it('asks the runtime for the header slot and fills it with the Back/breadcrumb header', () => {
    const h = mountOverlays(state);
    factory.mockImplementationOnce((opts: Opts) => {
      expect(opts).toMatchObject({ drillHead: true });
      const api: Api = {
        open: vi.fn(() => { must('#logsView').innerHTML = '<div id="logsDrillHead"></div>'; }),
        close: vi.fn(() => opts.onClose()), handleInitial: vi.fn(), handleOutput: vi.fn(),
      };
      return api;
    });
    // A fresh factory identity so the page-level cache builds a new instance.
    vi.stubGlobal('createServerLogsView', factory);
    open(h);
    const head = must('#logsView [data-region="drill-head"]');
    expect(head.textContent).toContain('Server logs');
    expect(must('[data-art="back"]').getAttribute('aria-label')).toBe('Back to Dashboard');
  });
});
