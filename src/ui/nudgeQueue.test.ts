import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NudgeQueue, type TypedTerminal } from './nudgeQueue.js';

interface Recorded {
  text: string;
  addNewLine: boolean | undefined;
}

function recorder(): { terminal: TypedTerminal; calls: Recorded[] } {
  const calls: Recorded[] = [];
  return {
    calls,
    terminal: {
      sendText: (text, addNewLine) => calls.push({ text, addNewLine }),
    },
  };
}

describe('NudgeQueue', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('types the text without a newline, waits the delay, then sends a bare CR', async () => {
    const { terminal, calls } = recorder();
    const queue = new NudgeQueue(terminal, 120);

    queue.enqueue('review failed: lint');
    // The first line is typed synchronously — the caller's nudge keeps its
    // boolean contract and the pointer is on screen before the next tick.
    expect(calls).toEqual([{ text: 'review failed: lint', addNewLine: false }]);

    await vi.advanceTimersByTimeAsync(119);
    expect(calls).toHaveLength(1); // not submitted early

    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toEqual([
      { text: 'review failed: lint', addNewLine: false },
      { text: '\r', addNewLine: false },
    ]);
  });

  it('serializes two back-to-back nudges into two separate submitted lines', async () => {
    const { terminal, calls } = recorder();
    const queue = new NudgeQueue(terminal, 100);

    queue.enqueue('first');
    queue.enqueue('second');

    // Only the first line is typed; the second waits its turn.
    expect(calls).toEqual([{ text: 'first', addNewLine: false }]);

    await vi.advanceTimersByTimeAsync(100);
    expect(calls).toEqual([
      { text: 'first', addNewLine: false },
      { text: '\r', addNewLine: false },
      { text: 'second', addNewLine: false },
    ]);

    await vi.advanceTimersByTimeAsync(100);
    expect(calls).toEqual([
      { text: 'first', addNewLine: false },
      { text: '\r', addNewLine: false },
      { text: 'second', addNewLine: false },
      { text: '\r', addNewLine: false },
    ]);
  });

  it('sends exactly one submit per queued nudge', async () => {
    const { terminal, calls } = recorder();
    const queue = new NudgeQueue(terminal, 50);

    queue.enqueue('a');
    queue.enqueue('b');
    queue.enqueue('c');
    await vi.advanceTimersByTimeAsync(150);

    expect(calls.filter((c) => c.text === '\r')).toHaveLength(3);
  });

  it('passes a long brief through as a single typed line', async () => {
    const { terminal, calls } = recorder();
    const queue = new NudgeQueue(terminal, 30);
    const brief = `review failed: ${'x'.repeat(4000)}`;

    queue.enqueue(brief);
    await vi.advanceTimersByTimeAsync(30);

    expect(calls[0]).toEqual({ text: brief, addNewLine: false });
    expect(calls).toHaveLength(2);
  });

  it('drops a queued line when the terminal closes before its turn', async () => {
    const { terminal, calls } = recorder();
    const queue = new NudgeQueue(terminal, 100);

    queue.enqueue('first');
    queue.enqueue('second');
    queue.close();
    await vi.advanceTimersByTimeAsync(500);

    // Neither the in-flight submit nor the pending line fires after close.
    expect(calls).toEqual([{ text: 'first', addNewLine: false }]);
  });

  it('ignores an enqueue after close', async () => {
    const { terminal, calls } = recorder();
    const queue = new NudgeQueue(terminal, 100);

    queue.close();
    queue.enqueue('late');
    await vi.advanceTimersByTimeAsync(500);

    expect(calls).toEqual([]);
  });
});
