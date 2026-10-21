import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { GATE_CONSOLE_FLUSH_MS, GATE_CONSOLE_MAX_BUFFER, GateConsole } from './gateConsole.js';

function sink() {
  const posted: { ticketId: number; stage: string; text: string }[] = [];
  const debugLines: string[] = [];
  const console = new GateConsole({
    onOutput: (ticketId, stage, text) => posted.push({ ticketId, stage, text }),
    debug: (m) => debugLines.push(m),
  });
  return { console, posted, debugLines };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('GateConsole', () => {
  it('batches chunks inside the window into one post and one debug line', () => {
    const { console, posted, debugLines } = sink();
    console.append(7, 'uat', 'visual', { stream: 'stdout', text: 'a\n' });
    console.append(7, 'uat', 'visual', { stream: 'stderr', text: 'b\n' });
    console.append(7, 'uat', 'visual', { stream: 'stdout', text: 'c\n' });
    expect(posted).toEqual([]);
    vi.advanceTimersByTime(GATE_CONSOLE_FLUSH_MS);
    expect(posted).toEqual([{ ticketId: 7, stage: 'uat', text: '\n$ visual\na\nb\nc\n' }]);
    expect(debugLines).toEqual(['[gate] console uat ticket 7: visual +6 chars in 3 chunks']);
  });

  it('does not flush before the window elapses', () => {
    const { console, posted } = sink();
    console.append(7, 'uat', 'unit', { stream: 'stdout', text: 'a' });
    vi.advanceTimersByTime(GATE_CONSOLE_FLUSH_MS - 1);
    expect(posted).toEqual([]);
  });

  it('flushes the old gate before the new gate header', () => {
    const { console, posted } = sink();
    console.append(7, 'uat', 'unit', { stream: 'stdout', text: 'a' });
    console.append(7, 'uat', 'lint', { stream: 'stdout', text: 'b' });
    expect(posted.map((p) => p.text)).toEqual(['\n$ unit\na']);
    console.flush(7, 'uat');
    expect(posted.map((p) => p.text)).toEqual(['\n$ unit\na', '\n$ lint\nb']);
  });

  it('flush posts the pending buffer synchronously and cancels the timer', () => {
    const { console, posted } = sink();
    console.append(7, 'uat', 'unit', { stream: 'stdout', text: 'a' });
    console.flush(7, 'uat');
    expect(posted).toHaveLength(1);
    vi.advanceTimersByTime(GATE_CONSOLE_FLUSH_MS * 2);
    expect(posted).toHaveLength(1);
  });

  it('flush with nothing pending posts nothing', () => {
    const { console, posted, debugLines } = sink();
    console.flush(7, 'uat');
    expect(posted).toEqual([]);
    expect(debugLines).toEqual([]);
  });

  it('flushes early once the buffer reaches the size cap', () => {
    const { console, posted } = sink();
    console.append(7, 'uat', 'unit', { stream: 'stdout', text: 'x'.repeat(GATE_CONSOLE_MAX_BUFFER) });
    expect(posted).toHaveLength(1);
    vi.advanceTimersByTime(GATE_CONSOLE_FLUSH_MS);
    expect(posted).toHaveLength(1);
  });

  it('keeps the header once per gate across flushes', () => {
    const { console, posted } = sink();
    console.append(7, 'uat', 'unit', { stream: 'stdout', text: 'a' });
    vi.advanceTimersByTime(GATE_CONSOLE_FLUSH_MS);
    console.append(7, 'uat', 'unit', { stream: 'stdout', text: 'b' });
    vi.advanceTimersByTime(GATE_CONSOLE_FLUSH_MS);
    expect(posted.map((p) => p.text)).toEqual(['\n$ unit\na', 'b']);
  });

  it('strips control sequences that would hijack the console', () => {
    const { console, posted } = sink();
    console.append(7, 'review', 'lint', { stream: 'stdout', text: '\x1b]0;pwned\x07\x1b[2Jok\x1b[32mgreen\x1b[0m' });
    console.flush(7, 'review');
    expect(posted[0]!.text).toBe('\n$ lint\nok\x1b[32mgreen\x1b[0m');
  });

  it('drops a chunk that sanitizes to nothing — no header, no post, no timer', () => {
    const { console, posted } = sink();
    console.append(7, 'uat', 'unit', { stream: 'stdout', text: '\x1b[2J' });
    vi.advanceTimersByTime(GATE_CONSOLE_FLUSH_MS);
    expect(posted).toEqual([]);
  });

  it('keeps each ticket/stage buffer independent', () => {
    const { console, posted } = sink();
    console.append(7, 'uat', 'unit', { stream: 'stdout', text: 'a' });
    console.append(8, 'uat', 'unit', { stream: 'stdout', text: 'b' });
    console.append(7, 'review', 'unit', { stream: 'stdout', text: 'c' });
    vi.advanceTimersByTime(GATE_CONSOLE_FLUSH_MS);
    expect(posted.map((p) => [p.ticketId, p.stage, p.text])).toEqual([
      [7, 'uat', '\n$ unit\na'],
      [8, 'uat', '\n$ unit\nb'],
      [7, 'review', '\n$ unit\nc'],
    ]);
  });

  it('reset flushes pending output, then re-headers the next chunk', () => {
    const { console, posted } = sink();
    console.append(7, 'uat', 'unit', { stream: 'stdout', text: 'a' });
    console.reset(7, 'uat');
    expect(posted.map((p) => p.text)).toEqual(['\n$ unit\na']);
    console.append(7, 'uat', 'unit', { stream: 'stdout', text: 'b' });
    console.flush(7, 'uat');
    expect(posted.map((p) => p.text)).toEqual(['\n$ unit\na', '\n$ unit\nb']);
  });

  it('never throws when the live sink does, and logs the failure', () => {
    const debugLines: string[] = [];
    const console = new GateConsole({
      onOutput: () => {
        throw new Error('panel gone');
      },
      debug: (m) => debugLines.push(m),
    });
    console.append(1, 'uat', 'unit', { stream: 'stdout', text: 'a' });
    expect(() => console.flush(1, 'uat')).not.toThrow();
    expect(debugLines.some((l) => l.includes('live post failed (panel gone)'))).toBe(true);
  });

  it('dispose cancels timers without posting', () => {
    const { console, posted } = sink();
    console.append(7, 'uat', 'unit', { stream: 'stdout', text: 'a' });
    console.dispose();
    vi.advanceTimersByTime(GATE_CONSOLE_FLUSH_MS * 2);
    expect(posted).toEqual([]);
  });

  it('flushTicket and resetTicket cover both uat and review', () => {
    const { console, posted } = sink();
    console.append(7, 'uat', 'unit', { stream: 'stdout', text: 'a' });
    console.append(7, 'review', 'unit', { stream: 'stdout', text: 'b' });
    console.flushTicket(7);
    expect(posted.map((p) => p.stage)).toEqual(['uat', 'review']);
    console.append(7, 'uat', 'unit', { stream: 'stdout', text: 'c' });
    console.resetTicket(7);
    console.append(7, 'uat', 'unit', { stream: 'stdout', text: 'd' });
    console.flushTicket(7);
    expect(posted.slice(2).map((p) => p.text)).toEqual(['c', '\n$ unit\nd']);
  });
});
