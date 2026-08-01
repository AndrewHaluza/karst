import { describe, it, expect, vi } from 'vitest';
import { parseUsageMessage, routeUsageAction, type UsageActions } from './messages.js';

function actions(): UsageActions & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    requestState: () => calls.push('requestState'),
    setRange: (r) => calls.push(`setRange:${r}`),
    setSort: (s) => calls.push(`setSort:${s}`),
    setPage: (o) => calls.push(`setPage:${o}`),
    openDashboard: (id) => calls.push(`openDashboard:${id}`),
  };
}

describe('parseUsageMessage', () => {
  it('accepts every well-formed message', () => {
    expect(parseUsageMessage({ type: 'request-state' })).toEqual({ type: 'request-state' });
    expect(parseUsageMessage({ type: 'set-range', range: '7d' })).toEqual({
      type: 'set-range',
      range: '7d',
    });
    expect(parseUsageMessage({ type: 'set-sort', sort: 'calls' })).toEqual({
      type: 'set-sort',
      sort: 'calls',
    });
    expect(parseUsageMessage({ type: 'set-page', offset: 50 })).toEqual({
      type: 'set-page',
      offset: 50,
    });
    expect(parseUsageMessage({ type: 'open-dashboard', ticketId: 3 })).toEqual({
      type: 'open-dashboard',
      ticketId: 3,
    });
  });

  it('rejects a range or sort outside the closed set — both reach a SQL query', () => {
    expect(parseUsageMessage({ type: 'set-range', range: '90d' })).toBeNull();
    expect(parseUsageMessage({ type: 'set-range', range: "all'; DROP" })).toBeNull();
    expect(parseUsageMessage({ type: 'set-sort', sort: 'total_tokens; DROP TABLE' })).toBeNull();
    expect(parseUsageMessage({ type: 'set-sort', sort: 7 })).toBeNull();
  });

  it('rejects a malformed page or ticket id', () => {
    expect(parseUsageMessage({ type: 'set-page', offset: -1 })).toBeNull();
    expect(parseUsageMessage({ type: 'set-page', offset: 1.5 })).toBeNull();
    expect(parseUsageMessage({ type: 'set-page', offset: '10' })).toBeNull();
    expect(parseUsageMessage({ type: 'open-dashboard', ticketId: 'K-1' })).toBeNull();
    expect(parseUsageMessage({ type: 'open-dashboard' })).toBeNull();
  });

  it('rejects a non-message', () => {
    expect(parseUsageMessage(null)).toBeNull();
    expect(parseUsageMessage('set-range')).toBeNull();
    expect(parseUsageMessage({ type: 'delete-everything' })).toBeNull();
  });
});

describe('routeUsageAction', () => {
  it('routes each message to its action', () => {
    const a = actions();
    routeUsageAction({ type: 'request-state' }, a);
    routeUsageAction({ type: 'set-range', range: '24h' }, a);
    routeUsageAction({ type: 'set-sort', sort: 'output' }, a);
    routeUsageAction({ type: 'set-page', offset: 20 }, a);
    routeUsageAction({ type: 'open-dashboard', ticketId: 9 }, a);
    expect(a.calls).toEqual([
      'requestState',
      'setRange:24h',
      'setSort:output',
      'setPage:20',
      'openDashboard:9',
    ]);
  });

  it('drops a malformed message instead of acting on it', () => {
    const a = actions();
    const spy = vi.fn();
    routeUsageAction({ type: 'set-range', range: 'forever' }, { ...a, setRange: spy });
    routeUsageAction(undefined, a);
    expect(spy).not.toHaveBeenCalled();
    expect(a.calls).toEqual([]);
  });
});
