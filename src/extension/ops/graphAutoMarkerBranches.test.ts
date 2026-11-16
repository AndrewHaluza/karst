import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Store } from '../../store/db.js';
import { autoFireImplMarker } from './graphAutoMarker.js';
import { tryAutoFireGraphImplMarker } from '../../workflow/graphMarkerGuard.js';
import { assertDocsBlocksWithinCap } from '../../workflow/docsBlockGuard.js';
import { defaultGitRunner } from '../../integrations/git.js';
import { runDocsLint } from '../../cli/docsLintRunner.js';

vi.mock('../../workflow/graphMarkerGuard.js', () => ({ tryAutoFireGraphImplMarker: vi.fn() }));
vi.mock('../../workflow/docsBlockGuard.js', () => ({ assertDocsBlocksWithinCap: vi.fn(async () => undefined) }));

const store = { tag: 'store' } as unknown as Store;
const guard = vi.mocked(tryAutoFireGraphImplMarker);
const docs = vi.mocked(assertDocsBlocksWithinCap);

function deps(over: Record<string, unknown> = {}) {
  return { store, debug: vi.fn(), drive: vi.fn(), refresh: vi.fn(), now: () => 'NOW', ...over };
}

beforeEach(() => {
  vi.clearAllMocks();
  docs.mockResolvedValue(undefined);
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

  it('passes the store, ids, now and the docs refusal to the guard', async () => {
    guard.mockReturnValue({ kind: 'busy' });
    const now = () => 'T0';
    await autoFireImplMarker(deps({ now }), 7, 4);
    expect(guard).toHaveBeenCalledWith(store, 7, 4, now, undefined);
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

describe('autoFireImplMarker in-flight guard', () => {
  it('skips a second call for the same run while one is in flight, then allows it again', async () => {
    guard.mockReturnValue({ kind: 'busy' });
    let release!: () => void;
    docs.mockReturnValueOnce(new Promise<void>((r) => (release = r)));
    const first = autoFireImplMarker(deps(), 7, 4);
    await autoFireImplMarker(deps(), 7, 4);
    expect(guard).not.toHaveBeenCalled();
    release();
    await first;
    expect(guard).toHaveBeenCalledTimes(1);
    await autoFireImplMarker(deps(), 7, 4);
    expect(guard).toHaveBeenCalledTimes(2);
  });

  it('frees the run after a failure', async () => {
    guard.mockImplementationOnce(() => {
      throw new Error('x');
    });
    await autoFireImplMarker(deps(), 7, 5);
    guard.mockReturnValue({ kind: 'busy' });
    await autoFireImplMarker(deps(), 7, 5);
    expect(guard).toHaveBeenCalledTimes(2);
  });
});

describe('autoFireImplMarker docs cap probe', () => {
  it('runs the cap check with the default git and lint runners', async () => {
    guard.mockReturnValue({ kind: 'busy' });
    await autoFireImplMarker(deps(), 7, 4);
    expect(docs).toHaveBeenCalledWith(store, 7, defaultGitRunner, runDocsLint);
  });

  it('prefers the injected git and lint runners', async () => {
    guard.mockReturnValue({ kind: 'busy' });
    const git = vi.fn();
    const runLint = vi.fn();
    await autoFireImplMarker(deps({ git, runLint }), 7, 4);
    expect(docs).toHaveBeenCalledWith(store, 7, git, runLint);
  });

  it('hands a cap refusal message to the guard', async () => {
    guard.mockReturnValue({ kind: 'busy' });
    docs.mockRejectedValueOnce(new Error('cannot mark this stage done: docs block too long'));
    const d = deps();
    await autoFireImplMarker(d, 7, 4);
    expect(guard.mock.calls[0]![4]).toBe('cannot mark this stage done: docs block too long');
    expect(d.debug).not.toHaveBeenCalled();
  });

  it('treats a lint that cannot run as no verdict and logs it', async () => {
    guard.mockReturnValue({ kind: 'busy' });
    docs.mockRejectedValueOnce(new Error('spawn ENOENT'));
    const d = deps();
    await autoFireImplMarker(d, 7, 4);
    expect(guard.mock.calls[0]![4]).toBeUndefined();
    expect(d.debug).toHaveBeenCalledWith('[graph] auto impl marker: docs lint probe unavailable: Error: spawn ENOENT');
  });

  it('treats a thrown non-Error as no verdict', async () => {
    guard.mockReturnValue({ kind: 'busy' });
    docs.mockRejectedValueOnce('cannot mark this stage done: string');
    const d = deps();
    await autoFireImplMarker(d, 7, 4);
    expect(guard.mock.calls[0]![4]).toBeUndefined();
    expect(d.debug).toHaveBeenCalledTimes(1);
  });
});
