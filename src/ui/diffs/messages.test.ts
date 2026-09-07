import { describe, expect, it, vi } from 'vitest';
import { parseChangesMessage, routeChangesAction, type ChangesActions } from './messages.js';

describe('parseChangesMessage', () => {
  it('accepts the two permitted webview messages', () => {
    expect(parseChangesMessage({ type: 'refresh' })).toEqual({ type: 'refresh' });
    expect(parseChangesMessage({ type: 'open-diff', changeId: 'g1:4' }))
      .toEqual({ type: 'open-diff', changeId: 'g1:4' });
  });

  it('rejects a diff request with untrusted fields instead of an id', () => {
    expect(parseChangesMessage({ type: 'open-diff', path: '/tmp/x' })).toBeNull();
    expect(parseChangesMessage({ type: 'open-diff', changeId: '' })).toBeNull();
  });

  it('accepts a copy request for something that is actually a commit hash', () => {
    expect(parseChangesMessage({ type: 'copy-hash', hash: '9f1c2ab' }))
      .toEqual({ type: 'copy-hash', hash: '9f1c2ab' });
    expect(parseChangesMessage({
      type: 'copy-hash',
      hash: '9f1c2ab7d5e04416b3ca9f8e77d0a1c5b6e34210',
    })).toEqual({
      type: 'copy-hash',
      hash: '9f1c2ab7d5e04416b3ca9f8e77d0a1c5b6e34210',
    });
  });

  /**
   * The clipboard is a channel out of the panel: only a hash may ride it, never
   * a sentence a ticket's own content could have shaped.
   */
  it('rejects a copy request carrying anything but a hash', () => {
    expect(parseChangesMessage({ type: 'copy-hash', hash: 'rm -rf /' })).toBeNull();
    expect(parseChangesMessage({ type: 'copy-hash', hash: '' })).toBeNull();
    expect(parseChangesMessage({ type: 'copy-hash', hash: 'ABCDEF1' })).toBeNull();
    expect(parseChangesMessage({ type: 'copy-hash', hash: '9f1c2a' })).toBeNull();
    expect(parseChangesMessage({ type: 'copy-hash', hash: 'f'.repeat(41) })).toBeNull();
    expect(parseChangesMessage({ type: 'copy-hash' })).toBeNull();
  });

  it('drops payloads on refresh and routes only validated, already-parsed messages', () => {
    const refresh = vi.fn();
    const openDiff = vi.fn();
    const copyHash = vi.fn();
    const actions = { refresh, openDiff, copyHash, openFile: vi.fn(), discard: vi.fn(), unstage: vi.fn() };

    for (const raw of [
      { type: 'refresh', revision: 'forged' },
      { type: 'open-diff', changeId: 'g1:4' },
      { type: 'open-diff', repo: 'forged' },
      { type: 'copy-hash', hash: '9f1c2ab' },
      { type: 'copy-hash', hash: 'not a hash' },
      { type: 'unknown' },
    ]) {
      const msg = parseChangesMessage(raw);
      if (msg) routeChangesAction(msg, actions);
    }

    expect(refresh).toHaveBeenCalledOnce();
    expect(openDiff).toHaveBeenCalledWith('g1:4');
    expect(openDiff).toHaveBeenCalledTimes(1);
    expect(copyHash).toHaveBeenCalledWith('9f1c2ab');
    expect(copyHash).toHaveBeenCalledTimes(1);
  });
});

describe('routeChangesAction', () => {
  it('dispatches each already-parsed message to its action', () => {
    const actions: ChangesActions = {
      refresh: vi.fn(),
      openDiff: vi.fn(),
      copyHash: vi.fn(),
      openFile: vi.fn(),
      discard: vi.fn(),
      unstage: vi.fn(),
    };
    routeChangesAction({ type: 'refresh' }, actions);
    routeChangesAction({ type: 'open-diff', changeId: 'g1:4' }, actions);
    routeChangesAction({ type: 'copy-hash', hash: '9f1c2ab' }, actions);
    expect(actions.refresh).toHaveBeenCalledOnce();
    expect(actions.openDiff).toHaveBeenCalledWith('g1:4');
    expect(actions.copyHash).toHaveBeenCalledWith('9f1c2ab');
  });

  it('returns whatever the action returns, so the dispatch seam can await a real outcome', async () => {
    // The single dispatch seam (panel.ts) wraps this in `reportAction`, which
    // needs the underlying promise back to report a real terminal result
    // instead of acking before the action finishes (UI-R13).
    const pending = Promise.resolve();
    const actions: ChangesActions = {
      refresh: vi.fn(),
      openDiff: vi.fn(() => pending),
      copyHash: vi.fn(),
      openFile: vi.fn(),
      discard: vi.fn(),
      unstage: vi.fn(),
    };
    expect(routeChangesAction({ type: 'open-diff', changeId: 'g1:4' }, actions)).toBe(pending);
    await pending;
  });
});
