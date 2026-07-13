import { describe, it, expect, vi } from 'vitest';
import { parseSidebarMessage, routeSidebarAction, type SidebarActions } from './messages.js';

describe('parseSidebarMessage', () => {
  it('accepts payload-free messages', () => {
    for (const type of ['refresh', 'request-state', 'create', 'open-settings'] as const) {
      expect(parseSidebarMessage({ type })).toEqual({ type });
    }
  });

  it('accepts set-facet with a known facet, rejects unknown', () => {
    expect(parseSidebarMessage({ type: 'set-facet', facet: 'running' })).toEqual({
      type: 'set-facet',
      facet: 'running',
    });
    expect(parseSidebarMessage({ type: 'set-facet', facet: 'bogus' })).toBeNull();
    expect(parseSidebarMessage({ type: 'set-facet' })).toBeNull();
  });

  it('accepts set-filter with a string query', () => {
    expect(parseSidebarMessage({ type: 'set-filter', query: 'abc' })).toEqual({
      type: 'set-filter',
      query: 'abc',
    });
    expect(parseSidebarMessage({ type: 'set-filter', query: 5 })).toBeNull();
  });

  it('accepts row actions only with a finite numeric ticketId', () => {
    expect(parseSidebarMessage({ type: 'spin', ticketId: 3 })).toEqual({ type: 'spin', ticketId: 3 });
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
      setFacet: vi.fn(),
      setFilter: vi.fn(),
      refresh: vi.fn(),
      requestState: vi.fn(),
      create: vi.fn(),
      openSettings: vi.fn(),
      openDashboard: vi.fn(),
      spin: vi.fn(),
      openSession: vi.fn(),
      edit: vi.fn(),
      archive: vi.fn(),
      unarchive: vi.fn(),
      delete: vi.fn(),
    };
  }

  it('dispatches each message to its action with the right arg', () => {
    const a = makeActions();
    routeSidebarAction({ type: 'set-facet', facet: 'failed' }, a);
    routeSidebarAction({ type: 'set-filter', query: 'q' }, a);
    routeSidebarAction({ type: 'spin', ticketId: 7 }, a);
    routeSidebarAction({ type: 'archive', ticketId: 8 }, a);
    routeSidebarAction({ type: 'create' }, a);

    expect(a.setFacet).toHaveBeenCalledWith('failed');
    expect(a.setFilter).toHaveBeenCalledWith('q');
    expect(a.spin).toHaveBeenCalledWith(7);
    expect(a.archive).toHaveBeenCalledWith(8);
    expect(a.create).toHaveBeenCalledOnce();
  });

  it('drops malformed messages without calling any action', () => {
    const a = makeActions();
    routeSidebarAction({ type: 'spin', ticketId: 'x' }, a);
    routeSidebarAction(null, a);
    expect(a.spin).not.toHaveBeenCalled();
  });
});
