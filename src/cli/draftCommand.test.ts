import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, realpathSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MAX_PROPOSAL_BYTES } from '../planning/proposal.js';
import { runDraftCommand, type DraftProposeDeps } from './draftCommand.js';
import { writeOutboxRejection } from '../planning/proposalIndex.js';

const proposal = { title: 'Add auth', description: 'JWT', summary: 'Decided JWT', repos: ['api'] };

describe('draft propose / draft list', () => {
  let dir: string;
  let outbox: string;
  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'karst-propose-')));
    outbox = join(dir, 'outbox');
    mkdirSync(outbox);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  // `timeoutMs: 0` by default: with no host running the bounded id wait returns
  // immediately (no real 10s sleep in tests). Individual tests override it.
  const run = (
    argv: string[],
    stdin: string,
    env: string | null = outbox,
    extra: Partial<DraftProposeDeps> = {},
  ): string =>
    runDraftCommand(argv, { outboxEnv: env ?? undefined, readStdin: () => stdin, timeoutMs: 0, ...extra });

  const fileUuid = (): string => readdirSync(outbox).find((f) => f.endsWith('.json'))!.replace(/\.json$/, '');
  const writeIndex = (entries: unknown[]): void => writeFileSync(join(dir, 'proposals.json'), JSON.stringify(entries));
  const idx = (uuid: string, over: Record<string, unknown> = {}) => ({
    id: 42, uuid, title: 'Add auth', status: 'pending', updatedAt: 'now', ...over,
  });

  it('fails at once with the host rejection reason', () => {
    let clock = 0;
    let sleeps = 0;
    const sleep = (ms: number): void => {
      clock += ms;
      sleeps += 1;
      writeOutboxRejection(dir, { uuid: fileUuid(), reason: 'unknown repositories api', rejectedAt: 'now' });
    };
    expect(() =>
      run(['draft', 'propose'], JSON.stringify(proposal), outbox, { timeoutMs: 10_000, now: () => clock, sleep }),
    ).toThrow('karst draft propose: rejected by host (unknown repositories api)');
    expect(sleeps).toBe(1);
  });

  it('returns the host warnings with a revise hint', () => {
    let clock = 0;
    const sleep = (ms: number): void => {
      clock += ms;
      writeIndex([idx(fileUuid(), { warnings: ['unknown design key @arch:NOPE'] })]);
    };
    const out = JSON.parse(
      run(['draft', 'propose'], JSON.stringify(proposal), outbox, { timeoutMs: 10_000, now: () => clock, sleep }),
    );
    expect(out).toMatchObject({ ok: true, id: 42, ref: 'D42', warnings: ['unknown design key @arch:NOPE'] });
    expect(out.hint).toContain('"id":42');
    expect('checksPending' in out).toBe(false);
  });

  it('omits warnings and hint for a clean draft', () => {
    let clock = 0;
    const sleep = (ms: number): void => {
      clock += ms;
      writeIndex([idx(fileUuid())]);
    };
    const out = JSON.parse(
      run(['draft', 'propose'], JSON.stringify(proposal), outbox, { timeoutMs: 10_000, now: () => clock, sleep }),
    );
    expect(out).toEqual({ ok: true, file: out.file, id: 42, ref: 'D42' });
  });

  it('waits for the async checks and returns their warnings', () => {
    let clock = 0;
    let sleeps = 0;
    const sleep = (ms: number): void => {
      clock += ms;
      sleeps += 1;
      writeIndex([sleeps === 1 ? idx(fileUuid(), { checking: true }) : idx(fileUuid(), { warnings: ['unknown commit abc1234'] })]);
    };
    const out = JSON.parse(
      run(['draft', 'propose'], JSON.stringify(proposal), outbox, { timeoutMs: 10_000, now: () => clock, sleep }),
    );
    expect(out).toMatchObject({ id: 42, warnings: ['unknown commit abc1234'] });
    expect(sleeps).toBe(2);
  });

  it('returns checksPending when the deadline passes mid-check', () => {
    let clock = 0;
    const sleep = (ms: number): void => {
      clock += ms;
      writeIndex([idx(fileUuid(), { checking: true })]);
    };
    const out = JSON.parse(
      run(['draft', 'propose'], JSON.stringify(proposal), outbox, { timeoutMs: 300, now: () => clock, sleep }),
    );
    expect(out).toMatchObject({ ok: true, id: 42, ref: 'D42', checksPending: true });
    expect('warnings' in out).toBe(false);
  });

  it('draft list adds warnings only to a flagged draft', () => {
    writeIndex([idx('u1', { id: 1, warnings: ['w'] }), idx('u2', { id: 2 })]);
    expect(JSON.parse(run(['draft', 'list'], ''))).toEqual([
      { id: 1, ref: 'D1', status: 'pending', title: 'Add auth', warnings: ['w'] },
      { id: 2, ref: 'D2', status: 'pending', title: 'Add auth' },
    ]);
  });

  it('writes one uuid-named proposal file atomically and prints its path', () => {
    const out = JSON.parse(run(['draft', 'propose'], JSON.stringify(proposal)));
    const files = readdirSync(outbox);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^[0-9a-f-]{36}\.json$/);
    expect(out).toMatchObject({ ok: true, file: join(outbox, files[0]!), id: null });
    expect('ref' in out).toBe(false);
    expect(JSON.parse(readFileSync(out.file, 'utf8'))).toEqual(proposal);
  });

  it('prints the host-assigned id by polling the index for its uuid', () => {
    let clock = 0;
    const sleep = (ms: number): void => {
      clock += ms;
      const uuid = readdirSync(outbox).find((f) => f.endsWith('.json'))!.replace(/\.json$/, '');
      writeFileSync(
        join(dir, 'proposals.json'),
        JSON.stringify([{ id: 42, uuid, title: 'Add auth', status: 'pending', updatedAt: 'now' }]),
      );
    };
    const out = JSON.parse(
      run(['draft', 'propose'], JSON.stringify(proposal), outbox, { timeoutMs: 10_000, now: () => clock, sleep }),
    );
    expect(out).toMatchObject({ ok: true, id: 42, ref: 'D42' });
  });

  it('times out to id:null with a hint to run draft list', () => {
    const out = JSON.parse(run(['draft', 'propose'], JSON.stringify(proposal)));
    expect(out).toMatchObject({ ok: true, id: null });
    expect(out.file).toMatch(/\.json$/);
    expect(out.hint).toMatch(/draft list/);
  });

  it('writes the validated (control-stripped) value', () => {
    run(['draft', 'propose'], JSON.stringify({ ...proposal, title: 'A‮b' }));
    const file = readdirSync(outbox)[0]!;
    expect(JSON.parse(readFileSync(join(outbox, file), 'utf8')).title).toBe('Ab');
  });

  it('passes an optional id through so the host can revise the draft', () => {
    run(['draft', 'propose'], JSON.stringify({ ...proposal, id: 9 }));
    const file = readdirSync(outbox)[0]!;
    expect(JSON.parse(readFileSync(join(outbox, file), 'utf8')).id).toBe(9);
  });

  it('draft list prints the index id/status/title and no more', () => {
    writeFileSync(
      join(dir, 'proposals.json'),
      JSON.stringify([
        { id: 3, uuid: 'u', title: 'A', status: 'pending', updatedAt: 't' },
        { id: 4, uuid: 'v', title: 'B', status: 'discarded', updatedAt: 't' },
      ]),
    );
    expect(JSON.parse(run(['draft', 'list'], ''))).toEqual([
      { id: 3, ref: 'D3', status: 'pending', title: 'A' },
      { id: 4, ref: 'D4', status: 'discarded', title: 'B' },
    ]);
  });

  it('draft list --pending keeps only the pending drafts; the default output is unchanged', () => {
    writeFileSync(
      join(dir, 'proposals.json'),
      JSON.stringify([
        { id: 3, uuid: 'u', title: 'A', status: 'pending', updatedAt: 't' },
        { id: 4, uuid: 'v', title: 'B', status: 'discarded', updatedAt: 't' },
        { id: 5, uuid: 'w', title: 'C', status: 'accepted', updatedAt: 't' },
      ]),
    );
    expect(JSON.parse(run(['draft', 'list', '--pending'], ''))).toEqual([
      { id: 3, ref: 'D3', status: 'pending', title: 'A' },
    ]);
    expect(JSON.parse(run(['draft', 'list'], ''))).toHaveLength(3);
  });

  it('draft list prints [] when the session has no index yet', () => {
    expect(JSON.parse(run(['draft', 'list'], ''))).toEqual([]);
  });

  it.each([
    [['draft', 'create']],
    [['draft', 'propose', '--db', '/x.db']],
    [['draft', 'propose', '--manifest', '/k.yml']],
    [['draft', 'propose', '--session', '1']],
    [['draft', 'propose', 'extra']],
    [['draft', 'list', 'extra']],
    [['draft', 'list', '--pending', 'extra']],
    [['draft', 'list', '--all']],
  ])('rejects argv %j', (argv) => {
    expect(() => run(argv, JSON.stringify(proposal))).toThrow(/draft/);
    expect(readdirSync(outbox)).toEqual([]);
  });

  it('requires KARST_OUTBOX naming a real directory', () => {
    expect(() => run(['draft', 'propose'], JSON.stringify(proposal), null)).toThrow(/KARST_OUTBOX/);
    expect(() => run(['draft', 'list'], '', null)).toThrow(/KARST_OUTBOX/);
    expect(() => run(['draft', 'propose'], JSON.stringify(proposal), join(dir, 'nope'))).toThrow(/KARST_OUTBOX/);
    writeFileSync(join(dir, 'file'), '');
    expect(() => run(['draft', 'propose'], JSON.stringify(proposal), join(dir, 'file'))).toThrow(/KARST_OUTBOX/);
  });

  it('writes through the realpath of a symlinked outbox', () => {
    symlinkSync(outbox, join(dir, 'link'));
    const out = JSON.parse(run(['draft', 'propose'], JSON.stringify(proposal), join(dir, 'link')));
    expect(out.file.startsWith(outbox)).toBe(true);
  });

  it('rejects invalid JSON, oversized input and an invalid proposal, writing nothing', () => {
    expect(() => run(['draft', 'propose'], '{nope')).toThrow(/JSON/);
    expect(() => run(['draft', 'propose'], 'x'.repeat(MAX_PROPOSAL_BYTES + 1))).toThrow(/too large/);
    expect(() => run(['draft', 'propose'], JSON.stringify({ ...proposal, extra: 1 }))).toThrow(/keys/);
    expect(() => run(['draft', 'propose'], JSON.stringify({ ...proposal, id: -1 }))).toThrow(/id/);
    expect(readdirSync(outbox)).toEqual([]);
  });
});
