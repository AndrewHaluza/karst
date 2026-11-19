import { describe, expect, it, vi } from 'vitest';
import { createSetupProposalOps, type SetupSkipWiring } from './setupProposalOps.js';
import type { ProposalResult } from '../../setup/ledger.js';
import type { PendingSkipRequest } from '../../setup/checklist/skips.js';
import type { SkipRecord } from '../../setup/checklist/types.js';

const request = (id: string, over: Partial<PendingSkipRequest['value']> = {}): PendingSkipRequest => ({
  id,
  file: `/s/1/outbox/skips/${id}.json`,
  value: { code: 'git.conventions', reason: 'the team has no convention yet', ...over },
});

function setup(initial: PendingSkipRequest[], approve = true) {
  let pending = [...initial];
  const recorded: { scratch: string; skip: SkipRecord }[] = [];
  const results: ProposalResult[] = [];
  const removed: string[] = [];
  const skips: SetupSkipWiring = {
    read: () => [...pending],
    remove: (file) => {
      removed.push(file);
      pending = pending.filter((p) => p.file !== file);
    },
    record: (scratch, skip) => void recorded.push({ scratch, skip }),
  };
  const confirm = vi.fn(async (_d: { message: string; detail: string; startCommandsChanged?: boolean }) => approve);
  const ctl = createSetupProposalOps({
    verify: () => { throw new Error('a skip needs no verify'); },
    outboxes: () => ['/s/1'],
    readCurrentManifest: () => undefined,
    confirm,
    applyManifest: vi.fn(() => 'x'),
    runCommand: vi.fn(),
    applyPatch: vi.fn(),
    resolveDir: () => ({ ok: true as const, dir: '/w' }),
    notify: { info: vi.fn(), warn: vi.fn() } as never,
    fs: {
      readdir: () => [], readFile: () => '', remove: () => undefined, exists: () => false, mtime: () => 0,
      writeResult: (_d, r) => void results.push(r),
    },
    skips,
    now: () => 1_000_000,
  });
  return { ctl, confirm, recorded, results, removed, pending: () => pending };
}

describe('skip requests', () => {
  it('asks the user, records the skip host-side on approval and removes the request', async () => {
    const f = setup([request('s-1')]);
    await f.ctl.scan();
    expect(f.confirm).toHaveBeenCalledOnce();
    const d = f.confirm.mock.calls[0]![0];
    expect(d.message).toContain('git.conventions');
    expect(d.detail).toContain('the team has no convention yet');
    expect(f.recorded).toHaveLength(1);
    expect(f.recorded[0]!.scratch).toBe('/s/1');
    expect(f.recorded[0]!.skip).toMatchObject({ code: 'git.conventions', reason: 'the team has no convention yet' });
    expect(f.recorded[0]!.skip.at).not.toBe('');
    expect(Object.keys(f.recorded[0]!.skip).sort()).toEqual(['at', 'code', 'reason']);
    expect(d).toMatchObject({ startCommandsChanged: false });
    expect(d.message).toBe('Skip the setup item git.conventions?');
    expect(d.detail).toBe('The agent proposes to skip this item.\nReason: the team has no convention yet');
    expect(f.removed).toEqual(['/s/1/outbox/skips/s-1.json']);
    expect(f.results).toMatchObject([{ id: 's-1', kind: 'skip', status: 'applied' }]);
  });

  it('records nothing when the user declines', async () => {
    const f = setup([request('s-1')], false);
    await f.ctl.scan();
    expect(f.recorded).toEqual([]);
    expect(f.removed).toHaveLength(1);
    expect(f.results).toMatchObject([{ id: 's-1', kind: 'skip', status: 'declined', reason: 'declined by the user' }]);
  });

  it('names the target in the question', async () => {
    const f = setup([request('s-1', { code: 'repos.registered', target: 'docs' })]);
    await f.ctl.scan();
    expect(f.confirm.mock.calls[0]![0].message).toBe('Skip the setup item repos.registered for docs?');
    expect(f.recorded[0]!.skip.target).toBe('docs');
  });

  it('records nothing when the request is withdrawn during the popup', async () => {
    const f = setup([request('s-1')]);
    f.confirm.mockImplementation(async () => {
      f.pending().length = 0;
      return true;
    });
    await f.ctl.scan();
    expect(f.recorded).toEqual([]);
    expect(f.results).toMatchObject([{ id: 's-1', kind: 'skip', status: 'withdrawn', reason: 'withdrawn while awaiting consent' }]);
  });

  it('a withdrawal of one request does not hide another request that stays pending', async () => {
    const f = setup([request('s-1'), request('s-2', { code: 'uat.paths' })]);
    f.confirm.mockImplementationOnce(async () => {
      f.pending().splice(0, 1);
      return true;
    });
    await f.ctl.scan();
    expect(f.recorded.map((r) => r.skip.code)).toEqual(['uat.paths']);
    expect(f.results.map((r) => r.status)).toEqual(['withdrawn', 'applied']);
  });

  it('ignores skip requests when no skip wiring exists', async () => {
    const confirm = vi.fn(async () => true);
    const ctl = createSetupProposalOps({
      verify: () => { throw new Error('unused'); },
      outboxes: () => ['/s/1'], readCurrentManifest: () => undefined, confirm,
      applyManifest: vi.fn(() => 'x'), runCommand: vi.fn(), applyPatch: vi.fn(),
      resolveDir: () => ({ ok: true as const, dir: '/w' }), notify: { info: vi.fn(), warn: vi.fn() } as never,
      fs: { readdir: () => [], readFile: () => '', remove: () => undefined, exists: () => false, mtime: () => 0, writeResult: () => undefined },
    });
    await ctl.scan();
    expect(confirm).not.toHaveBeenCalled();
  });
});
