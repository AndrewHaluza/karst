import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { RemoteDef } from '../../manifest/types.js';
import type { TicketPlacement } from '../../store/placement.js';
import { fakeSshProcess } from '../../agent/ssh/fakeSshProcess.js';
import { wireSshBridge } from './sshBridgeWiring.js';

const def: RemoteDef = { host: 'devbox.example.com', user: 'karst', port: 22, mode: 'direct', remoteDir: '/srv/karst' };
const HOST: TicketPlacement = { backend: 'host', core: null, sandboxName: null, reason: null };
const SSH_PLACEMENT: TicketPlacement = { backend: 'ssh', core: 'opencode2', sandboxName: 'devbox/karst-1234abcd-7-opencode2', reason: null };

function wiring(placement: TicketPlacement, remotes: Record<string, RemoteDef> | undefined = { devbox: def }) {
  const ssh = fakeSshProcess();
  const debug: string[] = [];
  const w = wireSshBridge({
    bridgeRoot: () => undefined,
    trustDir: mkdtempSync(join(tmpdir(), 'karst-ssh-bridge-wiring-')),
    placementOf: () => placement,
    remotes: () => remotes,
    ssh,
    ensureControlDir: async () => ({ ok: true as const }),
    debug: (m) => debug.push(m),
    warn: () => undefined,
  });
  return { w, ssh, debug };
}

describe('wireSshBridge', () => {
  it('a host ticket: the file and dir mirrors are no-op successes with no ssh call', async () => {
    const { w, ssh } = wiring(HOST);
    await expect(w.mirrorTicketFile(7, 'results/a.json', '{}')).resolves.toEqual({ ok: true });
    await expect(w.mirrorTicketDirs(7)).resolves.toEqual({ ok: true, mirrored: [], skipped: [] });
    expect(ssh.stdinCalls).toEqual([]);
  });

  it('an ssh ticket on a removed remote: both mirrors refuse with the remote name', async () => {
    const { w } = wiring(SSH_PLACEMENT, {});
    await expect(w.mirrorTicketFile(7, 'results/a.json', '{}')).resolves.toEqual({ ok: false, reason: 'ssh remote devbox not in karst.yml' });
    await expect(w.mirrorTicketDirs(7)).resolves.toMatchObject({ ok: false, reason: 'ssh remote devbox not in karst.yml' });
  });

  it('the bridge lifecycle skips a host ticket, and dispose stops it without a debug failure', async () => {
    const { w, debug } = wiring(HOST);
    await expect(w.sshBridge.start(7)).resolves.toBe('skipped');
    w.dispose();
    await new Promise((r) => setTimeout(r, 0));
    expect(debug.filter((m) => m.includes('on dispose failed'))).toEqual([]);
  });
});
