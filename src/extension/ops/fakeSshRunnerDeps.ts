import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REMOTE_TRUST_FILE, remoteTrustKey } from '../../agent/ssh/remoteTrust.js';
import type { FakeSshProcess } from '../../agent/ssh/fakeSshProcess.js';
import { sshProjectPrefix } from '../../agent/ssh/sshNames.js';
import type { RemoteDef } from '../../manifest/types.js';
import type { TicketPlacement } from '../../store/placement.js';
import type { SshRunnerDeps } from './sshRunnerFor.js';

/** Test double of the `sshRunnerFor` deps (like `agent/ssh/fakeSshProcess.ts`): one trusted direct remote `devbox`. */
export const FAKE_REMOTE: RemoteDef = { host: 'vm.example.com', user: 'karst', mode: 'direct', remoteDir: '/srv/karst' };
export const FAKE_INSTALL_ID = '0123456789abcdef0123456789abcdef';

/** The recorded ssh placement of ticket `ticketId` (project root `/p`) on `devbox`. */
export function fakeSshPlacement(ticketId = 7, core = 'claude'): TicketPlacement {
  return { backend: 'ssh', core, sandboxName: `devbox/${sshProjectPrefix('/p', FAKE_INSTALL_ID)}-${String(ticketId)}-${core}`, reason: null };
}

/** A globalStorage dir whose trust file holds `entries` (default: `devbox` confirmed). */
export function fakeTrustDir(entries: Record<string, string> = { devbox: remoteTrustKey('devbox', FAKE_REMOTE) }): string {
  // Stryker disable next-line StringLiteral: equivalent, the prefix only names the temp dir
  const dir = mkdtempSync(join(tmpdir(), 'karst-ssh-trust-'));
  writeFileSync(join(dir, REMOTE_TRUST_FILE), JSON.stringify(entries));
  return dir;
}

export function fakeSshRunnerDeps(ssh: FakeSshProcess, over: Partial<SshRunnerDeps> = {}): SshRunnerDeps {
  return {
    remotes: () => ({ devbox: FAKE_REMOTE }), installId: () => FAKE_INSTALL_ID, globalStorageDir: fakeTrustDir(), ssh,
    controlDir: '/tmp/karst-ssh-test/', ensureControlDir: async () => ({ ok: true }), ...over,
  };
}
