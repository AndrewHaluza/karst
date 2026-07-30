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

  it('drops payloads on refresh and routes only validated messages', () => {
    const refresh = vi.fn();
    const openDiff = vi.fn();

    routeChangesMessage({ type: 'refresh', revision: 'forged' }, { refresh, openDiff });
    routeChangesMessage({ type: 'open-diff', changeId: 'g1:4' }, { refresh, openDiff });
    routeChangesMessage({ type: 'open-diff', repo: 'forged' }, { refresh, openDiff });
    routeChangesMessage({ type: 'unknown' }, { refresh, openDiff });

    expect(refresh).toHaveBeenCalledOnce();
    expect(openDiff).toHaveBeenCalledWith('g1:4');
    expect(openDiff).toHaveBeenCalledTimes(1);
  });
});
