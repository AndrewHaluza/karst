import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MAX_PROPOSAL_INDEX_BYTES,
  readProposalIndex,
  writeProposalIndex,
  waitForProposalId,
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
