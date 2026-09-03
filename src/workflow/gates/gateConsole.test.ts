import { describe, it, expect } from 'vitest';
import { GateConsole } from './gateConsole.js';

function sink() {
  const posted: { ticketId: number; stage: string; text: string }[] = [];
  const console = new GateConsole({
    onOutput: (ticketId, stage, text) => posted.push({ ticketId, stage, text }),
  });
  return { console, posted };
}

describe('GateConsole', () => {
  it('forwards a gate chunk to the live sink', () => {
    const { console, posted } = sink();
    console.append(7, 'uat', 'unit', { stream: 'stdout', text: 'tests passed\n' });
    expect(posted).toEqual([
      { ticketId: 7, stage: 'uat', text: '\n$ unit\ntests passed\n' },
    ]);
  });

  it('writes the gate header once per gate, not per chunk', () => {
    const { console, posted } = sink();
    console.append(7, 'uat', 'unit', { stream: 'stdout', text: 'a' });
    console.append(7, 'uat', 'unit', { stream: 'stderr', text: 'b' });
    expect(posted.map((p) => p.text)).toEqual(['\n$ unit\na', 'b']);
  });

  it('writes a new header when the running gate changes', () => {
    const { console, posted } = sink();
    console.append(7, 'uat', 'unit', { stream: 'stdout', text: 'a' });
    console.append(7, 'uat', 'lint', { stream: 'stdout', text: 'b' });
    expect(posted.map((p) => p.text)).toEqual(['\n$ unit\na', '\n$ lint\nb']);
  });

  it('strips control sequences that would hijack the console', () => {
    const { console, posted } = sink();
    console.append(7, 'review', 'lint', { stream: 'stdout', text: '\x1b]0;pwned\x07\x1b[2Jok\x1b[32mgreen\x1b[0m' });
    expect(posted[0]!.text).toBe('\n$ lint\nok\x1b[32mgreen\x1b[0m');
  });

  it('drops a chunk that sanitizes to nothing — no header, no post', () => {
    const { console, posted } = sink();
    console.append(7, 'uat', 'unit', { stream: 'stdout', text: '\x1b[2J' });
    expect(posted).toEqual([]);
  });

  it('keeps each ticket/stage console independent', () => {
    const { console, posted } = sink();
    console.append(7, 'uat', 'unit', { stream: 'stdout', text: 'a' });
    console.append(8, 'uat', 'unit', { stream: 'stdout', text: 'b' });
    expect(posted.map((p) => [p.ticketId, p.text])).toEqual([
      [7, '\n$ unit\na'],
      [8, '\n$ unit\nb'],
    ]);
  });

  it('re-headers after a reset, so a re-run starts a fresh console', () => {
    const { console, posted } = sink();
    console.append(7, 'uat', 'unit', { stream: 'stdout', text: 'a' });
    console.reset(7, 'uat');
    console.append(7, 'uat', 'unit', { stream: 'stdout', text: 'b' });
    expect(posted.map((p) => p.text)).toEqual(['\n$ unit\na', '\n$ unit\nb']);
  });

  it('never throws when the live sink does', () => {
    const console = new GateConsole({
      onOutput: () => {
        throw new Error('panel gone');
      },
    });
    expect(() => console.append(1, 'uat', 'unit', { stream: 'stdout', text: 'a' })).not.toThrow();
  });
});
