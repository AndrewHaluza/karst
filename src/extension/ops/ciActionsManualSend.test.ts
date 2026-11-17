import { describe, expect, it, vi } from 'vitest';
import type { CiActionsInput } from './ciActionsWiring.js';

const sendCi = vi.fn(async (_d: unknown) => undefined);
const sendGate = vi.fn(async (_d: unknown) => undefined);
vi.mock('./ciFailureOps.js', () => ({ sendCiFailureToAgent: (d: unknown) => sendCi(d) }));
vi.mock('./baseMovedFailureOps.js', () => ({ sendGateFailureToAgent: (d: unknown) => sendGate(d) }));

const { sendCiFailureAction, sendGateFailureAction } = await import('./ciActionsWiring.js');

const input = (over: Partial<CiActionsInput>): CiActionsInput => ({ artifactDir: '/nowhere', ...over }) as CiActionsInput;

describe('manual send flag (T1212)', () => {
  it.each([
    ['Send CI failure', sendCiFailureAction, sendCi],
    ['Send gate failure', sendGateFailureAction, sendGate],
  ] as const)('%s passes markManualReship only for a manual send', async (_n, action, spy) => {
    spy.mockClear();
    await action(input({ manualSend: true }));
    expect(spy.mock.calls[0]![0]).toMatchObject({ markManualReship: true });
    spy.mockClear();
    await action(input({}));
    expect(spy.mock.calls[0]![0]).not.toHaveProperty('markManualReship');
    spy.mockClear();
    await action(input({ manualSend: false }));
    expect(spy.mock.calls[0]![0]).not.toHaveProperty('markManualReship');
  });
});
