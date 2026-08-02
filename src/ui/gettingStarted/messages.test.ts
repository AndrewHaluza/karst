import { describe, it, expect, vi } from 'vitest';
import { parseGettingStartedMessage, routeGettingStartedAction, type GettingStartedActions } from './messages.js';

describe('parseGettingStartedMessage', () => {
  it('accepts every known discriminant', () => {
    for (const type of [
      'create-manifest',
      'recheck-deps',
      'open-settings',
      'create-ticket',
      'report-issue',
      'dismiss',
      'request-state',
    ]) {
      expect(parseGettingStartedMessage({ type })).toEqual({ type });
    }
  });

  it('rejects unknown or malformed shapes', () => {
    expect(parseGettingStartedMessage(null)).toBeNull();
    expect(parseGettingStartedMessage('nope')).toBeNull();
    expect(parseGettingStartedMessage({ type: 'evil' })).toBeNull();
    expect(parseGettingStartedMessage({})).toBeNull();
  });
});

describe('routeGettingStartedAction', () => {
  it('dispatches each already-parsed message to its action', () => {
    const actions: GettingStartedActions = {
      createManifest: vi.fn(),
      recheckDeps: vi.fn(),
      openSettings: vi.fn(),
      createTicket: vi.fn(),
      reportIssue: vi.fn(),
      dismiss: vi.fn(),
      requestState: vi.fn(),
    };
    routeGettingStartedAction({ type: 'create-manifest' }, actions);
    routeGettingStartedAction({ type: 'recheck-deps' }, actions);
    routeGettingStartedAction({ type: 'open-settings' }, actions);
    routeGettingStartedAction({ type: 'create-ticket' }, actions);
    routeGettingStartedAction({ type: 'report-issue' }, actions);
    routeGettingStartedAction({ type: 'dismiss' }, actions);
    routeGettingStartedAction({ type: 'request-state' }, actions);
    expect(actions.createManifest).toHaveBeenCalledOnce();
    expect(actions.recheckDeps).toHaveBeenCalledOnce();
    expect(actions.openSettings).toHaveBeenCalledOnce();
    expect(actions.createTicket).toHaveBeenCalledOnce();
    expect(actions.reportIssue).toHaveBeenCalledOnce();
    expect(actions.dismiss).toHaveBeenCalledOnce();
    expect(actions.requestState).toHaveBeenCalledOnce();
  });

  it('returns whatever the action returns, so the dispatch seam can await a real outcome', async () => {
    // The single dispatch seam (panel.ts) wraps this in `reportAction`, which
    // needs the underlying promise back to report a real terminal result
    // instead of acking before the action finishes (UI-R13).
    const pending = Promise.resolve();
    const actions: GettingStartedActions = {
      createManifest: vi.fn(() => pending),
      recheckDeps: vi.fn(),
      openSettings: vi.fn(),
      createTicket: vi.fn(),
      reportIssue: vi.fn(),
      dismiss: vi.fn(),
      requestState: vi.fn(),
    };
    expect(routeGettingStartedAction({ type: 'create-manifest' }, actions)).toBe(pending);
    await pending;
  });
});
