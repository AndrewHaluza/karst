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

  it('suppresses debug entirely while disabled — no channel line, no capture', () => {
    const sink = fakeSink();
    const capture = makeBoundedLogBuffer({ maxEntries: 100, maxBytes: 4096 });
    const log = makeLogger(sink, FIXED, capture);
    log.debug('[driver] entering loop');

    expect(sink.lines).toEqual([]);
    expect(capture.snapshot()).toEqual([]);
  });

  it('writes debug lines to the channel and buffer once enabled', () => {
    const sink = fakeSink();
    const capture = makeBoundedLogBuffer({ maxEntries: 100, maxBytes: 4096 });
    const log = makeLogger(sink, FIXED, capture);
    log.setDebugEnabled(true);
    log.debug('[driver] entering loop');
    log.info('ordinary line');

    expect(sink.lines).toEqual([
      '[2026-07-13T10:00:00.000Z] DEBUG [driver] entering loop',
      '[2026-07-13T10:00:00.000Z] INFO ordinary line',
    ]);
    expect(capture.snapshot().map((entry) => entry.level)).toEqual(['debug', 'info']);
  });

  it('toggles back off: a later debug call is a no-op again', () => {
    const sink = fakeSink();
    const log = makeLogger(sink, FIXED);
    log.setDebugEnabled(true);
    log.debug('one');
    log.setDebugEnabled(false);
    log.debug('two');

    expect(sink.lines).toEqual([
      '[2026-07-13T10:00:00.000Z] DEBUG one',
    ]);
  });

  it('sanitizes debug entries captured to the buffer like every other level', () => {
    const sink = fakeSink();
    const capture = makeBoundedLogBuffer({ maxEntries: 100, maxBytes: 4096 });
    const log = makeLogger(sink, FIXED, capture);
    log.setDebugEnabled(true);
    log.debug('[agent:claude] token=super-secret-value');

    const captured = JSON.stringify(capture.snapshot());
    expect(captured).not.toContain('super-secret-value');
    expect(captured).toContain('[REDACTED:assignment]');
  });

  it('isDebugEnabled reads the same live flag debug gates on', () => {
    const sink = fakeSink();
    const log = makeLogger(sink, FIXED);
    expect(log.isDebugEnabled()).toBe(false);
    log.setDebugEnabled(true);
    expect(log.isDebugEnabled()).toBe(true);
    log.setDebugEnabled(false);
    expect(log.isDebugEnabled()).toBe(false);
  });
});

describe('makeBoundedLogBuffer — debug retention', () => {
  it('keeps entries beyond the normal count once debug retention is on', () => {
    const capture = makeBoundedLogBuffer({ maxEntries: 2, maxBytes: 4096 });
    for (let i = 0; i < 4; i += 1) {
      capture.capture({ timestamp: String(i), level: 'debug', message: `d${i}` });
    }
    expect(capture.snapshot().map((entry) => entry.message)).toEqual(['d2', 'd3']);

    capture.setDebugRetention(true);
    for (let i = 4; i < 10; i += 1) {
      capture.capture({ timestamp: String(i), level: 'debug', message: `d${i}` });
    }
    // Debug retention is DIAGNOSTIC_LIMITS.debugLogEntries (2000), so nothing
    // that fits is evicted — the pre-toggle entries survive alongside the new.
    expect(capture.snapshot().map((entry) => entry.message)).toEqual([
      'd2', 'd3', 'd4', 'd5', 'd6', 'd7', 'd8', 'd9',
    ]);
  });

  it('restores the normal limits when debug retention is turned back off', () => {
    const capture = makeBoundedLogBuffer({ maxEntries: 2, maxBytes: 4096 });
    capture.setDebugRetention(true);
    capture.capture({ timestamp: '0', level: 'debug', message: 'a' });
    capture.capture({ timestamp: '1', level: 'debug', message: 'b' });
    capture.capture({ timestamp: '2', level: 'debug', message: 'c' });
    capture.capture({ timestamp: '3', level: 'debug', message: 'd' });
    expect(capture.snapshot().map((entry) => entry.message)).toEqual([
      'a', 'b', 'c', 'd',
    ]);

    capture.setDebugRetention(false);
    capture.capture({ timestamp: '4', level: 'debug', message: 'e' });
    // The normal 2-entry limit applies again: only the two newest survive.
    expect(capture.snapshot().map((entry) => entry.message)).toEqual(['d', 'e']);
  });

  it('a logger toggling debug also raises the buffer it was given', () => {
    const sink = fakeSink();
    const capture = makeBoundedLogBuffer({ maxEntries: 2, maxBytes: 4096 });
    const log = makeLogger(sink, FIXED, capture);
    log.setDebugEnabled(true);
    for (let i = 0; i < 4; i += 1) {
      log.debug(`[runtime] step ${i}`);
    }
    expect(capture.snapshot()).toHaveLength(4);
    log.setDebugEnabled(false);
    log.debug('[runtime] step 4');
    expect(capture.snapshot()).toHaveLength(4); // no new capture while disabled
  });
});

describe('makeBoundedLogBuffer — level-aware eviction', () => {
  it('evicts the oldest debug entry before any info or warn', () => {
    const capture = makeBoundedLogBuffer({ maxEntries: 3, maxBytes: 4096 });
    capture.capture({ timestamp: '0', level: 'warn', message: 'keep me' });
    capture.capture({ timestamp: '1', level: 'info', message: 'i1' });
    capture.capture({ timestamp: '2', level: 'debug', message: 'd1' });
    capture.capture({ timestamp: '3', level: 'debug', message: 'd2' });
    // Over the 3-entry cap: the oldest debug (d1) yields, never the warn.
    expect(capture.snapshot().map((entry) => entry.message)).toEqual(['keep me', 'i1', 'd2']);
  });

  it('falls back to the oldest info once no debug remains', () => {
    const capture = makeBoundedLogBuffer({ maxEntries: 2, maxBytes: 4096 });
    capture.capture({ timestamp: '0', level: 'info', message: 'i1' });
    capture.capture({ timestamp: '1', level: 'warn', message: 'w1' });
    capture.capture({ timestamp: '2', level: 'error', message: 'e1' });
    // No debug in the buffer: the oldest info goes before the warn/error pair.
    expect(capture.snapshot().map((entry) => entry.message)).toEqual(['w1', 'e1']);
  });

  it('an earlier warn survives a full debug flood at the default limits', () => {
    const capture = makeBoundedLogBuffer();
    capture.capture({ timestamp: '2026-07-13T09:00:00.000Z', level: 'warn', message: 'UAT spin failed' });
    for (let i = 0; i < 2000; i += 1) {
      capture.capture({
        timestamp: `2026-07-13T10:${String(Math.floor(i / 60) % 60).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}.000Z`,
        level: 'debug',
        message: `[driver] delivery T${i}: notes deferred`,
      });
    }
    const messages = capture.snapshot().map((entry) => entry.message);
    expect(messages).toContain('UAT spin failed');
    expect(capture.snapshot().length).toBeLessThanOrEqual(500);
  });

  it('keeps the newest warn/error entries when only those overflow', () => {
    const capture = makeBoundedLogBuffer({ maxEntries: 2, maxBytes: 4096 });
    capture.capture({ timestamp: '0', level: 'warn', message: 'w1' });
    capture.capture({ timestamp: '1', level: 'error', message: 'e1' });
    capture.capture({ timestamp: '2', level: 'error', message: 'e2' });
    // No lower level available: FIFO applies to warn/error too.
    expect(capture.snapshot().map((entry) => entry.message)).toEqual(['e1', 'e2']);
  });

  it('protects ticket-evidence debug lines from a plain debug flood', () => {
    // The spin/gate/merge evidence a report needs is emitted at debug level,
    // so level alone would lose it to `[driver]` chatter.
    const capture = makeBoundedLogBuffer();
    capture.capture({ timestamp: '2026-07-13T09:00:00.000Z', level: 'debug', message: '[gate] test:unit failed' });
    capture.capture({ timestamp: '2026-07-13T09:00:01.000Z', level: 'debug', message: '[merge] pr feedback: changes_requested' });
    capture.capture({ timestamp: '2026-07-13T09:00:02.000Z', level: 'debug', message: '[runtime] service came up' });
    for (let i = 0; i < 2000; i += 1) {
      capture.capture({
        timestamp: `2026-07-13T10:${String(Math.floor(i / 60) % 60).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}.000Z`,
        level: 'debug',
        message: `[driver] delivery T${i}: notes deferred`,
      });
    }
    const messages = capture.snapshot().map((entry) => entry.message);
    expect(messages).toContain('[gate] test:unit failed');
    expect(messages).toContain('[merge] pr feedback: changes_requested');
    expect(messages).toContain('[runtime] service came up');
  });

  it('evicts evidence debug lines once no plain debug line remains', () => {
    const capture = makeBoundedLogBuffer({ maxEntries: 2, maxBytes: 4096 });
    capture.capture({ timestamp: '0', level: 'debug', message: '[runtime] one' });
    capture.capture({ timestamp: '1', level: 'debug', message: '[runtime] two' });
    capture.capture({ timestamp: '2', level: 'debug', message: '[runtime] three' });
    // Nothing but evidence debug: FIFO within the level applies.
    expect(capture.snapshot().map((entry) => entry.message)).toEqual(['[runtime] two', '[runtime] three']);
  });

  it('admits fresh evidence when the buffer is saturated with warn/error', () => {
    // A repeating warning must not pin the buffer: the fresh evidence is newer
    // and the oldest warning yields, rather than the evidence self-evicting.
    const capture = makeBoundedLogBuffer({ maxEntries: 5, maxBytes: 4096 });
    for (let i = 0; i < 5; i += 1) {
      capture.capture({ timestamp: String(i), level: 'warn', message: `warn ${i}` });
    }
    capture.capture({ timestamp: '5', level: 'debug', message: '[runtime] fresh spin evidence' });
    const messages = capture.snapshot().map((entry) => entry.message);
    expect(messages).toContain('[runtime] fresh spin evidence');
    expect(messages).not.toContain('warn 0');
    expect(messages).toHaveLength(5);
  });

  it('keeps incoming evidence when the buffer is full of plain info', () => {
    // Evidence is emitted at debug, so a buffer full of ordinary info must
    // evict its oldest info, not the just-captured runtime/gate evidence.
    const capture = makeBoundedLogBuffer({ maxEntries: 5, maxBytes: 4096 });
    for (let i = 0; i < 5; i += 1) {
      capture.capture({ timestamp: String(i), level: 'info', message: `info ${i}` });
    }
    capture.capture({ timestamp: '5', level: 'debug', message: '[runtime] the spin evidence' });
    const messages = capture.snapshot().map((entry) => entry.message);
    expect(messages).toContain('[runtime] the spin evidence');
    expect(messages).not.toContain('info 0');
  });

  it('never drops fresh evidence when the byte cap needs several evictions', () => {
    // Two warns (24 bytes each) leave 48/54 bytes; the 37-byte [runtime] line
    // cannot fit without evicting BOTH warnings, so an index-based guard would
    // go stale and let the incoming evidence evict itself.
    const capture = makeBoundedLogBuffer({ maxEntries: 10, maxBytes: 54 });
    capture.capture({ timestamp: '', level: 'warn', message: 'w'.repeat(20) });
    capture.capture({ timestamp: '', level: 'warn', message: 'w'.repeat(20) });
    capture.capture({ timestamp: '', level: 'debug', message: `[runtime] ${'e'.repeat(22)}` });
    const messages = capture.snapshot().map((entry) => entry.message);
    expect(messages).toHaveLength(1);
    expect(messages[0]!.startsWith('[runtime] ')).toBe(true);
  });

  it('admits every freshly captured evidence line under sustained byte pressure', () => {
    const capture = makeBoundedLogBuffer({ maxEntries: 20, maxBytes: 500 });
    for (let i = 0; i < 2000; i += 1) {
      capture.capture({ timestamp: '', level: 'warn', message: 'w'.repeat(30) });
      const message = `[runtime] evidence ${i}`;
      capture.capture({ timestamp: '', level: 'debug', message });
      // The entry just captured must be present in the snapshot right after,
      // however many older entries had to yield.
      expect(capture.snapshot().some((entry) => entry.message === message)).toBe(true);
    }
  });

  it('drops fresh plain debug rather than displacing a warn', () => {
    const capture = makeBoundedLogBuffer({ maxEntries: 5, maxBytes: 4096 });
    for (let i = 0; i < 5; i += 1) {
      capture.capture({ timestamp: String(i), level: 'warn', message: `warn ${i}` });
    }
    capture.capture({ timestamp: '5', level: 'debug', message: '[driver] delivery T1: notes deferred' });
    const messages = capture.snapshot().map((entry) => entry.message);
    expect(messages).toContain('warn 0');
    expect(messages).not.toContain('[driver] delivery T1: notes deferred');
  });

  it('drops older debug before newer debug and accounts the released bytes', () => {
    const capture = makeBoundedLogBuffer({ maxEntries: 10, maxBytes: 26 });
    // Empty timestamp + level + 4-char message: info 8 bytes, debug 9 bytes.
    capture.capture({ timestamp: '', level: 'info', message: 'aaaa' });
    capture.capture({ timestamp: '', level: 'debug', message: 'dddd' });
    capture.capture({ timestamp: '', level: 'debug', message: 'eeee' });
    // 26 bytes fit these three; the fourth must drop the oldest debug, not the info.
    capture.capture({ timestamp: '', level: 'debug', message: 'ffff' });
    expect(capture.snapshot().map((entry) => entry.message)).toEqual(['aaaa', 'eeee', 'ffff']);
  });
});
