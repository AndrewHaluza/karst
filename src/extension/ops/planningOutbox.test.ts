import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as nodeFs from 'node:fs';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, symlinkSync, rmSync, utimesSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, type Store } from '../../store/db.js';
import { upsertProject } from '../../store/projects.js';
import { createPlanningSession } from '../../store/planningSessions.js';
import { listPendingProposals, countPending } from '../../store/planningProposals.js';
import { MAX_PROPOSAL_BYTES } from '../../planning/proposal.js';
import {
  createPlanningOutbox,
  PLANNING_OUTBOX_RATE_CAP,
  PLANNING_CLAIM_STALE_MS,
  type PlanningOutboxDeps,
} from './planningOutbox.js';
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
    const lines = debug.mock.calls.map(([l]) => String(l));
    expect(lines.some((l) => l.startsWith('[planning]'))).toBe(true);
    expect(lines.some((l) => l.includes('→ proposal'))).toBe(true);
    expect(lines.some((l) => l.includes(`session ${sessionId}`))).toBe(true);
    expect(warns).toEqual([]);
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

  it('a missing outbox dir is silently skipped without a scan failure', () => {
    rmSync(outbox, { recursive: true });
    const debug = vi.fn();
    make({ debug }).scan();
    expect(warns).toEqual([]);
    expect(debug).not.toHaveBeenCalledWith(expect.stringContaining('scan failed'));
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

  it('pins the stale-claim window', () => {
    expect(PLANNING_CLAIM_STALE_MS).toBe(5 * 60_000);
  });

  it('rejects an outbox whose realpath is not the expected directory, with the code', () => {
    put(`${UUID(1)}.json`, good);
    const debug = vi.fn();
    const expected = join(nodeFs.realpathSync(scratch), 'outbox');
    const fs = {
      ...nodeFs,
      realpathSync: (p: string) => (String(p) === expected ? '/somewhere/else/outbox' : nodeFs.realpathSync(p)),
    } as unknown as typeof nodeFs;
    make({ fs, debug }).scan();
    expect(pending()).toEqual([]);
    expect(warns.join()).toContain('not a plain directory');
    expect(debug.mock.calls.some(([l]) => String(l).includes('outbox rejected (EBADDIR)'))).toBe(true);
  });

  it('logs a lost claim when the rename fails and ingests nothing', () => {
    put(`${UUID(1)}.json`, good);
    const debug = vi.fn();
    const fs = {
      ...nodeFs,
      renameSync: () => { throw new Error('nope'); },
    } as unknown as typeof nodeFs;
    make({ fs, debug }).scan();
    expect(pending()).toEqual([]);
    expect(warns).toEqual([]);
    expect(debug.mock.calls.some(([l]) => String(l).includes('lost (error)'))).toBe(true);
  });

  it('stamps a claimed file with the current time in seconds', () => {
    put(`${UUID(1)}.json`, good);
    const lutimes = vi.fn();
    const fs = { ...nodeFs, lutimesSync: lutimes } as unknown as typeof nodeFs;
    make({ fs }).scan();
    const claimed = join(nodeFs.realpathSync(scratch), 'outbox', `.claim-w1-${UUID(1)}.json`);
    expect(lutimes).toHaveBeenCalledWith(claimed, now / 1000, now / 1000);
  });

  it('logs a failed touch but still ingests the claim', () => {
    put(`${UUID(1)}.json`, good);
    const debug = vi.fn();
    const fs = {
      ...nodeFs,
      lutimesSync: () => { throw new Error('nope'); },
    } as unknown as typeof nodeFs;
    make({ fs, debug }).scan();
    expect(pending()).toHaveLength(1);
    expect(debug.mock.calls.some(([l]) => String(l).includes('touch failed (error)'))).toBe(true);
  });

  it('rejects a file that cannot be opened and names the reason', () => {
    put(`${UUID(1)}.json`, good);
    const fs = {
      ...nodeFs,
      openSync: () => { throw new Error('nope'); },
    } as unknown as typeof nodeFs;
    make({ fs }).scan();
    expect(pending()).toEqual([]);
    expect(warns.join()).toContain('cannot open (error; symlinks are refused)');
  });

  it('closes the file descriptor after reading', () => {
    put(`${UUID(1)}.json`, good);
    const closed: number[] = [];
    const fs = {
      ...nodeFs,
      closeSync: (fd: number) => { closed.push(fd); return nodeFs.closeSync(fd); },
    } as unknown as typeof nodeFs;
    make({ fs }).scan();
    expect(closed).toHaveLength(1);
  });

  it('accepts a proposal exactly at the byte cap', () => {
    const base = JSON.stringify(good);
    put(`${UUID(1)}.json`, base + ' '.repeat(MAX_PROPOSAL_BYTES - Buffer.byteLength(base)));
    make().scan();
    expect(pending()).toHaveLength(1);
    expect(warns).toEqual([]);
  });

  it('logs a failed unlink after a successful ingest', () => {
    put(`${UUID(1)}.json`, good);
    const debug = vi.fn();
    const fs = {
      ...nodeFs,
      unlinkSync: () => { throw new Error('nope'); },
    } as unknown as typeof nodeFs;
    make({ fs, debug }).scan();
    expect(pending()).toHaveLength(1);
    expect(debug.mock.calls.some(([l]) => String(l).includes('unlink ') && String(l).includes(': error'))).toBe(true);
  });

  it('logs a rejected proposal with its reason', () => {
    put(`${UUID(1)}.json`, '{nope');
    const debug = vi.fn();
    make({ debug }).scan();
    expect(debug.mock.calls.some(([l]) => String(l).includes('rejected (not valid JSON)'))).toBe(true);
  });

  it('treats a claim exactly at the stale boundary as fresh', () => {
    const name = `.claim-w1-${UUID(1)}.json`;
    writeFileSync(join(outbox, name), JSON.stringify(good));
    const mtime = now - PLANNING_CLAIM_STALE_MS;
    const fs = {
      ...nodeFs,
      lstatSync: (p: string) =>
        String(p).includes('.claim')
          ? ({ mtimeMs: mtime } as unknown as nodeFs.Stats)
          : nodeFs.lstatSync(p),
    } as unknown as typeof nodeFs;
    make({ fs }).scan();
    expect(pending()).toEqual([]);
    expect(readdirSync(outbox)).toContain(name);
  });

  it('treats a claim whose stat fails as not stale', () => {
    const name = `.claim-w1-${UUID(1)}.json`;
    writeFileSync(join(outbox, name), JSON.stringify(good));
    const fs = {
      ...nodeFs,
      lstatSync: (p: string) => {
        if (String(p).includes('.claim')) throw new Error('nope');
        return nodeFs.lstatSync(p);
      },
    } as unknown as typeof nodeFs;
    make({ fs }).scan();
    expect(pending()).toEqual([]);
    expect(readdirSync(outbox)).toContain(name);
  });

  it('does not treat a suffixed claim name as a claim', () => {
    const name = `.claim-dead-${UUID(1)}.json.bak`;
    writeFileSync(join(outbox, name), JSON.stringify(good));
    const fs = {
      ...nodeFs,
      lstatSync: (p: string) =>
        String(p).includes('.claim')
          ? ({ mtimeMs: 0 } as unknown as nodeFs.Stats)
          : nodeFs.lstatSync(p),
    } as unknown as typeof nodeFs;
    make({ fs }).scan();
    expect(pending()).toEqual([]);
    expect(readdirSync(outbox)).toContain(name);
  });

  it('does not treat a uuid-prefixed file as a proposal', () => {
    const name = `${UUID(1)}.json.bak`;
    writeFileSync(join(outbox, name), JSON.stringify(good));
    make().scan();
    expect(pending()).toEqual([]);
    expect(readdirSync(outbox)).toContain(name);
  });

  it('ignores a malformed claim name without a scan failure', () => {
    writeFileSync(join(outbox, '.claim-bad.json'), JSON.stringify(good));
    const debug = vi.fn();
    make({ debug }).scan();
    expect(pending()).toEqual([]);
    expect(debug).not.toHaveBeenCalledWith(expect.stringContaining('scan failed'));
  });

  it('ignores a non-proposal name even when stale', () => {
    const name = 'notes.txt';
    writeFileSync(join(outbox, name), JSON.stringify(good));
    const fs = {
      ...nodeFs,
      lstatSync: (p: string) =>
        String(p) === join(outbox, name)
          ? ({ mtimeMs: 0 } as unknown as nodeFs.Stats)
          : nodeFs.lstatSync(p),
    } as unknown as typeof nodeFs;
    make({ fs }).scan();
    expect(pending()).toEqual([]);
    expect(readdirSync(outbox)).toContain(name);
  });

  it('logs a session scan failure and continues', () => {
    const debug = vi.fn();
    const fs = {
      ...nodeFs,
      readdirSync: () => { throw Object.assign(new Error('nope'), { code: 'EIO' }); },
    } as unknown as typeof nodeFs;
    make({ fs, debug }).scan();
    expect(debug.mock.calls.some(([l]) => String(l).includes('scan failed (EIO)'))).toBe(true);
  });

  it('names every unknown repository and the no-manifest case', () => {
    put(`${UUID(1)}.json`, { ...good, repos: ['nope', 'nah'] });
    make().scan();
    expect(warns.join()).toContain('unknown repositories nope, nah');

    known = undefined;
    put(`${UUID(2)}.json`, { ...good, repos: ['api'] });
    make().scan();
    expect(warns.join()).toContain('repositories cannot be checked (no manifest)');
  });
});
