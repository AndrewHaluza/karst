// @vitest-environment jsdom
/**
 * COMPONENT-mode proof for `useHostMutation` (NDL-126 §9.2): UI-R11 (pending
 * begins locally on activation), R12 (no duplicate work), R13/R15 (terminal
 * results, never premature success), R14 (unknown ≠ failure, no unsafe retry),
 * R17 (busy vs disabled) and R27 (announcements).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import { useHostMutation, type UseHostMutationOptions } from './useHostMutation.js';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

interface Harness {
  sent: Array<{ requestId: string; value: string }>;
  announced: string[];
  hook: { result: { current: ReturnType<typeof useHostMutation<[string]>> } };
}

function setup(overrides: Partial<UseHostMutationOptions<[string]>> = {}): Harness {
  const sent: Array<{ requestId: string; value: string }> = [];
  const announced: string[] = [];
  let counter = 0;
  const hook = renderHook(() =>
    useHostMutation<[string]>({
      kind: 'save',
      send: (requestId, value) => sent.push({ requestId, value }),
      announce: (message) => announced.push(message),
      nextRequestId: () => `r${(counter += 1)}`,
      ...overrides,
    }),
  );
  return { sent, announced, hook };
}

describe('useHostMutation', () => {
  it('enters pending synchronously on activation and posts one request (UI-R11)', () => {
    const { hook, sent } = setup();
    act(() => hook.result.current.trigger('hello'));
    expect(sent).toEqual([{ requestId: 'r1', value: 'hello' }]);
    expect(hook.result.current.status).toBe('pending');
    expect(hook.result.current.pending).toBe(true);
    expect(hook.result.current.busy).toBe(true);
    expect(hook.result.current.disabled).toBe(true);
    expect(hook.result.current.requestId).toBe('r1');
  });

  it('ignores a second activation while pending (UI-R12)', () => {
    const { hook, sent } = setup();
    act(() => {
      hook.result.current.trigger('a');
      hook.result.current.trigger('b');
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.value).toBe('a');
  });

  it('settles success and announces it (UI-R13/R15/R27)', () => {
    const { hook, announced } = setup();
    act(() => hook.result.current.trigger('a'));
    act(() => hook.result.current.settle({ requestId: 'r1', result: 'success' }));
    expect(hook.result.current.status).toBe('success');
    expect(hook.result.current.pending).toBe(false);
    expect(hook.result.current.disabled).toBe(false);
    expect(announced).toEqual(['save succeeded.']);
  });

  it('settles failure with the host message (UI-R13)', () => {
    const { hook, announced } = setup();
    act(() => hook.result.current.trigger('a'));
    act(() =>
      hook.result.current.settle({ requestId: 'r1', result: 'failure', message: 'Manifest invalid' }),
    );
    expect(hook.result.current.status).toBe('failure');
    expect(hook.result.current.error).toBe('Manifest invalid');
    expect(announced).toEqual(['Manifest invalid']);
  });

  it('never shows success for a mismatched request id (UI-R15)', () => {
    const { hook, announced } = setup();
    act(() => hook.result.current.trigger('a'));
    act(() => hook.result.current.settle({ requestId: 'other', result: 'success' }));
    expect(hook.result.current.pending).toBe(true);
    expect(announced).toEqual([]);
  });

  it('turns a timed-out pending request into unknown, not failure, and blocks retry (UI-R14)', () => {
    const { hook, sent, announced } = setup({ timeoutMs: 1000 });
    vi.useFakeTimers();
    act(() => hook.result.current.trigger('a'));
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(hook.result.current.status).toBe('unknown');
    expect(hook.result.current.pending).toBe(false);
    expect(hook.result.current.busy).toBe(false);
    expect(hook.result.current.disabled).toBe(true);
    expect(hook.result.current.error).toBeUndefined();
    expect(announced).toEqual(['save: result unknown.']);
    act(() => hook.result.current.trigger('b'));
    expect(sent).toHaveLength(1);
  });

  it('resets to idle', () => {
    const { hook } = setup();
    act(() => hook.result.current.trigger('a'));
    act(() => hook.result.current.reset());
    expect(hook.result.current.status).toBe('idle');
    expect(hook.result.current.disabled).toBe(false);
  });
});