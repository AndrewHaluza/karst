import { describe, it, expect } from 'vitest';
import {
  AgentOutputTail,
  sanitizeAgentOutput,
  AGENT_OUTPUT_TAIL_BYTES,
} from './outputTail.js';

describe('sanitizeAgentOutput', () => {
  it('keeps printable text and newlines verbatim', () => {
    expect(sanitizeAgentOutput('npm run test\n  pass (3s)\n')).toBe('npm run test\n  pass (3s)\n');
  });

  it('keeps ANSI SGR color codes so the console renders them', () => {
    expect(sanitizeAgentOutput('\x1b[32mpass\x1b[0m')).toBe('\x1b[32mpass\x1b[0m');
    expect(sanitizeAgentOutput('\x1b[1;31mfail\x1b[0m')).toBe('\x1b[1;31mfail\x1b[0m');
  });

  it('strips cursor/clear/title escape sequences, never letting them reach the console', () => {
    // Clear screen, cursor home, and an OSC title-change — none are SGR.
    expect(sanitizeAgentOutput('\x1b[2J\x1b[Hhello\x1b]0;hijack\x07')).toBe('hello');
  });

  it('strips other C0 control characters but keeps tab', () => {
    expect(sanitizeAgentOutput('a\x00b\x07c\td')).toBe('abc\td');
    expect(sanitizeAgentOutput('a\x00b\bc')).toBe('abc');
    expect(sanitizeAgentOutput('a\tb')).toBe('a\tb');
  });
});

describe('AgentOutputTail', () => {
  it('renders the retained text of the chunks it was fed', () => {
    const tail = new AgentOutputTail();
    tail.append({ stream: 'stdout', text: 'one\n' });
    tail.append({ stream: 'stderr', text: 'two\n' });
    expect(tail.render()).toBe('one\ntwo\n');
    expect(tail.truncated).toBe(false);
  });

  it('sanitizes on the way in', () => {
    const tail = new AgentOutputTail();
    tail.append({ stream: 'stdout', text: '\x1b[2J\x1b[32mok\x1b[0m' });
    expect(tail.render()).toBe('\x1b[32mok\x1b[0m');
  });

  it('carries an ANSI escape split across two chunks instead of rendering literal text', () => {
    const tail = new AgentOutputTail();
    // `\x1b[32m` arrives with the ESC in the first chunk and the `[32m` in the
    // second: the color code must survive whole, never as literal `[32m`.
    tail.append({ stream: 'stdout', text: 'a\x1b' });
    expect(tail.render()).toBe('a');
    tail.append({ stream: 'stdout', text: '[32mgreen\x1b[0m' });
    expect(tail.render()).toBe('a\x1b[32mgreen\x1b[0m');
  });

  it('drops the oldest bytes past the budget and marks truncated', () => {
    const tail = new AgentOutputTail(64);
    for (let i = 0; i < 100; i++) tail.append({ stream: 'stdout', text: `line-${i}\n` });
    expect(tail.truncated).toBe(true);
    const rendered = tail.render();
    // The tail is within the budget and holds the NEWEST lines.
    expect(Buffer.byteLength(rendered, 'utf8')).toBeLessThanOrEqual(64);
    expect(rendered).toContain('line-99');
    expect(rendered).not.toContain('line-0');
  });

  it('keeps the default budget usable as a large console tail', () => {
    expect(AGENT_OUTPUT_TAIL_BYTES).toBeGreaterThan(64 * 1024);
  });
});
