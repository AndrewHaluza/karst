import { describe, it, expect, vi } from 'vitest';
import { attachMessagePump, type MessagePumpDeps } from './messagePump.js';
import type { DashboardPanel } from './panelTypes.js';

function setup() {
  let handler: (raw: unknown) => void = () => {};
  const postMessage = vi.fn();
  const panel = { onDidReceiveMessage: (h: (raw: unknown) => void) => { handler = h; }, postMessage } as unknown as DashboardPanel;
  const logError = vi.fn();
  const deps = { ticketId: 1, actions: {}, selections: {}, registry: {}, pushState: vi.fn(), logError } as unknown as MessagePumpDeps;
  attachMessagePump(panel, deps);
  return { send: (raw: unknown) => handler(raw), postMessage, logError };
}

const tooLong = new Array(501).fill(0);

describe('attachMessagePump — a dropped decision message (UI-R13 exception)', () => {
  it('answers a baseline decision the parse dropped with ok:false and a warning, and logs only the type', () => {
    const { send, postMessage, logError } = setup();
    send({ type: 'baseline-approve', blockId: 'baseline-review', indices: tooLong, requestId: 'req-1' });
    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'action-result', requestId: 'req-1', ok: false, message: expect.any(String) }));
    expect(logError).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(logError.mock.calls)).toContain('baseline-approve');
    expect(JSON.stringify(logError.mock.calls)).not.toContain('req-1');
  });

  it.each(['baseline-approve-all', 'baseline-reject'])('also answers a dropped %s', (type) => {
    const { send, postMessage } = setup();
    send({ type, blockId: 'wrong', requestId: 'req-2' });
    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ requestId: 'req-2', ok: false }));
  });

  it('posts nothing for a dropped message that is not a decision', () => {
    const { send, postMessage } = setup();
    send({ type: 'stored-artifact-open', path: '../x', sha: 'nope', requestId: 'req-3' });
    expect(postMessage).not.toHaveBeenCalled();
  });

  it('posts nothing for a dropped decision without a valid request id', () => {
    const { send, postMessage } = setup();
    send({ type: 'baseline-approve', blockId: 'baseline-review', indices: tooLong });
    send({ type: 'baseline-approve', blockId: 'baseline-review', indices: tooLong, requestId: 'bad id!' });
    expect(postMessage).not.toHaveBeenCalled();
  });
});
