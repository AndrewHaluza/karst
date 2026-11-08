import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openStore } from '../store/db.js';
import { createTicket } from '../store/tickets.js';
import { listArchCitations } from '../store/archCitations.js';
import { parseArchArgs, readArchKeys, runArchCommand } from './archCommand.js';

function worktree(): string {
  const root = mkdtempSync(join(tmpdir(), 'arch-cite-'));
  mkdirSync(join(root, 'docs', 'arch'), { recursive: true });
  writeFileSync(join(root, 'docs', 'arch', 'x.md'), '## [@arch:UATHOST-00] Host\n\nbody\nEND_DOC_BLOCK: [@arch:UATHOST-00]\n');
  return root;
}

describe('parseArchArgs', () => {
  it('parses key and reason', () => {
    expect(parseArchArgs(['arch', 'cite', 'arch:CLI-02', '--why', ' still  holds '])).toEqual({
      verb: 'cite', key: '@arch:CLI-02', reason: 'still holds',
    });
  });
  it.each([
    [['arch'], /unknown arch verb/],
    [['arch', 'cite'], /missing key/],
    [['arch', 'cite', '@arch:A'], /missing --why/],
    [['arch', 'cite', '@arch:A', '--why'], /needs a value/],
    [['arch', 'cite', '@arch:A', '--why', 'x', 'y'], /unexpected argument/],
    [['arch', 'cite', '@arch:A', '--bogus', 'x'], /unknown flag/],
    [['arch', 'cite', '@arch:A', '--why', 'a'.repeat(300)], /too long/],
  ])('rejects %j', (argv, re) => {
    expect(() => parseArchArgs(argv)).toThrow(re);
  });
});

describe('readArchKeys', () => {
  it('reads block keys, walking up from a subdirectory', () => {
    const root = worktree();
    mkdirSync(join(root, 'src'));
    expect([...(readArchKeys(join(root, 'src')) ?? [])]).toEqual(['@arch:UATHOST-00']);
  });
});

describe('runArchCommand', () => {
  const setup = () => {
    const store = openStore(':memory:');
    const t = createTicket(store, { key: 'P-1', title: 't', source: 'manual' });
    return { store, t, cwd: worktree() };
  };
  const cite = ['arch', 'cite', '@arch:UATHOST-00', '--why', 'holds'];

  it('records a citation and replaces it on re-cite', () => {
    const { store, t, cwd } = setup();
    const first = JSON.parse(runArchCommand(store, t, cite, { sessionTicketKey: 'P-1', cwd }));
    expect(first).toEqual({ ok: true, key: '@arch:UATHOST-00', replaced: false });
    const again = JSON.parse(runArchCommand(store, t, [...cite.slice(0, 4), 'new reason'], { sessionTicketKey: 'P-1', cwd }));
    expect(again.replaced).toBe(true);
    expect(listArchCitations(store, t.id)).toEqual([{ key: '@arch:UATHOST-00', reason: 'new reason' }]);
  });

  it('rejects a key that is not in docs/arch', () => {
    const { store, t, cwd } = setup();
    expect(() => runArchCommand(store, t, ['arch', 'cite', '@arch:NOPE-1', '--why', 'x'], { sessionTicketKey: 'P-1', cwd })).toThrow(/not a block key/);
    expect(listArchCitations(store, t.id)).toEqual([]);
  });

  it('refuses without a session ticket and for another ticket', () => {
    const { store, t, cwd } = setup();
    expect(() => runArchCommand(store, t, cite, { cwd })).toThrow(/KARST_TICKET/);
    expect(() => runArchCommand(store, t, cite, { sessionTicketKey: 'OTHER-9', cwd })).toThrow(/refusing/);
  });

  it('refuses when there is no docs/arch', () => {
    const { store, t } = setup();
    const cwd = mkdtempSync(join(tmpdir(), 'no-arch-'));
    expect(() => runArchCommand(store, t, cite, { sessionTicketKey: 'P-1', cwd })).toThrow(/no docs\/arch/);
  });
});
