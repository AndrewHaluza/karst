import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openStore, type Store } from '../../store/db.js';
import { createTicket } from '../../store/tickets.js';
import type { MergeAllPlan } from '../../workflow/mergePr.js';
import { mergeAllModal, mergeAllOp, type MergeAllModal, type MergeAllOpsDeps } from './mergeAllOps.js';

const item = (repo: string, number: number | null, baseRef: string | null) => ({ repo, name: repo, number, baseRef });

describe('mergeAllModal', () => {
  it('lists each PR with its base, the skipped ones, and the failure rule', () => {
    const plan: MergeAllPlan = { ready: [item('api', 7, 'main'), item('web', 9, 'develop')], skipped: [item('docs', 3, 'main')] };
    expect(mergeAllModal(plan)).toEqual({
      title: 'Merge 2 pull requests?',
      confirm: 'Merge 2',
      detail: [
        'api #7 → main\nweb #9 → develop',
        'Skipped (blocked): docs #3',
        'Each merges into its own base, one after another. If one fails, the rest stop and the failure is shown on its row.',
      ].join('\n\n'),
    });
  });

  it('uses the singular, drops an unknown base or number, and omits the skipped line when none is skipped', () => {
    const m = mergeAllModal({ ready: [item('api', null, null)], skipped: [] });
    expect(m.title).toBe('Merge 1 pull request?');
    expect(m.confirm).toBe('Merge 1');
    expect(m.detail.startsWith('api\n\nEach merges')).toBe(true);
    expect(m.detail).not.toContain('Skipped');
  });
});

describe('mergeAllOp', () => {
  let store: Store;
  beforeEach(() => (store = openStore(':memory:')));
  afterEach(() => store.close());

  function setup(over: Partial<MergeAllOpsDeps> = {}, seedBlocked = false) {
    const t = createTicket(store, { key: 'A', title: 'a' });
    const status = seedBlocked ? 'blocked' : 'clean';
    store.db
      .prepare("INSERT INTO prs (ticket_id, repo, number, url, status, base_ref, merge_block) VALUES (?, 'api', 7, 'https://github.com/o/api/pull/7', 'open', 'main', ?)")
      .run(t.id, status);
    const calls = { info: [] as string[], error: [] as string[], modal: [] as MergeAllModal[], done: 0, settled: 0, completed: 0 };
    const deps: MergeAllOpsDeps = {
      store,
      ticketId: t.id,
      repoOrder: () => ['api'],
      repoNameFor: () => undefined,
      now: () => '2026-11-10T12:00:00Z',
      refresh: async () => undefined,
      autofixRunning: () => false,
      askModal: async (m) => {
        calls.modal.push(m);
        return true;
      },
      info: (m) => calls.info.push(m),
      error: (m) => calls.error.push(m),
      logError: vi.fn(),
      debug: vi.fn(),
      onTicketCompleted: async () => {
        calls.completed++;
      },
      afterServerChange: () => {
        calls.settled++;
      },
      ...over,
    };
    return { deps, calls };
  }

  it('says why when it is refused, shows no modal, and still settles the webview', async () => {
    const { deps, calls } = setup({ autofixRunning: () => true });
    await mergeAllOp(deps);
    expect(calls.info).toEqual(['An auto-fix round is running']);
    expect(calls.modal).toEqual([]);
    expect(calls.settled).toBe(1);
  });

  it('stays silent on Cancel', async () => {
    const { deps, calls } = setup({ askModal: async () => false });
    await mergeAllOp(deps);
    expect(calls.info).toEqual([]);
    expect(calls.error).toEqual([]);
    expect(calls.settled).toBe(1);
  });

  it('reports an unexpected error and still settles', async () => {
    const logError = vi.fn();
    const { deps, calls } = setup({ refresh: async () => { throw new Error('gh is down'); }, logError });
    await mergeAllOp(deps);
    expect(calls.error).toEqual(['Merge all failed: gh is down']);
    expect(logError).toHaveBeenCalledTimes(1);
    expect(calls.settled).toBe(1);
  });

  const OK = { ok: true, status: 'merged', completedTicket: false, reason: '' } as const;

  it('reports the merged count', async () => {
    const { deps, calls } = setup({ merge: async () => OK });
    await mergeAllOp(deps);
    expect(calls.modal[0]!.title).toBe('Merge 1 pull request?');
    expect(calls.info).toEqual(['Merged 1 pull request.']);
    expect(calls.completed).toBe(0);
  });

  it('reports a finished ticket and pushes the status once', async () => {
    const { deps, calls } = setup({ merge: async () => ({ ...OK, completedTicket: true }) });
    await mergeAllOp(deps);
    expect(calls.info).toEqual(['Merged 1 pull request — ticket done.']);
    expect(calls.completed).toBe(1);
  });

  it('shows the first failure as an error and says the rest were not merged', async () => {
    const { deps, calls } = setup({ merge: async () => ({ ...OK, ok: false, status: 'open', reason: 'checks pending' }) });
    await mergeAllOp(deps);
    expect(calls.error).toEqual(['Merge failed for api #7: checks pending The rest were not merged.']);
    expect(calls.info).toEqual([]);
    expect(calls.settled).toBe(1);
  });
});
