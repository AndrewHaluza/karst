import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Store } from '../../store/db.js';
import { autoFireImplMarker } from './graphAutoMarker.js';
import { tryAutoFireGraphImplMarker } from '../../workflow/graphMarkerGuard.js';

vi.mock('../../workflow/graphMarkerGuard.js', () => ({ tryAutoFireGraphImplMarker: vi.fn() }));

const store = { tag: 'store' } as unknown as Store;
const guard = vi.mocked(tryAutoFireGraphImplMarker);

function deps(over: Record<string, unknown> = {}) {
  return { store, debug: vi.fn(), drive: vi.fn(), refresh: vi.fn(), now: () => 'NOW', ...over };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('autoFireImplMarker outcomes', () => {
  it('drives and refreshes the ticket when the marker fires, logging the run', async () => {
    guard.mockReturnValue({ kind: 'fired', graphRunId: 4 });
    const d = deps();
    await autoFireImplMarker(d, 7, 4);
    expect(d.debug).toHaveBeenCalledWith('[graph] run 4: auto impl marker fired');
    expect(d.drive).toHaveBeenCalledWith(7);
    expect(d.refresh).toHaveBeenCalledWith(7);
  });

  it('passes only the store, ids and now to the guard, with no docs pre-check', async () => {
    guard.mockReturnValue({ kind: 'busy' });
    const now = () => 'T0';
    await autoFireImplMarker(deps({ now }), 7, 4);
    expect(guard).toHaveBeenCalledWith(store, 7, 4, now);
    expect(guard.mock.calls[0]).toHaveLength(4);
  });

  it('uses a real clock when no now is injected', async () => {
    guard.mockReturnValue({ kind: 'busy' });
    await autoFireImplMarker(deps({ now: undefined }), 7, 4);
    const clock = guard.mock.calls[0]![3];
    expect(clock()).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it('logs a first refusal with its reason and refreshes', async () => {
    guard.mockReturnValue({ kind: 'refused', reason: 'open blocking sub-tasks', firstTime: true });
    const d = deps();
    await autoFireImplMarker(d, 7, 4);
    expect(d.debug).toHaveBeenCalledWith('[graph] run 4: auto impl marker refused — open blocking sub-tasks');
    expect(d.refresh).toHaveBeenCalledWith(7);
    expect(d.drive).not.toHaveBeenCalled();
  });

  it('stays quiet on a repeated refusal', async () => {
    guard.mockReturnValue({ kind: 'refused', reason: 'r', firstTime: false });
    const d = deps();
    await autoFireImplMarker(d, 7, 4);
    expect(d.debug).not.toHaveBeenCalled();
    expect(d.refresh).not.toHaveBeenCalled();
  });

  it('refreshes a first paused report without logging or driving', async () => {
    guard.mockReturnValue({ kind: 'paused', firstTime: true });
    const d = deps();
    await autoFireImplMarker(d, 7, 4);
    expect(d.refresh).toHaveBeenCalledWith(7);
    expect(d.debug).not.toHaveBeenCalled();
    expect(d.drive).not.toHaveBeenCalled();
  });

  it('stays quiet on a repeated paused report', async () => {
    guard.mockReturnValue({ kind: 'paused', firstTime: false });
    const d = deps();
    await autoFireImplMarker(d, 7, 4);
    expect(d.refresh).not.toHaveBeenCalled();
  });

  it('does nothing visible on a busy lock', async () => {
    guard.mockReturnValue({ kind: 'busy' });
    const d = deps();
    await autoFireImplMarker(d, 7, 4);
    expect(d.refresh).not.toHaveBeenCalled();
    expect(d.drive).not.toHaveBeenCalled();
    expect(d.debug).not.toHaveBeenCalled();
  });

  it('logs a guard failure with the run id and does not throw', async () => {
    guard.mockImplementation(() => {
      throw new Error('kaput');
    });
    const d = deps();
    await expect(autoFireImplMarker(d, 7, 4)).resolves.toBeUndefined();
    expect(d.debug).toHaveBeenCalledWith('[graph] run 4: auto impl marker failed — Error: kaput');
  });
});

describe('autoFireImplMarker repeated calls', () => {
  it('runs the guard again for the same run after a failure', async () => {
    guard.mockImplementationOnce(() => {
      throw new Error('x');
    });
    await autoFireImplMarker(deps(), 7, 5);
    guard.mockReturnValue({ kind: 'busy' });
    await autoFireImplMarker(deps(), 7, 5);
    expect(guard).toHaveBeenCalledTimes(2);
  });
});
