import { describe, expect, it, vi } from 'vitest';
import type { ServerLogsResult } from '../dashboard/serverLogsReader.js';
import {
  ServerLogsManager,
  type ServerLogsPanel,
  type ServerLogsPanelHost,
  type ServerLogsSource,
} from './panel.js';
import type { ServerLogsHostMessage } from './messages.js';

class FakePanel implements ServerLogsPanel {
  revealed = 0;
  posted: ServerLogsHostMessage[] = [];
  private messageHandler?: (message: unknown) => void;
  private disposeHandler?: () => void;

  constructor(
    readonly title: string,
    readonly ticketId: number,
  ) {}

  reveal(): void { this.revealed += 1; }
  postMessage(message: ServerLogsHostMessage): void { this.posted.push(message); }
  onDidReceiveMessage(handler: (message: unknown) => void): void { this.messageHandler = handler; }
  onDidDispose(handler: () => void): void { this.disposeHandler = handler; }
  emit(message: unknown): void { this.messageHandler?.(message); }
  dispose(): void { this.disposeHandler?.(); }
}

function makeHost(): { host: ServerLogsPanelHost; panels: FakePanel[] } {
  const panels: FakePanel[] = [];
  return {
    host: {
      createPanel: (title, ticketId) => {
        const panel = new FakePanel(title, ticketId);
        panels.push(panel);
        return panel;
      },
    },
    panels,
  };
}

interface FakeReader {
  reader: ServerLogsSource;
  readLogs: ReturnType<typeof vi.fn>;
  startPolling: ReturnType<typeof vi.fn>;
  stopPolling: ReturnType<typeof vi.fn>;
}

function makeReader(): FakeReader {
  const readLogs = vi.fn(
    (servers: Array<{ service: string; logPath: string | null }>): ServerLogsResult => ({
      servers: servers.map((s) => ({
        service: s.service,
        logPath: s.logPath,
        content: `log:${s.service}`,
        truncated: false,
      })),
    }),
  );
  const startPolling = vi.fn();
  const stopPolling = vi.fn();
  return { reader: { readLogs, startPolling, stopPolling }, readLogs, startPolling, stopPolling };
}

const WEB = { service: 'web', logPath: '/tmp/web.log' };

describe('ServerLogsManager', () => {
  it('opens a panel titled from the ticket, and a second open only reveals it', () => {
    const { host, panels } = makeHost();
    const { reader } = makeReader();
    const manager = new ServerLogsManager(host, reader, (id) => `Server Logs — T${id}`, () => [WEB]);

    manager.open(41);
    manager.open(41);

    expect(panels).toHaveLength(1);
    expect(panels[0]!.title).toBe('Server Logs — T41');
    expect(panels[0]!.ticketId).toBe(41);
    expect(panels[0]!.revealed).toBe(1);
    expect(manager.isOpen(41)).toBe(true);
  });

  it('reads and starts polling on server-logs-request, then posts the snapshot', () => {
    const { host, panels } = makeHost();
    const { reader, readLogs, startPolling } = makeReader();
    const manager = new ServerLogsManager(host, reader, (id) => `Logs ${id}`, () => [WEB]);

    manager.open(41);
    panels[0]!.emit({ type: 'server-logs-request' });

    expect(readLogs).toHaveBeenCalledWith([WEB]);
    expect(panels[0]!.posted).toContainEqual({
      type: 'server-logs',
      servers: [{ service: 'web', logPath: '/tmp/web.log', content: 'log:web', truncated: false }],
    });
    expect(startPolling).toHaveBeenCalledWith([WEB], 41, expect.any(Function));
  });

  it('routes polled output to the matching ticket panel only', () => {
    const { host, panels } = makeHost();
    const { reader, startPolling } = makeReader();
    const manager = new ServerLogsManager(host, reader, (id) => `Logs ${id}`, () => [WEB]);

    manager.open(41);
    manager.open(42);
    panels[0]!.emit({ type: 'server-logs-request' });

    const onOutput = startPolling.mock.calls[0]![2] as (
      id: number,
      service: string,
      text: string,
    ) => void;
    onOutput(41, 'web', 'chunk A');
    onOutput(99, 'web', 'chunk B');

    expect(panels[0]!.posted).toContainEqual({ type: 'server-log-output', service: 'web', text: 'chunk A' });
    expect(panels[0]!.posted.some((m) => m.type === 'server-log-output' && m.text === 'chunk B')).toBe(false);
    expect(panels[1]!.posted).toEqual([]);
  });

  it('stops polling on server-logs-close', () => {
    const { host, panels } = makeHost();
    const { reader, stopPolling } = makeReader();
    const manager = new ServerLogsManager(host, reader, (id) => `Logs ${id}`, () => [WEB]);

    manager.open(41);
    panels[0]!.emit({ type: 'server-logs-close' });

    expect(stopPolling).toHaveBeenCalledWith(41);
  });

  it('stops polling and drops the entry when the panel is disposed', () => {
    const { host, panels } = makeHost();
    const { reader, stopPolling } = makeReader();
    const manager = new ServerLogsManager(host, reader, (id) => `Logs ${id}`, () => [WEB]);

    manager.open(41);
    panels[0]!.dispose();

    expect(stopPolling).toHaveBeenCalledWith(41);
    expect(manager.isOpen(41)).toBe(false);

    manager.open(41);
    expect(panels).toHaveLength(2);
  });

  it('opens on a ticket with no services and posts the empty snapshot', () => {
    const { host, panels } = makeHost();
    const { reader, readLogs, startPolling } = makeReader();
    const manager = new ServerLogsManager(host, reader, (id) => `Logs ${id}`, () => []);

    manager.open(41);
    panels[0]!.emit({ type: 'server-logs-request' });

    expect(readLogs).toHaveBeenCalledWith([]);
    expect(panels[0]!.posted).toContainEqual({ type: 'server-logs', servers: [] });
    expect(startPolling).toHaveBeenCalledWith([], 41, expect.any(Function));
  });

  it('ignores an unrecognised message', () => {
    const { host, panels } = makeHost();
    const { reader, readLogs, stopPolling } = makeReader();
    const manager = new ServerLogsManager(host, reader, (id) => `Logs ${id}`, () => [WEB]);

    manager.open(41);
    panels[0]!.emit({ type: 'server-logs' });
    panels[0]!.emit({ type: 'server-logs-tab', tab: 'web' });

    expect(panels[0]!.posted).toEqual([]);
    expect(readLogs).not.toHaveBeenCalled();
    expect(stopPolling).not.toHaveBeenCalled();
  });

  it('gives each detached ticket its own panel entry', () => {
    const { host, panels } = makeHost();
    const { reader } = makeReader();
    const manager = new ServerLogsManager(host, reader, (id) => `Logs ${id}`, () => [WEB]);

    manager.open(41);
    manager.open(42);

    expect(panels).toHaveLength(2);
    expect(manager.isOpen(41)).toBe(true);
    expect(manager.isOpen(42)).toBe(true);
  });

  it('dispose stops every ticket and clears the sessions', () => {
    const { host, panels } = makeHost();
    const { reader, stopPolling } = makeReader();
    const manager = new ServerLogsManager(host, reader, (id) => `Logs ${id}`, () => [WEB]);

    manager.open(41);
    manager.open(42);
    manager.dispose();

    expect(stopPolling).toHaveBeenCalledWith(41);
    expect(stopPolling).toHaveBeenCalledWith(42);
    expect(manager.isOpen(41)).toBe(false);
    expect(manager.isOpen(42)).toBe(false);
    // The panels themselves were not disposed by the manager (the host owns them).
    expect(panels).toHaveLength(2);
  });
});
