import { describe, it, expect, vi } from 'vitest';
import { parseWelcomeMessage, routeWelcomeAction, type WelcomeActions } from './messages.js';

describe('parseWelcomeMessage', () => {
  it('accepts every known discriminant', () => {
    for (const type of [
      'create-manifest',
      'recheck-deps',
      'open-settings',
      'create-ticket',
      'dismiss',
      'request-state',
    ]) {
      expect(parseWelcomeMessage({ type })).toEqual({ type });
    }
  });

  it('rejects unknown or malformed shapes', () => {
    expect(parseWelcomeMessage(null)).toBeNull();
    expect(parseWelcomeMessage('nope')).toBeNull();
    expect(parseWelcomeMessage({ type: 'evil' })).toBeNull();
    expect(parseWelcomeMessage({})).toBeNull();
  });
});

describe('routeWelcomeAction', () => {
  it('dispatches each already-parsed message to its action', () => {
    const actions: WelcomeActions = {
      createManifest: vi.fn(),
      recheckDeps: vi.fn(),
      openSettings: vi.fn(),
      createTicket: vi.fn(),
      dismiss: vi.fn(),
      requestState: vi.fn(),
    };
    routeWelcomeAction({ type: 'create-manifest' }, actions);
    routeWelcomeAction({ type: 'recheck-deps' }, actions);
    routeWelcomeAction({ type: 'open-settings' }, actions);
    routeWelcomeAction({ type: 'create-ticket' }, actions);
    routeWelcomeAction({ type: 'dismiss' }, actions);
    routeWelcomeAction({ type: 'request-state' }, actions);
    expect(actions.createManifest).toHaveBeenCalledOnce();
    expect(actions.recheckDeps).toHaveBeenCalledOnce();
    expect(actions.openSettings).toHaveBeenCalledOnce();
    expect(actions.createTicket).toHaveBeenCalledOnce();
    expect(actions.dismiss).toHaveBeenCalledOnce();
    expect(actions.requestState).toHaveBeenCalledOnce();
  });

  it('returns whatever the action returns, so the dispatch seam can await a real outcome', async () => {
    // The single dispatch seam (panel.ts) wraps this in `reportAction`, which
    // needs the underlying promise back to report a real terminal result
    // instead of acking before the action finishes (UI-R13).
    const pending = Promise.resolve();
    const actions: WelcomeActions = {
      createManifest: vi.fn(() => pending),
      recheckDeps: vi.fn(),
      openSettings: vi.fn(),
      createTicket: vi.fn(),
      dismiss: vi.fn(),
      requestState: vi.fn(),
    };
    expect(routeWelcomeAction({ type: 'create-manifest' }, actions)).toBe(pending);
    await pending;
  });
});
