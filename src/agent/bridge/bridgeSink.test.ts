import { appendFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HookPayload } from '../../hooks/dispatch.js';
import { bridgePaths, type BridgePaths } from './bridgeDir.js';
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
};
const hookLine = (ticket = 7) =>
  JSON.stringify({ v: 1, kind: 'hook', ticket, payload: { hook_event_name: 'Notification', session_id: 's1', cwd: '/x' } });
const markerLine = (o: Record<string, unknown> = {}) => JSON.stringify({ v: 1, kind: 'marker', ticket: 7, stage: 'impl', ...o });
const write = async (...lines: string[]) => {
  const { mkdir } = await import('node:fs/promises');
  await mkdir(paths.dir, { recursive: true });
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
    expect(logs).toContain('[bridge] ticket 7 marker impl exited 1: boom');
    await write(hookLine());
    await att.pollOnce();
    expect(dispatched).toHaveLength(1);
  });
  it('a runMarker rejection is swallowed and logged', async () => {
    await write(markerLine());
    await make(vi.fn<MarkerRunner>(async () => Promise.reject(new Error('spawn ENOENT')))).pollOnce();
    await flush();
    expect(logs).toContain('[bridge] ticket 7 marker impl failed: spawn ENOENT');
  });
  it('a successful marker run logs nothing', async () => {
    await write(markerLine());
    await make(okRunner()).pollOnce();
    await flush();
    expect(logs.filter((l) => l.includes('marker'))).toEqual([]);
  });
});
