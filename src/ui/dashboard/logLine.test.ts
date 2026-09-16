import { describe, it, expect } from 'vitest';
import {
  stripAnsi,
  decodeAnsi,
  parseTimestamp,
  toLogLines,
  currentRun,
  compareLines,
  matchesQuery,
} from './logLine.js';
import { runMarkerLine } from '../../runtime/serverLog.js';

describe('decodeAnsi', () => {
  it('a plain line decodes to a single classless segment', () => {
    expect(decodeAnsi('hello world')).toEqual([{ text: 'hello world', classes: [] }]);
  });

  it('\u001b[32minfo\u001b[39m rest decodes to a green segment then a classless one', () => {
    const segments = decodeAnsi('\u001b[32minfo\u001b[39m rest');
    expect(segments).toHaveLength(2);
    expect(segments[0]!.text).toBe('info');
    expect(segments[0]!.classes).toContain('k-ansi-fg-green');
    expect(segments[1]!.text).toBe(' rest');
    expect(segments[1]!.classes).toEqual([]);
  });

  it('\u001b[1m\u001b[31m accumulates bold and red, and \u001b[0m clears both', () => {
    const segments = decodeAnsi('\u001b[1m\u001b[31mred\u001b[0mplain');
    expect(segments[0]!.text).toBe('red');
    expect(segments[0]!.classes).toContain('k-ansi-bold');
    expect(segments[0]!.classes).toContain('k-ansi-fg-red');
    expect(segments[1]!.text).toBe('plain');
    expect(segments[1]!.classes).toEqual([]);
  });

  it('22 clears bold without clearing the foreground colour', () => {
    const segments = decodeAnsi('\u001b[1m\u001b[31m\u001b[22mtext');
    expect(segments).toEqual([{ text: 'text', classes: ['k-ansi-fg-red'] }]);
  });

  it('an unknown code (\u001b[53m) is ignored and emits no class', () => {
    expect(decodeAnsi('\u001b[53mtext')).toEqual([{ text: 'text', classes: [] }]);
  });

  it('38;5;208 consumes its parameters and sets no class', () => {
    expect(decodeAnsi('\u001b[38;5;208mtext')).toEqual([{ text: 'text', classes: [] }]);
  });

  it('a non-SGR CSI sequence (\u001b[2K) is removed and changes no state', () => {
    expect(decodeAnsi('\u001b[31ma\u001b[2Kb')).toEqual([
      { text: 'ab', classes: ['k-ansi-fg-red'] },
    ]);
  });
});

describe('parseTimestamp', () => {
  it('finds the ISO prefix of a real log line and returns null for Server is running on port 3004', () => {
    expect(parseTimestamp('2024-01-02T03:04:05.123Z rest of line')).toBe(
      '2024-01-02T03:04:05.123Z',
    );
    expect(parseTimestamp('Server is running on port 3004')).toBeNull();
  });

  it('still finds it when the line opens with an escape', () => {
    const line = stripAnsi('\u001b[32m2024-01-02T03:04:05.123Z rest');
    expect(parseTimestamp(line)).toBe('2024-01-02T03:04:05.123Z');
  });
});

describe('currentRun', () => {
  it('returns only the tail after the last marker', () => {
    const marker = runMarkerLine('web', '2024-01-02T03:04:05Z');
    const lines = toLogLines('web', ['old', marker, 'new', 'more'].join('\n'), 0);
    expect(currentRun(lines).map((l) => l.plain)).toEqual([marker, 'new', 'more']);
  });

  it('returns every line when the text carries no marker', () => {
    const lines = toLogLines('web', 'a\nb\nc', 0);
    expect(currentRun(lines).map((l) => l.plain)).toEqual(['a', 'b', 'c']);
  });
});

describe('compareLines', () => {
  it('orders a stamped line before an unstamped one', () => {
    const stamped = toLogLines('web', '2024-01-02T03:04:05Z hi', 0)[0]!;
    const unstamped = toLogLines('web', 'hi', 1)[0]!;
    expect(compareLines(stamped, unstamped)).toBeLessThan(0);
    expect(compareLines(unstamped, stamped)).toBeGreaterThan(0);
  });
});

describe('matchesQuery', () => {
  it('is case-insensitive and an empty query matches everything', () => {
    const line = toLogLines('web', 'Hello World', 0)[0]!;
    expect(matchesQuery(line, 'hello')).toBe(true);
    expect(matchesQuery(line, 'WORLD')).toBe(true);
    expect(matchesQuery(line, 'nope')).toBe(false);
    expect(matchesQuery(line, '')).toBe(true);
    expect(matchesQuery(line, '   ')).toBe(true);
  });
});
