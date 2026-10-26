import { appendFile, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HookPayload } from '../../hooks/dispatch.js';
import { bridgePaths, ensureBridgeDir, type BridgePaths } from './bridgeDir.js';
import { createBridgeAttachment, type MarkerRunner } from './bridgeSink.js';
import type { BridgeExpectation } from './bridgeVerifier.js';

let root: string;
let paths: BridgePaths;
let dispatched: HookPayload[];
let logs: string[];
const expectation: BridgeExpectation = {
  ticketId: 7,
  worktreePath: '/wt/t7',
  launchId: 'L1',
  stage: () => 'impl',
  sessionId: () => undefined,
  sessionLaunchId: () => undefined,
};
const hookLine = (ticket = 7) =>
  JSON.stringify({ v: 1, kind: 'hook', ticket, payload: { hook_event_name: 'Notification', session_id: 's1', cwd: '/x' } });
const markerLine = (o: Record<string, unknown> = {}) => JSON.stringify({ v: 1, kind: 'marker', ticket: 7, stage: 'impl', ...o });
const write = async (...lines: string[]) => {
  await ensureBridgeDir(paths);
  await appendFile(paths.eventsFile, lines.map((l) => `${l}\n`).join(''));
};
const flush = () => new Promise((r) => setImmediate(r));
const make = (runMarker: MarkerRunner) =>
  createBridgeAttachment({
    paths,
    expect: expectation,
    dispatch: (p) => dispatched.push(p),
    runMarker,
    intervalMs: 5,
    debug: (m) => logs.push(m),
  });
const okRunner = () => vi.fn<MarkerRunner>(async () => ({ code: 0, stderr: '' }));

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'sink-'));
  paths = bridgePaths(root, 7);
  dispatched = [];
  logs = [];
});
afterEach(() => rm(root, { recursive: true, force: true }));

describe('createBridgeAttachment', () => {
  it('dispatches an own-ticket hook with host-built cwd and launchId', async () => {
    await write(hookLine());
    await make(okRunner()).pollOnce();
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]).toMatchObject({ cwd: '/wt/t7', launchId: 'L1' });
  });
  it('runs the CLI marker once for an own-stage marker and never dispatches it as a hook', async () => {
    const run = okRunner();
    await write(markerLine());
    await make(run).pollOnce();
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith('impl');
    expect(dispatched).toEqual([]);
  });
  it('drops a forged other-ticket marker and logs [bridge] ... ticket 8 != 7', async () => {
    const run = okRunner();
    await write(markerLine({ ticket: 8 }));
    await make(run).pollOnce();
    expect(run).not.toHaveBeenCalled();
    expect(logs).toContain('[bridge] ticket 7 dropped: ticket 8 != 7');
  });
  it('drops a forged other-stage marker', async () => {
    const run = okRunner();
    await write(markerLine({ stage: 'fix' }));
    await make(run).pollOnce();
    expect(run).not.toHaveBeenCalled();
    expect(logs).toContain('[bridge] ticket 7 dropped: stage fix != impl');
  });
  it('logs a failing marker run but keeps tailing', async () => {
    const att = make(vi.fn<MarkerRunner>(async () => ({ code: 1, stderr: 'boom\n' })));
    await write(markerLine());
    await att.pollOnce();
    await flush();
    expect(logs).toContain('[bridge] ticket 7 marker impl failed: boom');
    await write(hookLine());
    await att.pollOnce();
    expect(dispatched).toHaveLength(1);
  });
  it('a runMarker rejection is swallowed and logged', async () => {
    await write(markerLine());
    await make(vi.fn<MarkerRunner>(async () => Promise.reject(new Error('spawn ENOENT')))).pollOnce();
    await vi.waitFor(() => expect(logs).toContain('[bridge] ticket 7 marker impl failed: spawn ENOENT'));
  });
  it('a successful marker run logs nothing', async () => {
    await write(markerLine());
    await make(okRunner()).pollOnce();
    await flush();
    expect(logs.filter((l) => l.includes('marker'))).toEqual([]);
  });
  it('queues markers: a marker line during a run waits, none is dropped', async () => {
    let finish!: () => void;
    const run = vi.fn<MarkerRunner>(() => new Promise((r) => { finish = () => r({ code: 0, stderr: '' }); }));
    const a = make(run);
    await write(markerLine(), markerLine());
    await a.pollOnce();
    await flush();
    expect(run).toHaveBeenCalledTimes(1);
    finish();
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
    finish();
  });
  it('writes the reply file named by the line seq, ok on a pass', async () => {
    await write(markerLine({ seq: 'n1' }));
    await make(okRunner()).pollOnce();
    await flush();
    await flush();
    await vi.waitFor(async () => { await readFile(join(paths.resultsDir, 'n1.json')); });
    expect(JSON.parse(await readFile(join(paths.resultsDir, 'n1.json'), 'utf8'))).toEqual({ v: 1, stage: 'impl', ok: true, retrying: false, reason: '' });
  });
  it('keeps polling after a retrying result: the queued marker does not detach the tail', async () => {
    const att = make(vi.fn<MarkerRunner>(async () => ({ code: 1, stderr: 'sync failed', transient: true })));
    await write(markerLine({ seq: 'r1' }));
    await att.pollOnce();
    await vi.waitFor(async () => {
      expect(JSON.parse(await readFile(join(paths.resultsDir, 'r1.json'), 'utf8'))).toMatchObject({ ok: false, retrying: true });
    });
    // The next line the agent writes is still read and dispatched.
    await write(hookLine());
    await att.pollOnce();
    expect(dispatched).toHaveLength(1);
    // And a marker fired after the retrying result is answered, not left waiting.
    await write(markerLine({ seq: 'r2' }));
    await att.pollOnce();
    await vi.waitFor(async () => {
      expect(JSON.parse(await readFile(join(paths.resultsDir, 'r2.json'), 'utf8'))).toMatchObject({ ok: false, retrying: true });
    });
  });
  it('replies with the failure reason and reports it', async () => {
    const seen: string[] = [];
    const att = createBridgeAttachment({
      paths, expect: expectation, dispatch: () => undefined, intervalMs: 5, debug: (m) => logs.push(m),
      runMarker: async () => ({ code: 1, stderr: 'karst: cannot mark this stage done: empty' }),
      onMarkerFailure: (f) => seen.push(`${f.stage}:${f.reason}`),
    });
    await write(markerLine({ seq: 'n2' }));
    await att.pollOnce();
    await flush();
    await flush();
    await vi.waitFor(async () => { await readFile(join(paths.resultsDir, 'n2.json')); });
    expect(seen).toEqual(['impl:karst: cannot mark this stage done: empty']);
    expect(JSON.parse(await readFile(join(paths.resultsDir, 'n2.json'), 'utf8'))).toMatchObject({ ok: false, retrying: false });
  });
  it('ignores a seq that is not a plain token: no reply file, marker still runs', async () => {
    const run = okRunner();
    await write(markerLine({ seq: '../evil' }));
    await make(run).pollOnce();
    await flush();
    expect(run).toHaveBeenCalledTimes(1);
    expect(await readdir(paths.resultsDir).catch(() => [])).toEqual([]);
  });
  it('start() retries a marker persisted by an earlier failure (boot sweep)', async () => {
    const { mkdir } = await import('node:fs/promises');
    await mkdir(join(paths.pendingFile, '..'), { recursive: true });
    await writeFile(paths.pendingFile, JSON.stringify({ stage: 'impl' }));
    const run = okRunner();
    const att = make(run);
    att.start();
    await flush();
    await flush();
    await vi.waitFor(() => expect(run).toHaveBeenCalledWith('impl'));
    await att.stop();
    await vi.waitFor(async () => expect(await readFile(paths.pendingFile, 'utf8').catch(() => 'gone')).toBe('gone'));
  });
  it('a failed marker run also frees the slot', async () => {
    const run = vi.fn<MarkerRunner>(() => Promise.reject(new Error('x')));
    const a = make(run);
    await write(markerLine());
    await a.pollOnce();
    await flush();
    await write(markerLine());
    await a.pollOnce();
    expect(run).toHaveBeenCalledTimes(2);
  });
});

describe('reattach after a reload (events file truncated or rewritten)', () => {
  const stateDir = async () => {
    const { mkdir } = await import('node:fs/promises');
    await mkdir(join(root, 'state'), { recursive: true });
  };
  const settle = async (a: { pollOnce(): Promise<void> }) => {
    await a.pollOnce();
    await flush();
    await flush();
  };

  it('a handled marker is not replayed after the file is truncated and rewritten; a new marker still runs', async () => {
    await stateDir();
    const run = okRunner();
    await write(markerLine({ seq: 'aaaa' }));
    await settle(make(run));
    expect(run).toHaveBeenCalledTimes(1);

    // Reload: a fresh attachment on the same paths; the agent side truncated the file and wrote again.
    await writeFile(paths.eventsFile, '');
    await write(hookLine(), markerLine({ seq: 'aaaa' }), markerLine({ seq: 'bbbb' }));
    const again = okRunner();
    await settle(make(again));
    expect(again).toHaveBeenCalledTimes(1);
    expect(logs.some((m) => m.includes('seq aaaa already handled'))).toBe(true);
  });

  it('a rewritten file larger than the saved offset neither replays nor hides', async () => {
    await stateDir();
    const run = okRunner();
    await write(markerLine({ seq: 'aaaa' }));
    await settle(make(run));
    await writeFile(paths.eventsFile, `${hookLine()}\n${hookLine()}\n${markerLine({ seq: 'aaaa' })}\n${markerLine({ seq: 'cccc' })}\n`);
    const again = okRunner();
    await settle(make(again));
    expect(again).toHaveBeenCalledTimes(1);
    expect(logs.some((m) => m.includes('rewritten'))).toBe(true);
  });

  it('persists a handled seq before pollOnce resolves, so an immediate reload cannot replay it', async () => {
    await stateDir();
    await write(markerLine({ seq: 'aaaa' }));
    await make(okRunner()).pollOnce();
    expect(JSON.parse(await readFile(paths.handledFile, 'utf8'))).toEqual(['aaaa']);
  });

  it('the handled record survives a restart and is host-side only', async () => {
    await stateDir();
    await write(markerLine({ seq: 'aaaa' }));
    await settle(make(okRunner()));
    expect(JSON.parse(await readFile(paths.handledFile, 'utf8'))).toEqual(['aaaa']);
    expect(await readdir(paths.dir)).not.toContain('handled.json');
  });

  it('a marker without a seq is never deduped (old scripts)', async () => {
    await stateDir();
    const run = okRunner();
    await write(markerLine(), markerLine());
    await make(run).pollOnce();
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
  });
});
