import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, appendFileSync, rmSync, chmodSync } from 'node:fs';

/** Byte length of every positioned read a poll tick makes, so a test can prove the tail reads only the appended range. */
const reads = vi.hoisted(() => [] as number[]);
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      return {
        read: (buf: Buffer, offset: number, length: number, position: number) => {
          reads.push(length);
          return handle.read(buf, offset, length, position);
        },
        close: () => handle.close(),
      };
    },
  };
});
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ServerLogsReader, SERVER_LOG_READ_CAP_BYTES } from './serverLogsReader.js';

let reader: ServerLogsReader;
let dir: string;

/**
 * The poller is an interval over real fs I/O, so fake timers cannot drive it
 * (its callback detaches the async read, which a fake clock never awaits). The
 * poll interval is injected instead — a few ms here — and `waitFor` blocks on
 * the read actually completing rather than on a fixed multi-second idle.
 */
const POLL_MS = 10;

/** Resolve once `cond` holds, polling the real event loop; throws (never hangs) on timeout. */
async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('waitFor: condition not met before timeout');
    await new Promise((r) => setTimeout(r, 5));
  }
}

afterEach(() => {
  reads.length = 0;
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
    expect(result.servers[0]!.state).toBe('no-path');
    expect(result.servers[0]!.message).toBe('web has no log file.');
  });

  it('handles missing file on disk gracefully', () => {
    reader = new ServerLogsReader();
    const result = reader.readLogs([{ service: 'web', logPath: '/tmp/no-such-file-abc123.log' }]);
    expect(result.servers[0]!.content).toBe('');
    expect(result.servers[0]!.truncated).toBe(false);
    expect(result.servers[0]!.state).toBe('empty');
    expect(result.servers[0]!.message).toBe('web has not written to its log yet.');
  });

  it('names an unreadable log file instead of showing it as empty', () => {
    dir = mkdtempSync(join(tmpdir(), 'karst-srvlog-'));
    const logPath = join(dir, 'secret.log');
    writeFileSync(logPath, 'hidden\n');
    chmodSync(logPath, 0o000);
    reader = new ServerLogsReader();

    const result = reader.readLogs([{ service: 'web', logPath }]);
    expect(result.servers[0]!.state).toBe('unreadable');
    expect(result.servers[0]!.message).toBe(`Karst cannot read ${logPath}.`);
    chmodSync(logPath, 0o600);
  });

  it('treats a zero-byte log as not written yet', () => {
    dir = mkdtempSync(join(tmpdir(), 'karst-srvlog-'));
    const logPath = join(dir, 'empty.log');
    writeFileSync(logPath, '');
    reader = new ServerLogsReader();

    const result = reader.readLogs([{ service: 'api', logPath }]);
    expect(result.servers[0]!.state).toBe('empty');
    expect(result.servers[0]!.message).toBe('api has not written to its log yet.');
  });

  /**
   * LG-1: a log over the read cap must show its NEWEST output, not its oldest.
   * The head read showed the first 2 MiB of a 3 MiB log, so the line the user
   * needs (the crash, the last request) was never on screen.
   */
  it('reads the tail of an oversized log and puts the marker first', () => {
    dir = mkdtempSync(join(tmpdir(), 'karst-srvlog-'));
    const logPath = join(dir, 'big.log');
    writeFileSync(logPath, `${'x'.repeat(SERVER_LOG_READ_CAP_BYTES + 500)}\nLAST LINE\n`);
    reader = new ServerLogsReader();

    const result = reader.readLogs([{ service: 'web', logPath }]);
    const content = result.servers[0]!.content;
    expect(result.servers[0]!.truncated).toBe(true);
    expect(result.servers[0]!.state).toBe('ok');
    expect(content.startsWith('[Earlier output not shown: 2.0 MB]')).toBe(true);
    expect(content.endsWith('LAST LINE\n')).toBe(true);
    // The oldest bytes are gone, never the newest.
    expect(content).not.toContain('x'.repeat(1000));
  });

  it('skips a partial first line so the tail opens on a whole line', () => {
    dir = mkdtempSync(join(tmpdir(), 'karst-srvlog-'));
    const logPath = join(dir, 'cut.log');
    writeFileSync(logPath, `${'x'.repeat(SERVER_LOG_READ_CAP_BYTES + 500)}\nA\nB\n`);
    reader = new ServerLogsReader();

    const content = reader.readLogs([{ service: 'web', logPath }]).servers[0]!.content;
    expect(content.includes('x')).toBe(false);
    expect(content).toBe('[Earlier output not shown: 2.0 MB]\nA\nB\n');
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
    reader = new ServerLogsReader(undefined, POLL_MS);
    const calls: Array<{ ticketId: number; service: string; text: string }> = [];

    await reader.startPolling(
      [{ service: 'web', logPath }],
      1,
      (ticketId, service, text) => calls.push({ ticketId, service, text }),
    );
    writeFileSync(logPath, 'initial\nnew line\n');
    await waitFor(() => calls.length >= 1);

    expect(calls.length).toBeGreaterThanOrEqual(1);
    expect(calls.some((c) => c.text.includes('new line'))).toBe(true);
    expect(calls[0]!.ticketId).toBe(1);
    expect(calls[0]!.service).toBe('web');
  });

  /**
   * Two dashboards can be open at once and both consume ONE shared baseline
   * service, so they poll the same log path. Offsets are per TICKET, never per
   * service: a shared counter makes the first poller consume the delta and the
   * second see "nothing new", so a shared service's live tail reaches one
   * dashboard only.
   */
  it('tails one shared log to every open dashboard, not just the first', async () => {
    dir = mkdtempSync(join(tmpdir(), 'karst-srvlog-'));
    const logPath = join(dir, 'shared.log');
    writeFileSync(logPath, 'initial\n');
    reader = new ServerLogsReader(undefined, POLL_MS);
    const one: string[] = [];
    const two: string[] = [];

    await Promise.all([
      reader.startPolling([{ service: 'api', logPath }], 1, (_tid, _svc, text) => one.push(text)),
      reader.startPolling([{ service: 'api', logPath }], 2, (_tid, _svc, text) => two.push(text)),
    ]);
    writeFileSync(logPath, 'initial\nshared line\n');
    await waitFor(() => one.length > 0 && two.length > 0);

    expect(one.join('')).toContain('shared line');
    expect(two.join('')).toContain('shared line');
  });

  it('stopPolling clears the interval', async () => {
    dir = mkdtempSync(join(tmpdir(), 'karst-srvlog-'));
    const logPath = join(dir, 'stop.log');
    writeFileSync(logPath, 'a\n');
    reader = new ServerLogsReader(undefined, POLL_MS);
    const calls: Array<string> = [];

    await reader.startPolling(
      [{ service: 'web', logPath }],
      1,
      (_tid, _svc, text) => calls.push(text),
    );
    reader.stopPolling(1);
    const countBefore = calls.length;
    writeFileSync(logPath, 'a\nb\n');
    await new Promise((r) => setTimeout(r, POLL_MS * 4));

    expect(calls.length).toBe(countBefore);
  });

  /**
   * P2-06 regression: offsets are BYTE lengths, so the live tail must slice
   * bytes, not characters. With a multi-byte prefix a character-index slice
   * skips part of the appended line — here `content.slice(4)` yields `ter\n`,
   * silently dropping the leading `a`.
   */
  it('tails a multi-byte log by byte offset without skipping or re-emitting', async () => {
    dir = mkdtempSync(join(tmpdir(), 'karst-srvlog-'));
    const logPath = join(dir, 'utf8.log');
    writeFileSync(logPath, '\u20ac\n'); // "€\n": 4 bytes, 2 characters
    reader = new ServerLogsReader(undefined, POLL_MS);
    const calls: string[] = [];

    await reader.startPolling(
      [{ service: 'web', logPath }],
      1,
      (_tid, _svc, text) => calls.push(text),
    );
    writeFileSync(logPath, '\u20ac\nafter\n');
    await waitFor(() => calls.length >= 1);

    expect(calls).toEqual(['after\n']);
  });

  /**
   * P2-06 regression: the 2 MiB cap is a BYTE cap. A character-index slice
   * returned `CAP` multi-byte characters — up to 3x the cap in bytes — and could
   * split a character, emitting a replacement character.
   */
  it('enforces the read cap in bytes for multi-byte content', () => {
    dir = mkdtempSync(join(tmpdir(), 'karst-srvlog-'));
    const logPath = join(dir, 'utf8-big.log');
    writeFileSync(logPath, '\u20ac\n'.repeat(SERVER_LOG_READ_CAP_BYTES)); // > the cap in bytes
    reader = new ServerLogsReader();

    const result = reader.readLogs([{ service: 'web', logPath }]);
    expect(result.servers[0]!.truncated).toBe(true);
    const content = result.servers[0]!.content;
    expect(Buffer.byteLength(content, 'utf8')).toBeLessThanOrEqual(
      SERVER_LOG_READ_CAP_BYTES + 64,
    );
    expect(content).not.toContain('\uFFFD');
    expect(content.startsWith('[Earlier output not shown: ')).toBe(true);
  });

  it('a poll tick reads only the appended bytes, not the whole log', async () => {
    dir = mkdtempSync(join(tmpdir(), 'karst-srvlog-'));
    const logPath = join(dir, 'big-tail.log');
    writeFileSync(logPath, 'x'.repeat(500_000));
    reader = new ServerLogsReader(undefined, POLL_MS);
    const calls: string[] = [];

    await reader.startPolling([{ service: 'web', logPath }], 1, (_tid, _svc, text) =>
      calls.push(text),
    );
    appendFileSync(logPath, 'tail\n');
    await waitFor(() => calls.length >= 1);

    expect(calls).toEqual(['tail\n']);
    expect(reads).toEqual([5]);
  });

  it('re-reads from the start, capped, when the log is truncated', async () => {
    dir = mkdtempSync(join(tmpdir(), 'karst-srvlog-'));
    const logPath = join(dir, 'rotated.log');
    writeFileSync(logPath, 'old content that is long\n');
    reader = new ServerLogsReader(undefined, POLL_MS);
    const calls: string[] = [];

    await reader.startPolling([{ service: 'web', logPath }], 1, (_tid, _svc, text) =>
      calls.push(text),
    );
    writeFileSync(logPath, 'new\n');
    await waitFor(() => calls.length >= 1);

    expect(calls).toEqual(['new\n']);
  });

  it('holds back a trailing partial multi-byte character until it completes', async () => {
    dir = mkdtempSync(join(tmpdir(), 'karst-srvlog-'));
    const logPath = join(dir, 'partial.log');
    writeFileSync(logPath, 'a\n');
    reader = new ServerLogsReader(undefined, POLL_MS);
    const calls: string[] = [];

    await reader.startPolling([{ service: 'web', logPath }], 1, (_tid, _svc, text) =>
      calls.push(text),
    );

    // A tick must actually read the partial bytes (and hold them back) before
    // the rest arrives, or the two halves are read together and the partial
    // path is never exercised. The read is the observable signal, not a sleep.
    const euro = Buffer.from('\u20ac');
    const readsBefore = reads.length;
    appendFileSync(logPath, Buffer.concat([Buffer.from('b'), euro.subarray(0, 1)]));
    await waitFor(() => reads.length > readsBefore);
    appendFileSync(logPath, Buffer.concat([euro.subarray(1), Buffer.from('\n')]));
    await waitFor(() => calls.join('') === 'b\u20ac\n');

    expect(calls.join('')).toBe('b\u20ac\n');
    expect(calls.join('')).not.toContain('\uFFFD');
  });
});
