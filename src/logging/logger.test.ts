import { describe, it, expect } from 'vitest';
import {
  makeBoundedLogBuffer,
  makeLogger,
  type DiagnosticLogSink,
  type LogSink,
} from './logger.js';

function fakeSink(): LogSink & { lines: string[] } {
  const lines: string[] = [];
  return { lines, appendLine: (l: string) => lines.push(l) };
}

const FIXED = () => new Date('2026-07-13T10:00:00.000Z');

describe('makeLogger', () => {
  it('writes a timestamped, leveled line for info/warn', () => {
    const sink = fakeSink();
    const log = makeLogger(sink, FIXED);
    log.info('started');
    log.warn('careful');
    expect(sink.lines).toEqual([
      '[2026-07-13T10:00:00.000Z] INFO started',
      '[2026-07-13T10:00:00.000Z] WARN careful',
    ]);
  });

  it('appends the error stack on a second line when given an Error', () => {
    const sink = fakeSink();
    const log = makeLogger(sink, FIXED);
    const err = new Error('boom');
    log.error('spin failed', err);
    expect(sink.lines).toHaveLength(1);
    expect(sink.lines[0]).toContain('[2026-07-13T10:00:00.000Z] ERROR spin failed');
    expect(sink.lines[0]).toContain('boom');
  });

  it('stringifies a non-Error detail and omits detail when none is given', () => {
    const sink = fakeSink();
    const log = makeLogger(sink, FIXED);
    log.error('bad', 'just a string');
    log.error('no detail');
    expect(sink.lines[0]).toContain('just a string');
    expect(sink.lines[1]).toBe('[2026-07-13T10:00:00.000Z] ERROR no detail');
  });

  it('keeps channel bytes and ordering unchanged while capturing sanitized entries', () => {
    const sink = fakeSink();
    const capture = makeBoundedLogBuffer({ maxEntries: 10, maxBytes: 4096 });
    const log = makeLogger(sink, FIXED, capture);
    log.info('started');
    log.warn('token=super-secret-value');
    log.error('spin failed', new Error('Authorization: Bearer abcdefghijklmnop'));

    expect(sink.lines[0]).toBe('[2026-07-13T10:00:00.000Z] INFO started');
    expect(sink.lines[1]).toBe(
      '[2026-07-13T10:00:00.000Z] WARN token=super-secret-value',
    );
    expect(sink.lines[2]).toContain(
      '[2026-07-13T10:00:00.000Z] ERROR spin failed\nError: Authorization: Bearer abcdefghijklmnop',
    );
    expect(capture.snapshot().map((entry) => entry.level)).toEqual([
      'info',
      'warn',
      'error',
    ]);
    const captured = JSON.stringify(capture.snapshot());
    expect(captured).not.toContain('super-secret-value');
    expect(captured).not.toContain('abcdefghijklmnop');
    expect(captured).toContain('[REDACTED:assignment]');
    expect(captured).toContain('[REDACTED:authorization]');
  });

  it('evicts oldest entries by both entry count and UTF-8 byte budget', () => {
    const byCount = makeBoundedLogBuffer({ maxEntries: 2, maxBytes: 4096 });
    byCount.capture({ timestamp: '1', level: 'info', message: 'one' });
    byCount.capture({ timestamp: '2', level: 'info', message: 'two' });
    byCount.capture({ timestamp: '3', level: 'info', message: 'three' });
    expect(byCount.snapshot().map((entry) => entry.message)).toEqual(['two', 'three']);

    const byBytes = makeBoundedLogBuffer({ maxEntries: 10, maxBytes: 12 });
    byBytes.capture({ timestamp: '', level: 'info', message: '1234' });
    byBytes.capture({ timestamp: '', level: 'info', message: 'ééé' });
    expect(byBytes.snapshot().map((entry) => entry.message)).toEqual(['ééé']);
  });

  it('returns isolated snapshots', () => {
    const capture = makeBoundedLogBuffer({ maxEntries: 2, maxBytes: 4096 });
    capture.capture({ timestamp: '1', level: 'info', message: 'one' });
    const snapshot = capture.snapshot() as unknown as Array<{ message: string }>;
    snapshot[0]!.message = 'mutated';
    snapshot.push({ message: 'injected' });
    expect(capture.snapshot()).toEqual([
      { timestamp: '1', level: 'info', message: 'one' },
    ]);
  });

  it('never lets a diagnostic capture failure affect normal logging', () => {
    const sink = fakeSink();
    const capture: DiagnosticLogSink = {
      capture: () => {
        throw new Error('capture failed');
      },
    };
    const log = makeLogger(sink, FIXED, capture);
    expect(() => log.warn('still written')).not.toThrow();
    expect(sink.lines).toEqual([
      '[2026-07-13T10:00:00.000Z] WARN still written',
    ]);
  });
});
