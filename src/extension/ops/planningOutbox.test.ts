import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as nodeFs from 'node:fs';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, symlinkSync, rmSync, utimesSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, type Store } from '../../store/db.js';
import { upsertProject } from '../../store/projects.js';
import { createPlanningSession } from '../../store/planningSessions.js';
import {
  acceptProposal,
  countPending,
  discardProposal,
  getProposal,
  insertProposal,
  listPendingProposals,
} from '../../store/planningProposals.js';
import { MAX_PROPOSAL_BYTES } from '../../planning/proposal.js';
import { readProposalIndex } from '../../planning/proposalIndex.js';
import { createPlanningOutbox, PLANNING_OUTBOX_RATE_CAP, type PlanningOutboxDeps } from './planningOutbox.js';
import type { Notify } from './notify.js';

const UUID = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const good = { title: 'Fix auth', description: 'd', summary: 's', repos: ['api'] };

describe('planning outbox', () => {
  let root: string;
  let store: Store;
  let projectId: number;
  let sessionId: number;
  let scratch: string;
  let outbox: string;
  let warns: string[];
  let notify: Notify;
  let sessions: { id: number; scratch: string }[];
  let known: string[] | undefined;
  let now: number;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'karst-outbox-'));
    store = openStore(':memory:');
    projectId = upsertProject(store, { slug: 'p' }).id;
    sessionId = createPlanningSession(store, { projectId, title: 's', core: 'claude', model: null }).id;
    scratch = join(root, 'scratch');
    outbox = join(scratch, 'outbox');
    mkdirSync(outbox, { recursive: true });
    warns = [];
    notify = { info: () => {}, warn: (m) => warns.push(m), error: async () => {} };
    sessions = [{ id: sessionId, scratch }];
    known = ['api', 'web'];
    now = Date.now();
  });
  afterEach(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });

  function make(over: Partial<PlanningOutboxDeps> = {}) {
    return createPlanningOutbox({
      store,
      projectId: () => projectId,
      sessions: () => sessions,
      knownRepos: () => known,
      windowId: 'w1',
      now: () => now,
      notify,
      onProposal: () => {},
      ...over,
    });
  }
  const put = (name: string, body: unknown): void =>
    writeFileSync(join(outbox, name), typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
  const pending = () => listPendingProposals(store, projectId);

  it('ingests a valid proposal, empties the outbox and reports it', () => {
    const onProposal = vi.fn();
    const debug = vi.fn();
    put(`${UUID(1)}.json`, good);
    make({ onProposal, debug }).scan();
    expect(pending().map((p) => p.payload)).toEqual([good]);
    expect(readdirSync(outbox)).toEqual([]);
    expect(onProposal).toHaveBeenCalledWith(expect.objectContaining({ sessionId, payload: good }));
    expect(debug.mock.calls.some(([l]) => String(l).startsWith('[planning]'))).toBe(true);
    expect(warns).toEqual([]);
  });

  it('writes the session proposal index on ingest, carrying the file uuid', () => {
    put(`${UUID(1)}.json`, good);
    make().scan();
    const id = pending()[0]!.id;
    expect(readProposalIndex(scratch)).toEqual([
      { id, uuid: UUID(1), title: 'Fix auth', status: 'pending', updatedAt: expect.any(String) },
    ]);
  });

  it('a failed index write still removes the claim and announces, never double-inserting', () => {
    const onProposal = vi.fn();
    const fsBadIndex = {
      ...nodeFs,
      renameSync: (from: string, to: string) => {
        if (to.endsWith('proposals.json')) throw new Error('index write failed');
        return nodeFs.renameSync(from, to);
      },
    } as unknown as typeof nodeFs;
    put(`${UUID(1)}.json`, good);
    make({ fs: fsBadIndex, onProposal }).scan();
    // The store insert committed; the index failed, but the claim is gone and
    // the proposal was announced, so a later scan cannot reclaim and duplicate.
    expect(pending()).toHaveLength(1);
    expect(onProposal).toHaveBeenCalledTimes(1);
    expect(readdirSync(outbox)).toEqual([]);
    make({ fs: fsBadIndex, onProposal }).scan();
    expect(pending()).toHaveLength(1);
  });

  it('revises a pending proposal of the same session in place and re-announces it as updated', () => {
    const id = insertProposal(store, sessionId, good);
    const onProposal = vi.fn();
    put(`${UUID(2)}.json`, { ...good, id, title: 'Revised auth', repos: ['web'] });
    make({ onProposal }).scan();
    expect(getProposal(store, id)).toMatchObject({ id, status: 'pending', payload: { title: 'Revised auth', repos: ['web'] } });
    expect(countPending(store, sessionId)).toBe(1);
    expect(onProposal).toHaveBeenCalledTimes(1);
    expect(onProposal.mock.calls[0]![1]).toBe('updated');
    expect(readProposalIndex(scratch)).toEqual([
      { id, uuid: UUID(2), title: 'Revised auth', status: 'pending', updatedAt: expect.any(String) },
    ]);
    expect(readdirSync(outbox)).toEqual([]);
  });

  it('refuses a revision of another session, an accepted or a discarded proposal, writing nothing', () => {
    const other = createPlanningSession(store, { projectId, title: 'other', core: 'claude', model: null }).id;
    const foreign = insertProposal(store, other, good);
    const accepted = insertProposal(store, sessionId, good);
    acceptProposal(store, accepted);
    const discarded = insertProposal(store, sessionId, good);
    discardProposal(store, discarded);

    put(`${UUID(3)}.json`, { ...good, id: foreign, title: 'hijack' });
    put(`${UUID(4)}.json`, { ...good, id: accepted, title: 'hijack' });
    put(`${UUID(5)}.json`, { ...good, id: discarded, title: 'hijack' });
    make().scan();

    expect(getProposal(store, foreign)!.payload.title).toBe('Fix auth');
    expect(getProposal(store, accepted)!.payload.title).toBe('Fix auth');
    expect(getProposal(store, discarded)!.payload.title).toBe('Fix auth');
    expect(warns.join()).toMatch(/another session/);
    expect(warns.join()).toMatch(/accepted/);
    expect(warns.join()).toMatch(/discarded/);
    expect(readdirSync(outbox)).toEqual([]);
    // A refused revision is not an update: it writes nothing, not even an index.
    expect(readProposalIndex(scratch)).toEqual([]);
    expect(countPending(store, sessionId)).toBe(0);
  });

  it('ignores names that are not <uuid>.json and never touches them', () => {
    put('notes.txt', 'x');
    put('../escape.json', good);
    make().scan();
    expect(pending()).toEqual([]);
    expect(readdirSync(outbox).sort()).toEqual(['notes.txt']);
    expect(existsSync(join(scratch, 'escape.json'))).toBe(true);
  });

  it('skips a symlinked outbox dir and warns', () => {
    rmSync(outbox, { recursive: true });
    const elsewhere = join(root, 'elsewhere');
    mkdirSync(elsewhere);
    writeFileSync(join(elsewhere, `${UUID(1)}.json`), JSON.stringify(good));
    symlinkSync(elsewhere, outbox);
    make().scan();
    expect(pending()).toEqual([]);
    expect(readdirSync(elsewhere)).toEqual([`${UUID(1)}.json`]);
    expect(warns.join()).toMatch(/outbox/);
  });

  it('a missing outbox dir is silently skipped', () => {
    rmSync(outbox, { recursive: true });
    make().scan();
    expect(warns).toEqual([]);
  });

  it('rejects a symlinked proposal file without reading its target', () => {
    const target = join(root, 'secret.json');
    writeFileSync(target, JSON.stringify(good));
    symlinkSync(target, join(outbox, `${UUID(1)}.json`));
    make().scan();
    expect(pending()).toEqual([]);
    expect(existsSync(target)).toBe(true);
    expect(readdirSync(outbox)).toEqual([]);
    expect(warns).toHaveLength(1);
  });

  it.skipIf(process.platform === 'win32')('rejects a FIFO without blocking', () => {
    execFileSync('mkfifo', [join(outbox, `${UUID(1)}.json`)]);
    make().scan();
    expect(pending()).toEqual([]);
    expect(warns.join()).toMatch(/regular file/);
  });

  it('rejects an oversize file', () => {
    put(`${UUID(1)}.json`, 'x'.repeat(MAX_PROPOSAL_BYTES + 1));
    make().scan();
    expect(pending()).toEqual([]);
    expect(warns.join()).toMatch(/large/);
  });

  it('rejects a file that grows past the cap after fstat', () => {
    put(`${UUID(1)}.json`, JSON.stringify(good));
    const fsGrow = {
      ...nodeFs,
      fstatSync: (fd: number) => {
        const st = nodeFs.fstatSync(fd);
        nodeFs.appendFileSync(join(outbox, `.claim-w1-${UUID(1)}.json`), ' '.repeat(MAX_PROPOSAL_BYTES + 10));
        return st;
      },
    } as unknown as typeof nodeFs;
    make({ fs: fsGrow }).scan();
    expect(pending()).toEqual([]);
    expect(warns.join()).toMatch(/large/);
  });

  it('rejects non-UTF-8 bytes', () => {
    put(`${UUID(1)}.json`, Buffer.from([0x7b, 0xff, 0xfe, 0x7d]));
    make().scan();
    expect(pending()).toEqual([]);
    expect(warns.join()).toMatch(/UTF-8/);
  });

  it('rejects invalid JSON and extra keys, naming the reason', () => {
    put(`${UUID(1)}.json`, '{nope');
    put(`${UUID(2)}.json`, { ...good, extra: 1 });
    make().scan();
    expect(pending()).toEqual([]);
    expect(warns).toHaveLength(2);
    expect(warns.join()).toMatch(/keys/);
    expect(readdirSync(outbox)).toEqual([]);
  });

  it('strips bidi controls from the title', () => {
    put(`${UUID(1)}.json`, { ...good, title: 'Fix‮ auth' });
    make().scan();
    expect(pending()[0]!.payload.title).toBe('Fix auth');
  });

  it('rejects an unknown repo, and any repo when the manifest is unknown', () => {
    put(`${UUID(1)}.json`, { ...good, repos: ['nope'] });
    make().scan();
    expect(warns.join()).toMatch(/nope/);
    known = undefined;
    put(`${UUID(2)}.json`, good);
    put(`${UUID(3)}.json`, { ...good, repos: [] });
    make().scan();
    expect(pending().map((p) => p.payload.repos)).toEqual([[]]);
  });

  it('only scans the sessions it is given (another project is not scanned)', () => {
    const otherScratch = join(root, 'other');
    mkdirSync(join(otherScratch, 'outbox'), { recursive: true });
    writeFileSync(join(otherScratch, 'outbox', `${UUID(1)}.json`), JSON.stringify(good));
    make().scan();
    expect(readdirSync(join(otherScratch, 'outbox'))).toHaveLength(1);
  });

  it('does nothing without a project', () => {
    put(`${UUID(1)}.json`, good);
    make({ projectId: () => undefined }).scan();
    expect(readdirSync(outbox)).toHaveLength(1);
  });

  it('two windows racing on the same file yield exactly one row', () => {
    put(`${UUID(1)}.json`, good);
    const b = make({ windowId: 'w2' });
    const fsRace = {
      ...nodeFs,
      renameSync: (from: nodeFs.PathLike, to: nodeFs.PathLike) => {
        b.scan(); // the other window wins between our readdir and our rename
        nodeFs.renameSync(from, to);
      },
    } as unknown as typeof nodeFs;
    make({ fs: fsRace }).scan();
    expect(pending()).toHaveLength(1);
    expect(readdirSync(outbox)).toEqual([]);
  });

  it('re-claims a stale claim but leaves a fresh one alone', () => {
    const stale = join(outbox, `.claim-dead-window-${UUID(1)}.json`);
    const fresh = join(outbox, `.claim-live-${UUID(2)}.json`);
    writeFileSync(stale, JSON.stringify(good));
    writeFileSync(fresh, JSON.stringify(good));
    const old = (now - 6 * 60_000) / 1000;
    utimesSync(stale, old, old);
    make().scan();
    expect(pending()).toHaveLength(1);
    expect(readdirSync(outbox)).toEqual([`.claim-live-${UUID(2)}.json`]);
  });

  it('caps pending proposals per session', () => {
    for (let i = 1; i <= PLANNING_OUTBOX_RATE_CAP + 2; i++) put(`${UUID(i)}.json`, good);
    make().scan();
    expect(countPending(store, sessionId)).toBe(PLANNING_OUTBOX_RATE_CAP);
    expect(warns.join()).toMatch(/pending/);
    expect(readdirSync(outbox)).toEqual([]);
  });
});
