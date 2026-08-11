import { describe, expect, it, vi } from 'vitest';
import { closeDoneTerminalsOf, type DoneTerminalProbe } from './doneTerminals.js';

function probe(
  ticketId: number,
  exited: boolean,
  dispose: () => void = vi.fn(),
): DoneTerminalProbe {
  return { ticketId, exited, dispose };
}

describe('closeDoneTerminalsOf', () => {
  it('disposes every done terminal of the ticket and reports the count', () => {
    const disposed = vi.fn();
    const disposed2 = vi.fn();
    const closed = closeDoneTerminalsOf(
      [probe(1, true, disposed), probe(1, true, disposed2)],
      1,
    );

    expect(closed).toBe(2);
    expect(disposed).toHaveBeenCalledTimes(1);
    expect(disposed2).toHaveBeenCalledTimes(1);
  });

  it('never disposes a terminal whose process is still running', () => {
    const disposed = vi.fn();
    const closed = closeDoneTerminalsOf([probe(1, false, disposed)], 1);

    expect(closed).toBe(0);
    expect(disposed).not.toHaveBeenCalled();
  });

  it('never disposes another ticket\'s terminal', () => {
    const disposed = vi.fn();
    const closed = closeDoneTerminalsOf([probe(2, true, disposed)], 1);

    expect(closed).toBe(0);
    expect(disposed).not.toHaveBeenCalled();
  });

  it('is a no-op when the ticket has no terminals at all', () => {
    expect(closeDoneTerminalsOf([], 1)).toBe(0);
    expect(closeDoneTerminalsOf([probe(2, true)], 1)).toBe(0);
  });
});
