import { describe, expect, it, vi } from 'vitest';
import { createSetupProposalOps, type SetupEditWiring, type SetupVerifyWiring } from './setupProposalOps.js';
import { parseManifestText } from '../../manifest/load.js';
import type { EditOpFile } from '../../setup/editOps.js';
import type { ProposalResult } from '../../setup/ledger.js';
import { BASE_YAML, fakeEnvProbe, fakeVerifyDeps } from '../../setup/verify/verify.testutil.js';
import type { VerifyRecord } from '../../setup/verify/types.js';

const op = (id: string, tool: string, input: Record<string, unknown>, seq = '000000000000001'): EditOpFile => ({ id, seq, tool, input });
const SET_GENERAL = (id: string, patch: Record<string, unknown>): EditOpFile => op(id, 'set-general', patch);

function setup(
  initial: EditOpFile[],
  text: string | undefined = BASE_YAML,
  clock = 1_000_000,
  opts: { scaffold?: string; manifestPath?: string; noFile?: boolean } = {},
) {
  if (opts.noFile) text = undefined;
  let ops = [...initial];
  const results: ProposalResult[] = [];
  const records: VerifyRecord[] = [];
  let current = text;
  const base = fakeVerifyDeps({ text, ...(opts.manifestPath !== undefined ? { manifestPath: opts.manifestPath } : {}) });
  const verify: SetupVerifyWiring = {
    deps: { ...base, readCurrentText: () => current },
    recheck: vi.fn(async (ids: readonly string[]) => ids.map((id) => ({ id, status: 'ok' as const, detail: '' }))),
    writeRecord: (r) => void records.push(r),
  };
  const applyText = vi.fn((t: string) => {
    current = t;
    return 'sha-edit';
  });
  const edits: SetupEditWiring = {
    readOps: () => ops,
    removeOps: (_s, ids) => void (ops = ops.filter((o) => !ids.includes(o.id))),
    scaffoldText: () => opts.scaffold,
    applyText,
  };
  const confirm = vi.fn(async (_d: { message: string; detail: string }) => true);
  const warn = vi.fn();
  const debug = vi.fn();
  const manifest = () => (current === undefined ? undefined : parseManifestText(current, '/w/karst.yml', fakeEnvProbe()).manifest);
  const ctl = createSetupProposalOps({
    verify: () => verify,
    outboxes: () => ['/s/1'],
    readCurrentManifest: manifest,
    confirm,
    applyManifest: vi.fn(() => 'x'),
    runCommand: vi.fn(),
    applyPatch: vi.fn(),
    resolveDir: () => ({ ok: true as const, dir: '/w' }),
    notify: { info: vi.fn(), warn } as never,
    fs: {
      readdir: () => [], readFile: () => '', remove: () => undefined, exists: () => false, mtime: () => 0,
      writeResult: (_d, r) => void results.push(r),
    },
    edits,
    debug,
    now: () => clock,
  });
  return { ctl, debug, confirm, applyText, results, records, warn, ops: () => ops, setOps: (o: EditOpFile[]) => void (ops = o), setText: (t: string) => void (current = t) };
}

describe('the typed edit list', () => {
  it('shows one popup for all ops, applies the built text and verifies', async () => {
    const f = setup([SET_GENERAL('a-1', { baselineBranch: 'dev' }), SET_GENERAL('a-2', { debug: true })]);
    await f.ctl.scan();
    expect(f.confirm).toHaveBeenCalledOnce();
    const d = f.confirm.mock.calls[0]![0];
    expect(d.message).toContain('2 setup edit(s)');
    expect(d.detail).toContain('PROTECTED');
    expect(d.detail).toContain('baselineBranch');
    expect(f.applyText).toHaveBeenCalledOnce();
    expect(f.applyText.mock.calls[0]![0]).toContain('baselineBranch: dev');
    expect(f.ops()).toEqual([]);
    expect(f.results.map((r) => [r.id, r.kind, r.status])).toEqual([
      ['a-1', 'edit', 'verified'],
      ['a-2', 'edit', 'applied'],
    ]);
    expect(f.records.at(-1)).toMatchObject({ id: 'a-1', kind: 'edit', status: 'verified' });
  });

  it('writes nothing when the user declines, and removes the shown ops', async () => {
    const f = setup([SET_GENERAL('a-1', { debug: true })]);
    f.confirm.mockResolvedValue(false);
    await f.ctl.scan();
    expect(f.applyText).not.toHaveBeenCalled();
    expect(f.ops()).toEqual([]);
    expect(f.results).toMatchObject([{ id: 'a-1', status: 'declined' }]);
  });

  it('applies nothing and keeps the list when an op is withdrawn during the popup', async () => {
    const f = setup([SET_GENERAL('a-1', { debug: true }), SET_GENERAL('a-2', { baselineBranch: 'dev' })]);
    f.confirm.mockImplementation(async () => {
      f.setOps(f.ops().slice(1));
      return true;
    });
    await f.ctl.scan();
    expect(f.applyText).not.toHaveBeenCalled();
    expect(f.ops().map((o) => o.id)).toEqual(['a-2']);
  });

  it('applies nothing when an op is added during the popup', async () => {
    const f = setup([SET_GENERAL('a-1', { debug: true })]);
    f.confirm.mockImplementation(async () => {
      f.setOps([...f.ops(), SET_GENERAL('a-2', { baselineBranch: 'dev' })]);
      return true;
    });
    await f.ctl.scan();
    expect(f.applyText).not.toHaveBeenCalled();
    expect(f.ops()).toHaveLength(2);
  });

  it('refuses the apply when karst.yml moved while the popup was open', async () => {
    const f = setup([SET_GENERAL('a-1', { debug: true })]);
    f.confirm.mockImplementation(async () => {
      f.setText(BASE_YAML + 'archiveDoneAfterDays: 3\n');
      return true;
    });
    await f.ctl.scan();
    expect(f.applyText).not.toHaveBeenCalled();
    expect(f.results).toMatchObject([{ id: 'a-1', status: 'invalid' }]);
    expect(f.results[0]!.reason).toContain('changed after the host checks');
  });

  it('reports a failed build with its reason and prompts nothing', async () => {
    const f = setup([op('a-1', 'remove-repo', { name: 'nope' })]);
    await f.ctl.scan();
    expect(f.confirm).not.toHaveBeenCalled();
    expect(f.results).toMatchObject([{ id: 'a-1', kind: 'edit', status: 'invalid' }]);
    expect(f.results[0]!.reason).toContain('does not exist');
    expect(f.ops()).toEqual([]);
    expect(f.warn).toHaveBeenCalled();
  });

  it('reports no change when the ops leave the file as it is', async () => {
    const f = setup([SET_GENERAL('a-1', { baselineBranch: 'main' })]);
    await f.ctl.scan();
    expect(f.confirm).not.toHaveBeenCalled();
    expect(f.results).toMatchObject([{ id: 'a-1', status: 'no-change' }]);
  });

  it('holds a fresh list for the quiet window and reports when it is due', async () => {
    const f = setup([op('a-1', 'set-general', { debug: true }, '000000000999000')], BASE_YAML, 1_000_000);
    await f.ctl.scan();
    expect(f.confirm).not.toHaveBeenCalled();
    expect(f.ctl.editWaitMs()).toBe(3000);
    expect(f.ops()).toHaveLength(1);
  });

  it('does nothing for an empty list and ignores the list when the wiring is absent', async () => {
    const f = setup([]);
    await f.ctl.scan();
    expect(f.confirm).not.toHaveBeenCalled();
  });

  it('records a failed apply write as invalid', async () => {
    const f = setup([SET_GENERAL('a-1', { debug: true })]);
    f.applyText.mockImplementation(() => {
      throw new Error('disk full');
    });
    await f.ctl.scan();
    expect(f.results).toMatchObject([{ id: 'a-1', status: 'invalid' }]);
    expect(f.results[0]!.reason).toContain('disk full');
  });

  it('names each outcome with an exact reason and message', async () => {
    const declined = setup([SET_GENERAL('a-1', { debug: true })]);
    declined.confirm.mockResolvedValue(false);
    await declined.ctl.scan();
    expect(declined.results[0]!.reason).toBe('declined by the user');

    const same = setup([SET_GENERAL('a-1', { baselineBranch: 'main' })]);
    await same.ctl.scan();
    expect(same.results[0]!.reason).toBe('no effective change');
    expect(same.warn).toHaveBeenCalledWith('Karst: the setup edits change nothing.');

    const failed = setup([SET_GENERAL('a-1', { debug: true })]);
    failed.applyText.mockImplementation(() => {
      throw new Error('disk full');
    });
    await failed.ctl.scan();
    expect(failed.results[0]!.reason).toBe('apply failed: disk full');
    expect(failed.warn).toHaveBeenCalledWith('Karst: could not apply the setup edits (disk full).');
  });

  it('refuses a list that fails a host check and records the refusal', async () => {
    const f = setup([SET_GENERAL('a-1', { debug: true })], BASE_YAML, 1_000_000, { manifestPath: '/w/other.yml' });
    await f.ctl.scan();
    expect(f.confirm).not.toHaveBeenCalled();
    expect(f.applyText).not.toHaveBeenCalled();
    expect(f.results).toMatchObject([{ id: 'a-1', kind: 'edit', status: 'invalid' }]);
    expect(f.results[0]!.reason).toMatch(/^P2 /);
    expect(f.warn).toHaveBeenCalledWith(expect.stringMatching(/^Karst: the setup edits failed the host checks \(P2 .*\); ignored\.$/));
    expect(f.records.at(-1)).toMatchObject({ id: 'a-1', kind: 'edit', status: 'refused' });
  });

  it('applies nothing when the list is the same length but holds another op', async () => {
    const f = setup([SET_GENERAL('a-1', { debug: true }), SET_GENERAL('a-2', { baselineBranch: 'dev' })]);
    f.confirm.mockImplementation(async () => {
      f.setOps([SET_GENERAL('a-1', { debug: true }), SET_GENERAL('a-3', { baselineBranch: 'dev' })]);
      return true;
    });
    await f.ctl.scan();
    expect(f.applyText).not.toHaveBeenCalled();
    expect(f.ops().map((o) => o.id)).toEqual(['a-1', 'a-3']);
  });

  it('applies nothing when the same ops come back in another order', async () => {
    const f = setup([SET_GENERAL('a-1', { debug: true }), SET_GENERAL('a-2', { baselineBranch: 'dev' })]);
    f.confirm.mockImplementation(async () => {
      f.setOps([...f.ops()].reverse());
      return true;
    });
    await f.ctl.scan();
    expect(f.applyText).not.toHaveBeenCalled();
  });

  it('holds the list by its newest op and shows it once the window ends', async () => {
    const fresh = [op('a-1', 'set-general', { debug: true }, '000000000000001'), op('a-2', 'set-general', { baselineBranch: 'dev' }, '000000000999000')];
    const held = setup(fresh, BASE_YAML, 1_000_000);
    await held.ctl.scan();
    expect(held.confirm).not.toHaveBeenCalled();
    expect(held.ctl.editWaitMs()).toBe(3000);

    const near = setup([op('a-1', 'set-general', { debug: true }, '000000000997000')], BASE_YAML, 1_000_000);
    await near.ctl.scan();
    expect(near.confirm).not.toHaveBeenCalled();
    expect(near.ctl.editWaitMs()).toBe(1000);
  });

  it('shows the list when its newest op is exactly one quiet window old', async () => {
    const f = setup([op('a-1', 'set-general', { debug: true }, '000000000996000')], BASE_YAML, 1_000_000);
    await f.ctl.scan();
    expect(f.confirm).toHaveBeenCalledOnce();
  });

  it('builds from the scaffold on first setup and tells the checklist it is a first setup', async () => {
    const f = setup([SET_GENERAL('a-1', { baselineBranch: 'dev' })], BASE_YAML, 1_000_000, { scaffold: BASE_YAML, noFile: true });
    await f.ctl.scan();
    expect(f.confirm).toHaveBeenCalledOnce();
    expect(f.applyText.mock.calls[0]![0]).toContain('baselineBranch: dev');
    expect(f.records.at(-1)!.steps.find((i) => i.id === 'P5')?.status).toBe('info');
  });

  it('records the sha256 on every applied op and the apply on the verify record', async () => {
    const f = setup([SET_GENERAL('a-1', { baselineBranch: 'dev' }), SET_GENERAL('a-2', { debug: true })]);
    await f.ctl.scan();
    expect(f.results.map((r) => r.sha256)).toEqual(['sha-edit', 'sha-edit']);
    expect(f.records.at(-1)!.steps.find((i) => i.id === 'A1')).toMatchObject({ status: 'ok' });
  });

  it('applies nothing and logs when the last op is withdrawn during the popup', async () => {
    const f = setup([SET_GENERAL('a-1', { debug: true }), SET_GENERAL('a-2', { baselineBranch: 'dev' })]);
    f.confirm.mockImplementation(async () => {
      f.setOps(f.ops().slice(0, 1));
      return true;
    });
    await f.ctl.scan();
    expect(f.applyText).not.toHaveBeenCalled();
    expect(f.debug).toHaveBeenCalledWith('[setup] the edit list changed while its consent was open');
    expect(f.warn).toHaveBeenCalledWith(expect.stringContaining('changed while the popup was open'));
  });

  it('records nothing for an empty list', async () => {
    const f = setup([]);
    await f.ctl.scan();
    expect(f.results).toEqual([]);
    expect(f.records).toEqual([]);
    expect(f.warn).not.toHaveBeenCalled();
  });

  it('keeps the build reason in the refusal record of a failed build', async () => {
    const f = setup([op('a-1', 'remove-repo', { name: 'nope' })]);
    await f.ctl.scan();
    expect(f.records.at(-1)).toMatchObject({ kind: 'edit', status: 'refused' });
    expect(f.records.at(-1)!.steps.find((s) => s.id === 'P3')!.detail).toContain('does not exist');
  });

  it('records a refusal when the apply write fails', async () => {
    const f = setup([SET_GENERAL('a-1', { debug: true })]);
    f.applyText.mockImplementation(() => {
      throw new Error('disk full');
    });
    await f.ctl.scan();
    expect(f.records.at(-1)).toMatchObject({ id: 'a-1', kind: 'edit', status: 'refused' });
  });

  it('applies a fix that clears an item even when it changes no field path', async () => {
    const f = setup([op('a-1', 'fix', { code: 'manifest.legacy-services' })], BASE_YAML.replace('repositories:', 'services:'));
    await f.ctl.scan();
    expect(f.confirm).toHaveBeenCalledOnce();
    expect(f.applyText).toHaveBeenCalledOnce();
  });

  it('does not hold the list for an op with a seq in the future', async () => {
    const f = setup([{ ...SET_GENERAL('a-1', { debug: true }), seq: String(9_000_000_000) }]);
    await f.ctl.scan();
    expect(f.confirm).toHaveBeenCalledOnce();
  });

  it('holds the list for an op written at this very moment', async () => {
    const f = setup([{ ...SET_GENERAL('a-1', { debug: true }), seq: '1000000' }]);
    await f.ctl.scan();
    expect(f.confirm).not.toHaveBeenCalled();
    expect(f.ctl.editWaitMs()).toBe(4000);
  });
});
