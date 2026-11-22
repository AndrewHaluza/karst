import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MAX_OUTBOX_REJECTIONS,
  MAX_PROPOSAL_INDEX_BYTES,
  MAX_REJECTION_REASON_CHARS,
  OUTBOX_REJECTIONS_DIR,
  outboxRejectionsDir,
  readOutboxRejection,
  readProposalIndex,
  writeOutboxRejection,
  writeProposalIndex,
  waitForProposalId,
  waitForProposalResult,
  proposalIndexPath,
  type ProposalIndexEntry,
} from './proposalIndex.js';

const entry = (id: number, uuid: string): ProposalIndexEntry => ({
  id,
  uuid,
  title: `T${id}`,
  status: 'pending',
  updatedAt: '2026-01-01 00:00:00',
});

describe('proposal index', () => {
  let scratch: string;
  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), 'karst-index-'));
  });
  afterEach(() => rmSync(scratch, { recursive: true, force: true }));

  it('round-trips entries atomically and reads a missing file as []', () => {
    expect(readProposalIndex(scratch)).toEqual([]);
    writeProposalIndex(scratch, [entry(1, 'a'), entry(2, 'b')]);
    expect(readProposalIndex(scratch)).toEqual([entry(1, 'a'), entry(2, 'b')]);
    expect(proposalIndexPath(scratch)).toBe(join(scratch, 'proposals.json'));
  });

  it('drops malformed entries and a non-array payload rather than throwing', () => {
    writeFileSync(proposalIndexPath(scratch), JSON.stringify([entry(1, 'a'), { id: 'x' }, 5]));
    expect(readProposalIndex(scratch)).toEqual([entry(1, 'a')]);
    writeFileSync(proposalIndexPath(scratch), '{"not":"an array"}');
    expect(readProposalIndex(scratch)).toEqual([]);
  });

  it('refuses an oversized index without reading it whole', () => {
    writeFileSync(proposalIndexPath(scratch), 'x'.repeat(MAX_PROPOSAL_INDEX_BYTES + 1));
    expect(readProposalIndex(scratch)).toEqual([]);
  });

  it('refuses a symlinked or non-regular index instead of following it', () => {
    const real = join(scratch, 'real.json');
    writeFileSync(real, JSON.stringify([entry(1, 'a')]));
    symlinkSync(real, proposalIndexPath(scratch));
    expect(readProposalIndex(scratch)).toEqual([]);
    rmSync(proposalIndexPath(scratch));
    mkdirSync(proposalIndexPath(scratch));
    expect(readProposalIndex(scratch)).toEqual([]);
  });

  it('waits for the matching uuid and returns its id', () => {
    let clock = 0;
    const sleep = (ms: number): void => {
      clock += ms;
      writeProposalIndex(scratch, [entry(7, 'the-uuid')]);
    };
    expect(waitForProposalId(scratch, 'the-uuid', { timeoutMs: 1000, now: () => clock, sleep })).toBe(7);
  });

  it('returns undefined after the bounded wait when no entry appears', () => {
    let clock = 0;
    const slept: number[] = [];
    const sleep = (ms: number): void => {
      clock += ms;
      slept.push(ms);
    };
    expect(waitForProposalId(scratch, 'missing', { timeoutMs: 1000, now: () => clock, sleep })).toBeUndefined();
    // It actually waited (bounded), rather than returning on the first look.
    expect(clock).toBe(1000);
    expect(slept.length).toBeGreaterThan(0);
  });
});

const UUID = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

describe('proposal index entry fields', () => {
  let scratch: string;
  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), 'karst-index-fields-'));
  });
  afterEach(() => rmSync(scratch, { recursive: true, force: true }));

  const base = { id: 1, uuid: UUID(1), title: 'T', status: 'pending', updatedAt: 'x' };

  it('keeps warnings and checking when they have the right types', () => {
    writeFileSync(proposalIndexPath(scratch), JSON.stringify([{ ...base, warnings: ['w'], checking: true }]));
    expect(readProposalIndex(scratch)).toEqual([{ ...base, warnings: ['w'], checking: true }]);
  });

  it('keeps an entry that omits both fields', () => {
    writeFileSync(proposalIndexPath(scratch), JSON.stringify([base]));
    expect(readProposalIndex(scratch)).toEqual([base]);
  });

  it('drops an entry with a bad warnings or checking value', () => {
    writeFileSync(
      proposalIndexPath(scratch),
      JSON.stringify([
        { ...base, id: 1, warnings: 'w' },
        { ...base, id: 2, warnings: [1] },
        { ...base, id: 3, checking: 'yes' },
        { ...base, id: 4, warnings: [], checking: false },
      ]),
    );
    expect(readProposalIndex(scratch).map((e) => e.id)).toEqual([4]);
  });
});

describe('outbox rejection files', () => {
  let scratch: string;
  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), 'karst-rejections-'));
  });
  afterEach(() => rmSync(scratch, { recursive: true, force: true }));

  const entry = (n: number) => ({ uuid: UUID(n), reason: `reason ${n}`, rejectedAt: '2026-11-22T00:00:00.000Z' });

  it('round-trips one rejection under outbox-rejections/<uuid>.json, mode 0600', () => {
    writeOutboxRejection(scratch, entry(1));
    const file = join(scratch, OUTBOX_REJECTIONS_DIR, `${UUID(1)}.json`);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readOutboxRejection(scratch, UUID(1))).toEqual(entry(1));
    expect(readOutboxRejection(scratch, UUID(2))).toBeUndefined();
  });

  it('caps the stored reason length', () => {
    writeOutboxRejection(scratch, { ...entry(1), reason: 'x'.repeat(MAX_REJECTION_REASON_CHARS + 50) });
    expect(readOutboxRejection(scratch, UUID(1))!.reason).toHaveLength(MAX_REJECTION_REASON_CHARS);
  });

  it('refuses an invalid uuid on write and reads it as no rejection', () => {
    expect(() => writeOutboxRejection(scratch, { ...entry(1), uuid: '../../etc/passwd' })).toThrow(/uuid/);
    expect(readOutboxRejection(scratch, '../x')).toBeUndefined();
  });

  it('reads a symlinked, malformed or mismatched rejection as none', () => {
    const dir = outboxRejectionsDir(scratch);
    mkdirSync(dir);
    writeFileSync(join(scratch, 'real.json'), JSON.stringify(entry(1)));
    symlinkSync(join(scratch, 'real.json'), join(dir, `${UUID(1)}.json`));
    writeFileSync(join(dir, `${UUID(2)}.json`), '{not json');
    writeFileSync(join(dir, `${UUID(3)}.json`), JSON.stringify(entry(4)));
    writeFileSync(join(dir, `${UUID(5)}.json`), JSON.stringify({ ...entry(5), reason: 5 }));
    for (const n of [1, 2, 3, 5]) expect(readOutboxRejection(scratch, UUID(n))).toBeUndefined();
  });

  it('refuses a symlinked rejections dir and touches nothing outside it', () => {
    const victim = join(scratch, 'victim');
    mkdirSync(victim);
    for (let n = 1; n <= 25; n++) writeFileSync(join(victim, `${UUID(n)}.json`), 'keep');
    symlinkSync(victim, outboxRejectionsDir(scratch));
    expect(() => writeOutboxRejection(scratch, entry(99))).toThrow(/not a plain directory/);
    expect(readdirSync(victim)).toHaveLength(25);
  });

  it(`keeps at most ${MAX_OUTBOX_REJECTIONS} files and prunes the oldest first`, () => {
    const dir = outboxRejectionsDir(scratch);
    mkdirSync(dir);
    for (let n = 1; n <= MAX_OUTBOX_REJECTIONS; n++) {
      const file = join(dir, `${UUID(n)}.json`);
      writeFileSync(file, JSON.stringify(entry(n)));
      utimesSync(file, 1_000 + n, 1_000 + n);
    }
    writeFileSync(join(dir, 'notes.txt'), 'not a rejection');
    writeOutboxRejection(scratch, entry(100));
    const names = readdirSync(dir).filter((n) => n.endsWith('.json'));
    expect(names).toHaveLength(MAX_OUTBOX_REJECTIONS);
    expect(names).not.toContain(`${UUID(1)}.json`);
    expect(names).toContain(`${UUID(2)}.json`);
    expect(names).toContain(`${UUID(100)}.json`);
    expect(readdirSync(dir)).toContain('notes.txt');
  });

  it(`prunes nothing at exactly ${MAX_OUTBOX_REJECTIONS} files`, () => {
    for (let n = 1; n < MAX_OUTBOX_REJECTIONS; n++) writeOutboxRejection(scratch, entry(n));
    writeOutboxRejection(scratch, entry(100));
    expect(readdirSync(outboxRejectionsDir(scratch))).toHaveLength(MAX_OUTBOX_REJECTIONS);
  });
});

describe('waitForProposalResult', () => {
  let scratch: string;
  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), 'karst-wait-'));
  });
  afterEach(() => rmSync(scratch, { recursive: true, force: true }));

  const row = (over: Partial<ProposalIndexEntry> = {}): ProposalIndexEntry => ({
    id: 42,
    uuid: UUID(1),
    title: 'T',
    status: 'pending',
    updatedAt: 'x',
    ...over,
  });

  /** A fake clock; `onSleep(k)` runs on the k-th sleep (1-based). */
  function clock(onSleep: (k: number) => void = () => {}) {
    let t = 0;
    let k = 0;
    return {
      sleeps: () => k,
      opts: {
        timeoutMs: 1_000,
        intervalMs: 100,
        now: () => t,
        sleep: (ms: number) => {
          t += ms;
          k += 1;
          onSleep(k);
        },
      },
    };
  }

  it('returns rejected with the reason as soon as the rejection file appears', () => {
    const c = clock(() => writeOutboxRejection(scratch, { uuid: UUID(1), reason: 'unknown repositories x', rejectedAt: 'now' }));
    expect(waitForProposalResult(scratch, UUID(1), c.opts)).toEqual({ kind: 'rejected', reason: 'unknown repositories x' });
    expect(c.sleeps()).toBe(1);
  });

  it('returns ingested with the index warnings', () => {
    writeProposalIndex(scratch, [row({ warnings: ['unknown design key @arch:NOPE'] })]);
    expect(waitForProposalResult(scratch, UUID(1), clock().opts)).toEqual({
      kind: 'ingested',
      id: 42,
      warnings: ['unknown design key @arch:NOPE'],
    });
  });

  it('returns warnings: [] when the entry has none', () => {
    writeProposalIndex(scratch, [row()]);
    expect(waitForProposalResult(scratch, UUID(1), clock().opts)).toEqual({ kind: 'ingested', id: 42, warnings: [] });
  });

  it('waits while the entry is checking and returns once checking clears', () => {
    writeProposalIndex(scratch, [row({ checking: true })]);
    const c = clock((k) => {
      if (k === 2) writeProposalIndex(scratch, [row({ warnings: ['unknown commit abc1234'] })]);
    });
    expect(waitForProposalResult(scratch, UUID(1), c.opts)).toEqual({
      kind: 'ingested',
      id: 42,
      warnings: ['unknown commit abc1234'],
    });
    expect(c.sleeps()).toBe(2);
  });

  it('returns ingested with checksPending when the deadline passes mid-check', () => {
    writeProposalIndex(scratch, [row({ checking: true, warnings: ['w'] })]);
    expect(waitForProposalResult(scratch, UUID(1), clock().opts)).toEqual({
      kind: 'ingested',
      id: 42,
      warnings: ['w'],
      checksPending: true,
    });
  });

  it('returns timeout when the host never answers', () => {
    expect(waitForProposalResult(scratch, UUID(1), clock().opts)).toEqual({ kind: 'timeout' });
  });

  it('waitForProposalId returns the id, or undefined on a rejection', () => {
    writeProposalIndex(scratch, [row()]);
    expect(waitForProposalId(scratch, UUID(1), clock().opts)).toBe(42);
    writeOutboxRejection(scratch, { uuid: UUID(2), reason: 'r', rejectedAt: 'now' });
    expect(waitForProposalId(scratch, UUID(2), clock().opts)).toBeUndefined();
  });
});
