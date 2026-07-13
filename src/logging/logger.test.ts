import { describe, it, expect } from 'vitest';
import { makeLogger, type LogSink } from './logger.js';

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
});
