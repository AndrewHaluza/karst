import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, realpathSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MAX_PROPOSAL_BYTES } from '../planning/proposal.js';
import { runDraftCommand, type DraftProposeDeps } from './draftCommand.js';

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
