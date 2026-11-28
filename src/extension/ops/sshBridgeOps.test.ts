import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RemoteDef } from '../../manifest/types.js';
import { recordRemoteTrust } from '../../agent/ssh/remoteTrust.js';
import { fakeSshProcess } from '../../agent/ssh/fakeSshProcess.js';
import { stopAllSshBridgeForwarders } from '../../agent/ssh/sshBridge.js';
import { openStore, type Store } from '../../store/db.js';
import { createTicket } from '../../store/tickets.js';
import type { TicketPlacement } from '../../store/placement.js';
import { runBridgeSweep } from './bootSweeps.js';
import { makeSshBridgeLifecycle } from './sshBridgeOps.js';

/**
 * The D556 edit 6 lifecycle: a forwarder starts only for an ssh ticket, only in
 * the window that controls it, and only for a confirmed remote (zero ssh calls
 * otherwise). After a reload `runBridgeSweep` restarts it from `attach`.
 */

const REMOTE: RemoteDef = { host: 'box', user: 'karst', mode: 'direct', remoteDir: '/srv/karst' };
const NAME = 'karst-0123abcd-7-claude';
const PLACEMENT: TicketPlacement = { backend: 'ssh', core: 'claude', sandboxName: `devbox/${NAME}`, reason: null };

/** The spawn happens after the offset load and the control-dir check: wait for it without wall-clock timers. */
async function waitForStreams(ssh: ReturnType<typeof fakeSshProcess>, count: number): Promise<void> {
  for (let i = 0; i < 300 && ssh.streams.length < count; i++) await new Promise((r) => setImmediate(r));
}

let root: string;
let bridgeRoot: string;
let trustDir: string;
let store: Store;

const lifecycle = (ssh: ReturnType<typeof fakeSshProcess>, placementOf = (): TicketPlacement | null => PLACEMENT) =>
  makeSshBridgeLifecycle({
    bridgeRoot: () => bridgeRoot,
    trustDir,
    placementOf,
    remotes: () => ({ devbox: REMOTE }),
    ssh,
  });

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'karst-ssh-bridge-ops-'));
  bridgeRoot = join(root, 'bridge');
  trustDir = join(root, 'trust');
  await mkdir(trustDir, { recursive: true });
  store = openStore(':memory:');
});

afterEach(async () => {
  await stopAllSshBridgeForwarders();
  store.close();
  await rm(root, { recursive: true, force: true });
});

describe('makeSshBridgeLifecycle', () => {
  it('skips a non-ssh ticket and makes no ssh call', async () => {
    const ssh = fakeSshProcess();
    await expect(lifecycle(ssh, () => null).start(7)).resolves.toBe('skipped');
    expect(ssh.streams).toHaveLength(0);
    expect(ssh.calls).toHaveLength(0);
  });

  it('refuses an unconfirmed remote with zero ssh calls', async () => {
    const id = createTicket(store, { key: 'K-1', title: 't' }).id;
    await mkdir(join(bridgeRoot, 'events', String(id)), { recursive: true });
    const ssh = fakeSshProcess();
    await expect(lifecycle(ssh).start(id)).resolves.toBe('refused');
    expect(ssh.streams).toHaveLength(0);
    expect(ssh.calls).toHaveLength(0);
  });

  it('starts one forwarder of <ws>/bridge/<ticketId> for a confirmed remote, and stop kills it', async () => {
    const id = createTicket(store, { key: 'K-1', title: 't' }).id;
    await mkdir(join(bridgeRoot, 'events', String(id)), { recursive: true });
    await recordRemoteTrust(trustDir, 'devbox', REMOTE);
    const ssh = fakeSshProcess();
    const live = lifecycle(ssh);
    await expect(live.start(id)).resolves.toBe('started');
    await waitForStreams(ssh, 1);
    expect(ssh.streams).toHaveLength(1);
    expect(ssh.streams[0]!.args.at(-1)).toContain(`tail -c +1 -F`);
    expect(ssh.streams[0]!.args.at(-1)).toContain(`/srv/karst/${NAME}/bridge/${String(id)}/events.ndjson`);
    await live.stop(id);
    await live.stop(id); // idempotent
  });

  it('after a reload runBridgeSweep starts one forwarder per attached ssh ticket', async () => {
    const id = createTicket(store, { key: 'K-1', title: 't' }).id;
    await mkdir(join(bridgeRoot, 'events', String(id)), { recursive: true });
    await recordRemoteTrust(trustDir, 'devbox', REMOTE);
    const ssh = fakeSshProcess();
    const live = lifecycle(ssh);
    const sweep = vi.fn(async () => ({ reattached: [id], removed: [] }));
    await runBridgeSweep({
      store, bridges: { sweep }, owned: new Set(),
      liveSandboxTicketIds: async () => new Set([id]),
      startSshBridge: (ticketId) => live.start(ticketId),
      stopSshBridge: (ticketId) => live.stop(ticketId),
      info: vi.fn(), logError: vi.fn(),
    });
    await waitForStreams(ssh, 1);
    expect(ssh.streams).toHaveLength(1);
    await live.stop(id);
  });

  it('after a reload an unconfirmed remote attaches its poller but makes no ssh call', async () => {
    const id = createTicket(store, { key: 'K-1', title: 't' }).id;
    await mkdir(join(bridgeRoot, 'events', String(id)), { recursive: true });
    const ssh = fakeSshProcess();
    const live = lifecycle(ssh);
    await runBridgeSweep({
      store, bridges: { sweep: async () => ({ reattached: [id], removed: [] }) }, owned: new Set(),
      liveSandboxTicketIds: async () => new Set([id]),
      startSshBridge: (ticketId) => live.start(ticketId),
      info: vi.fn(), logError: vi.fn(),
    });
    expect(ssh.streams).toHaveLength(0);
    expect(ssh.calls).toHaveLength(0);
  });
});
