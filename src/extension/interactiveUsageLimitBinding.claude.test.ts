import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { openStore, type Store } from '../store/db.js';
import { createTicket } from '../store/tickets.js';
import { listOpenParks } from '../store/usageLimitParks.js';

const m = vi.hoisted(() => ({
  executeCommand: vi.fn(),
  showWarningMessage: vi.fn(),
  showErrorMessage: vi.fn(),
  makeActions: vi.fn(),
  runOffer: vi.fn(),
}));
vi.mock('vscode', () => ({
  commands: { executeCommand: m.executeCommand },
  window: { showWarningMessage: m.showWarningMessage, showErrorMessage: m.showErrorMessage },
}));
vi.mock('./ops/interactiveUsageLimitActions.js', () => ({
  makeInteractiveParkActions: m.makeActions,
  runInteractiveOffer: m.runOffer,
}));

import { createInteractiveUsageLimitBinding } from './interactiveUsageLimitBinding.js';

const line = (entry: Record<string, unknown>): string => JSON.stringify(entry);
const errLine = (text: string): string =>
  line({ type: 'assistant', uuid: 'err-1', isApiErrorMessage: true, message: { content: [{ type: 'text', text }] } });
const systemLine = (): string => line({ type: 'system', subtype: 'turn_duration', uuid: 'sys-1' });
const notificationLine = (): string =>
  line({ type: 'user', uuid: 'u-task', origin: { kind: 'task-notification' }, message: { content: [{ type: 'text', text: 'task done' }] } });
const lastPromptLine = (): string => line({ type: 'last-prompt', uuid: 'lp-1' });
const fileHistoryLine = (): string => line({ type: 'file-history-snapshot', uuid: 'fh-1' });

/**
 * The real detector and the real once-per-error rule behind the binding's
 * `onClaudeTranscript`; only the vscode surface and the park actions are faked.
 */
describe('createInteractiveUsageLimitBinding — claude transcript', () => {
  let store: Store;
  let ticketId: number;
  const deps = {
    store: undefined as unknown as Store,
    pick: vi.fn(),
    switchSession: vi.fn(),
    disposeSession: vi.fn(),
    sessionProviderFor: (): 'claude' => 'claude',
    refresh: vi.fn(),
  };

  beforeEach(() => {
    store = openStore(':memory:');
    deps.store = store;
    ticketId = createTicket(store, { key: 'T-C', title: 'c' }).id;
    vi.clearAllMocks();
    m.makeActions.mockReturnValue({ tag: 'actions' });
    m.runOffer.mockResolvedValue(undefined);
  });
  afterEach(() => store.close());

  it('parks and offers once for one error, even as metadata keeps arriving', () => {
    const b = createInteractiveUsageLimitBinding(deps);
    const first = [errLine("You've hit your 5-hour limit"), systemLine(), notificationLine()].join('\n');
    b.onClaudeTranscript(ticketId, 's1', first);
    expect(listOpenParks(store, ticketId)).toHaveLength(1);
    expect(m.runOffer).toHaveBeenCalledTimes(1);

    b.onClaudeTranscript(ticketId, 's1', `${first}\n${lastPromptLine()}\n${fileHistoryLine()}`);
    expect(listOpenParks(store, ticketId)).toHaveLength(1);
    expect(m.runOffer).toHaveBeenCalledTimes(1);
  });

  it('does not park on an API error whose text is not a quota verdict', () => {
    const b = createInteractiveUsageLimitBinding(deps);
    b.onClaudeTranscript(ticketId, 's1', errLine('ECONNRESET while streaming'));
    expect(listOpenParks(store, ticketId)).toHaveLength(0);
    expect(m.runOffer).not.toHaveBeenCalled();
  });
});
