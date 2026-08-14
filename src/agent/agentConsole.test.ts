import { describe, it, expect, vi } from 'vitest';
import { AgentConsole, agentLogFileName, type AgentConsoleOptions } from './agentConsole.js';

function makeConsole(
  over: Partial<AgentConsoleOptions> = {},
): { console: AgentConsole; posts: Array<[number, string, string]> } {
  const posts: Array<[number, string, string]> = [];
  return {
    posts,
    console: new AgentConsole({
      dirFor: (id) => `/artifacts/${id}`,
      readFile: (p) => {
        if (!p.includes('agent-tester-ticket-7.log')) throw new Error('ENOENT');
        return 'persisted tail\n';
      },
      appendFile: vi.fn(),
      mkdir: vi.fn(),
      onOutput: (ticketId, processId, text) => posts.push([ticketId, processId, text]),
      ...over,
    }),
  };
}

describe('agentLogFileName', () => {
  it('names the persisted file per ticket and process', () => {
    expect(agentLogFileName(7, 'tester')).toBe('agent-tester-ticket-7.log');
    expect(agentLogFileName(7, 'review')).toBe('agent-review-ticket-7.log');
  });
});

describe('AgentConsole', () => {
  it('sanitizes, persists and live-posts each retained chunk', () => {
    const { console, posts } = makeConsole();
    console.append(7, 'tester', { stream: 'stdout', text: 'one\n\x1b[2J\x1b[32mok\x1b[0m' });
    console.append(7, 'tester', { stream: 'stderr', text: 'two\n' });
    // The clear-screen sequence is stripped; colors survive.
    expect(posts).toEqual([
      [7, 'tester', 'one\n\x1b[32mok\x1b[0m'],
      [7, 'tester', 'two\n'],
    ]);
    // The persisted file got the same sanitized bytes, appended.
    const appendFile = console['options'].appendFile as ReturnType<typeof vi.fn>;
    expect(appendFile).toHaveBeenNthCalledWith(
      1,
      '/artifacts/7/agent-tester-ticket-7.log',
      'one\n\x1b[32mok\x1b[0m',
    );
    expect(appendFile).toHaveBeenNthCalledWith(
      2,
      '/artifacts/7/agent-tester-ticket-7.log',
      'two\n',
    );
  });

  it('serves a persisted tail as the console content', () => {
    const { console } = makeConsole();
    expect(console.readLog(7, 'tester')).toEqual({
      kind: 'ok',
      content: 'persisted tail\n',
      truncated: false,
    });
  });

  it('refuses with a named error when no log was ever recorded', () => {
    const { console } = makeConsole();
    expect(console.readLog(9, 'review')).toEqual({
      kind: 'error',
      message: 'No console output has been recorded for this process yet.',
    });
  });

  it('caps the persisted file and marks the served tail truncated', () => {
    const content = 'x'.repeat(100);
    const { console } = makeConsole({
      maxFileBytes: 16,
      readFile: () => content,
    });
    const result = console.readLog(7, 'tester');
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.truncated).toBe(true);
      expect(result.content.length).toBeLessThanOrEqual(16 + 64);
    }
  });

  it('does not throw when a persistence fault occurs — the agent call survives', () => {
    const { console, posts } = makeConsole({
      appendFile: () => {
        throw new Error('disk full');
      },
      onOutput: (ticketId, processId, text) => posts.push([ticketId, processId, text]),
    });
    expect(() => console.append(7, 'review', { stream: 'stdout', text: 'still live' })).not.toThrow();
    // Live posting still happened even though persistence failed.
    expect(posts).toEqual([[7, 'review', 'still live']]);
  });

  it('stops appending past the file cap but keeps live posting', () => {
    const files = new Map<string, string>();
    const readFile = vi.fn((p: string) => files.get(p) ?? (() => { throw new Error('ENOENT'); })());
    const appendFile = vi.fn((p: string, text: string) => {
      files.set(p, `${files.get(p) ?? ''}${text}`);
    });
    const { console, posts } = makeConsole({
      maxFileBytes: 2,
      readFile,
      appendFile,
    });
    console.append(7, 'tester', { stream: 'stdout', text: 'a' });
    console.append(7, 'tester', { stream: 'stdout', text: 'b' });
    console.append(7, 'tester', { stream: 'stdout', text: 'c' });
    // 'a' fills 1 of 2 bytes; 'b' fills the remaining one; 'c' finds the file
    // already at its cap and writes nothing — but the live stream still saw it.
    expect(files.get('/artifacts/7/agent-tester-ticket-7.log')).toBe('ab');
    expect(posts.flatMap((p) => p[2])).toEqual(['a', 'b', 'c']);
  });

  it('reset drops the in-memory ring but keeps the persisted file', () => {
    const { console, posts } = makeConsole();
    console.append(7, 'tester', { stream: 'stdout', text: 'one' });
    console.reset(7, 'tester');
    // readLog reads the FILE, which is untouched by reset.
    expect(console.readLog(7, 'tester')).toEqual({ kind: 'ok', content: 'persisted tail\n', truncated: false });
    // Live posting continues after reset (new ring).
    console.append(7, 'tester', { stream: 'stdout', text: 'two' });
    expect(posts).toEqual([
      [7, 'tester', 'one'],
      [7, 'tester', 'two'],
    ]);
  });
});
