import { describe, expect, it, vi } from 'vitest';
import { setPreviewContextThenContinue } from './previewContext.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('setPreviewContextThenContinue', () => {
  it('waits for a successful context write before continuing registration', async () => {
    const write = deferred<void>();
    const events: string[] = [];
    const run = setPreviewContextThenContinue({
      setContext: async () => {
        events.push('set-context');
        await write.promise;
        events.push('set-context-settled');
      },
      logError: vi.fn(),
      continueActivation: () => events.push('register-command'),
    });

    expect(events).toEqual(['set-context']);
    write.resolve();
    await run;

    expect(events).toEqual(['set-context', 'set-context-settled', 'register-command']);
  });

  it('logs a rejected context write and continues only after that rejection settles', async () => {
    const write = deferred<void>();
    const events: string[] = [];
    const failure = new Error('setContext unavailable');
    const logError = vi.fn((message: string, error: unknown) => {
      events.push(`log:${message}:${error === failure}`);
    });
    const run = setPreviewContextThenContinue({
      setContext: async () => {
        events.push('set-context');
        await write.promise;
      },
      logError,
      continueActivation: () => events.push('register-command'),
    });

    expect(events).toEqual(['set-context']);
    write.reject(failure);
    await run;

    expect(logError).toHaveBeenCalledWith('inside preview context setup failed', failure);
    expect(events).toEqual([
      'set-context',
      'log:inside preview context setup failed:true',
      'register-command',
    ]);
  });
});
