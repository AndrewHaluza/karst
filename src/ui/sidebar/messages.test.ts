import { describe, it, expect, vi } from 'vitest';
import { parseSidebarMessage, routeSidebarAction, type SidebarActions } from './messages.js';

describe('parseSidebarMessage', () => {
  it('accepts payload-free messages', () => {
    for (const type of ['refresh', 'request-state', 'create', 'open-settings'] as const) {
      expect(parseSidebarMessage({ type })).toEqual({ type });
    }
  });

  it('accepts toggle-facet with a known facet, rejects unknown', () => {
    expect(parseSidebarMessage({ type: 'toggle-facet', facet: 'running' })).toEqual({
      type: 'toggle-facet',
      facet: 'running',
    });
    expect(parseSidebarMessage({ type: 'toggle-facet', facet: 'bogus' })).toBeNull();
    expect(parseSidebarMessage({ type: 'toggle-facet' })).toBeNull();
  });

  it('accepts set-filter with a string query', () => {
    expect(parseSidebarMessage({ type: 'set-filter', query: 'abc' })).toEqual({
      type: 'set-filter',
      query: 'abc',
    });
    expect(parseSidebarMessage({ type: 'set-filter', query: 5 })).toBeNull();
  });

  it('accepts row actions only with a finite numeric ticketId', () => {
    expect(parseSidebarMessage({ type: 'open-ticket', ticketId: 17 })).toEqual({
      type: 'open-ticket',
      ticketId: 17,
    });
    expect(parseSidebarMessage({ type: 'spin', ticketId: 3 })).toEqual({ type: 'spin', ticketId: 3 });
    expect(parseSidebarMessage({ type: 'open-ticket', ticketId: '17' })).toBeNull();
    expect(parseSidebarMessage({ type: 'archive', ticketId: '3' })).toBeNull();
    expect(parseSidebarMessage({ type: 'delete', ticketId: NaN })).toBeNull();
    expect(parseSidebarMessage({ type: 'edit' })).toBeNull();
  });

  it('rejects non-objects and unknown types', () => {
    expect(parseSidebarMessage(null)).toBeNull();
    expect(parseSidebarMessage('x')).toBeNull();
    expect(parseSidebarMessage({ type: 'nope' })).toBeNull();
  });
});

describe('routeSidebarAction', () => {
  function makeActions(): SidebarActions {
    return {
      toggleFacet: vi.fn(),
      setFilter: vi.fn(),
      refresh: vi.fn(),
      requestState: vi.fn(),
      create: vi.fn(),
      openSettings: vi.fn(),
      openTicket: vi.fn(),
      openDashboard: vi.fn(),
      spin: vi.fn(),
      openSession: vi.fn(),
      edit: vi.fn(),
      archive: vi.fn(),
      unarchive: vi.fn(),
      delete: vi.fn(),
    };
  }

  it('dispatches each already-parsed message to its action with the right arg', () => {
    const a = makeActions();
    routeSidebarAction({ type: 'toggle-facet', facet: 'failed' }, a);
    routeSidebarAction({ type: 'set-filter', query: 'q' }, a);
    routeSidebarAction({ type: 'open-ticket', ticketId: 17 }, a);
    routeSidebarAction({ type: 'spin', ticketId: 7 }, a);
    routeSidebarAction({ type: 'archive', ticketId: 8 }, a);
    routeSidebarAction({ type: 'create' }, a);

    expect(a.toggleFacet).toHaveBeenCalledWith('failed');
    expect(a.setFilter).toHaveBeenCalledWith('q');
    expect(a.openTicket).toHaveBeenCalledWith(17);
    expect(a.spin).toHaveBeenCalledWith(7);
    expect(a.archive).toHaveBeenCalledWith(8);
    expect(a.create).toHaveBeenCalledOnce();
  });

  it('returns whatever the action returns, so the dispatch seam can await a real outcome', async () => {
    // The single dispatch seam (panel.ts) wraps this in `reportAction`, which
    // needs the underlying promise back to report a real terminal result
    // instead of acking before the action finishes (UI-R13).
    const pending = Promise.resolve();
    const a = makeActions();
    a.spin = vi.fn(() => pending);
    expect(routeSidebarAction({ type: 'spin', ticketId: 7 }, a)).toBe(pending);
    await pending;
  });
});
