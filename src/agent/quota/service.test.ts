import { describe, it, expect, vi } from 'vitest';
import { QuotaService, defaultQuotaReaders } from './service.js';
import type { QuotaReader, QuotaSnapshot } from './types.js';

function okReader(core: QuotaSnapshot['core'], usedPct: number): QuotaReader {
  return {
    core,
    read: () => ({
      core,
      state: 'ok',
      windows: [{ label: 'w', usedPct, resetsAt: null }],
      source: 'test',
      readAt: '2026-01-01T00:00:00.000Z',
    }),
  };
}

describe('QuotaService', () => {
  it('caches one snapshot per reader and never reads on snapshots()', () => {
    const read = vi.fn(() => okReader('codex', 10).read());
    const service = new QuotaService({ readers: [{ core: 'codex', read }] });
    expect(service.snapshots()).toEqual([]);
    expect(read).not.toHaveBeenCalled();
    service.refresh();
    expect(read).toHaveBeenCalledTimes(1);
    expect(service.get('codex')).toMatchObject({ core: 'codex', state: 'ok' });
    expect(service.snapshots()).toHaveLength(1);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('turns a throwing reader into that core unknown, leaving the others, and logs', () => {
    const debug = vi.fn();
    const service = new QuotaService({
      readers: [
        {
          core: 'codex',
          read: () => {
            throw new Error('boom');
          },
        },
        okReader('claude', 42),
      ],
      debug,
    });
    service.refresh();
    expect(service.get('codex')).toMatchObject({ state: 'unknown' });
    expect(service.get('claude')).toMatchObject({ state: 'ok' });
    expect(debug).toHaveBeenCalledWith(expect.stringContaining('codex'));
  });

  it('notifies onDidChange after a refresh', () => {
    const onDidChange = vi.fn();
    const service = new QuotaService({ readers: [okReader('codex', 10)], onDidChange });
    service.refresh();
    expect(onDidChange).toHaveBeenCalledWith([expect.objectContaining({ core: 'codex' })]);
  });

  it('start() refreshes once and is idempotent; dispose() clears the timer', () => {
    vi.useFakeTimers();
    try {
      const read = vi.fn(() => okReader('codex', 10).read());
      const service = new QuotaService({ readers: [{ core: 'codex', read }], pollMs: 1000 });
      service.start();
      service.start();
      expect(read).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(1000);
      expect(read).toHaveBeenCalledTimes(2);
      service.dispose();
      vi.advanceTimersByTime(5000);
      expect(read).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('defaultQuotaReaders', () => {
  it('registers one reader per core, in display order', () => {
    const readers = defaultQuotaReaders({ homeDir: '/nope', now: () => new Date(0) });
    expect(readers.map((r) => r.core)).toEqual([
      'claude',
      'codex',
      'antigravity',
      'opencode',
      'opencode2',
    ]);
  });

  it('marks the unsupported cores unknown with a reason', () => {
    const readers = defaultQuotaReaders({ homeDir: '/nope', now: () => new Date(0) });
    for (const core of ['antigravity', 'opencode', 'opencode2'] as const) {
      const snap = readers.find((r) => r.core === core)!.read();
      expect(snap).toMatchObject({ core, state: 'unknown' });
      expect(snap.state === 'unknown' && snap.reason.length).toBeGreaterThan(0);
    }
  });
});
