import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ServerLogsReader, SERVER_LOG_READ_CAP_BYTES } from './serverLogsReader.js';

let reader: ServerLogsReader;
let dir: string;

afterEach(() => {
  reader?.stopPolling(1);
  reader?.stopPolling(2);
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe('ServerLogsReader', () => {
  it('reads a single server log file content', () => {
    dir = mkdtempSync(join(tmpdir(), 'karst-srvlog-'));
    const logPath = join(dir, 'app.log');
    writeFileSync(logPath, 'line1\nline2\n');
    reader = new ServerLogsReader();

    const result = reader.readLogs([{ service: 'web', logPath }]);
    expect(result.servers).toHaveLength(1);
    expect(result.servers[0]!.content).toBe('line1\nline2\n');
    expect(result.servers[0]!.truncated).toBe(false);
  });

  it('handles missing logPath gracefully', () => {
    reader = new ServerLogsReader();
    const result = reader.readLogs([{ service: 'web', logPath: null }]);
    expect(result.servers[0]!.content).toBe('');
    expect(result.servers[0]!.truncated).toBe(false);
  });

  it('handles missing file on disk gracefully', () => {
    reader = new ServerLogsReader();
    const result = reader.readLogs([{ service: 'web', logPath: '/tmp/no-such-file-abc123.log' }]);
    expect(result.servers[0]!.content).toBe('');
    expect(result.servers[0]!.truncated).toBe(false);
  });

  it('caps oversized files at 2 MB', () => {
    dir = mkdtempSync(join(tmpdir(), 'karst-srvlog-'));
    const logPath = join(dir, 'big.log');
    writeFileSync(logPath, 'x'.repeat(SERVER_LOG_READ_CAP_BYTES + 500));
    reader = new ServerLogsReader();

    const result = reader.readLogs([{ service: 'web', logPath }]);
    expect(result.servers[0]!.truncated).toBe(true);
    expect(result.servers[0]!.content).toContain('[server log truncated]');
  });

  it('returns multiple servers', () => {
    dir = mkdtempSync(join(tmpdir(), 'karst-srvlog-'));
    writeFileSync(join(dir, 'a.log'), 'aaa');
    writeFileSync(join(dir, 'b.log'), 'bbb');
    reader = new ServerLogsReader();

    const result = reader.readLogs([
      { service: 'api', logPath: join(dir, 'a.log') },
      { service: 'worker', logPath: join(dir, 'b.log') },
    ]);
    expect(result.servers).toHaveLength(2);
    expect(result.servers[0]!.content).toBe('aaa');
    expect(result.servers[1]!.content).toBe('bbb');
  });

  it('polling reads new content and calls onOutput', async () => {
    dir = mkdtempSync(join(tmpdir(), 'karst-srvlog-'));
    const logPath = join(dir, 'poll.log');
    writeFileSync(logPath, 'initial\n');
    reader = new ServerLogsReader();
    const calls: Array<{ ticketId: number; service: string; text: string }> = [];

    reader.startPolling(
      [{ service: 'web', logPath }],
      1,
      (ticketId, service, text) => calls.push({ ticketId, service, text }),
    );

    await new Promise((r) => setTimeout(r, 1200));
    writeFileSync(logPath, 'initial\nnew line\n');
    await new Promise((r) => setTimeout(r, 1200));

    expect(calls.length).toBeGreaterThanOrEqual(1);
    expect(calls.some((c) => c.text.includes('new line'))).toBe(true);
    expect(calls[0]!.ticketId).toBe(1);
    expect(calls[0]!.service).toBe('web');
  });

  it('stopPolling clears the interval', async () => {
    dir = mkdtempSync(join(tmpdir(), 'karst-srvlog-'));
    const logPath = join(dir, 'stop.log');
    writeFileSync(logPath, 'a\n');
    reader = new ServerLogsReader();
    const calls: Array<string> = [];

    reader.startPolling(
      [{ service: 'web', logPath }],
      1,
      (_tid, _svc, text) => calls.push(text),
    );

    await new Promise((r) => setTimeout(r, 1200));
    reader.stopPolling(1);
    const countBefore = calls.length;
    writeFileSync(logPath, 'a\nb\n');
    await new Promise((r) => setTimeout(r, 1500));

    expect(calls.length).toBe(countBefore);
  });
});
