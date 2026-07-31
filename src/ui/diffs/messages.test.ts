import { describe, expect, it, vi } from 'vitest';
import { parseChangesMessage, routeChangesMessage } from './messages.js';

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

  it('drops payloads on refresh and routes only validated messages', () => {
    const refresh = vi.fn();
    const openDiff = vi.fn();
    const copyHash = vi.fn();
    const actions = { refresh, openDiff, copyHash };

    routeChangesMessage({ type: 'refresh', revision: 'forged' }, actions);
    routeChangesMessage({ type: 'open-diff', changeId: 'g1:4' }, actions);
    routeChangesMessage({ type: 'open-diff', repo: 'forged' }, actions);
    routeChangesMessage({ type: 'copy-hash', hash: '9f1c2ab' }, actions);
    routeChangesMessage({ type: 'copy-hash', hash: 'not a hash' }, actions);
    routeChangesMessage({ type: 'unknown' }, actions);

    expect(refresh).toHaveBeenCalledOnce();
    expect(openDiff).toHaveBeenCalledWith('g1:4');
    expect(openDiff).toHaveBeenCalledTimes(1);
    expect(copyHash).toHaveBeenCalledWith('9f1c2ab');
    expect(copyHash).toHaveBeenCalledTimes(1);
  });
});
