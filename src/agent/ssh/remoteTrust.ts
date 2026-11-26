/**
 * The host-side SSH trust record (T1387). ONE file, `<globalStorage>/ssh-trust.json`
 * (mode 0600), beside `karst.db`, so the extension and the `karst` CLI read the
 * same record. It is NOT in the repository: `karst.yml` is repo-controlled, and a
 * malicious clone could point `ssh:<name>` at a host already in known_hosts and
 * use the user's key.
 *
 * The key hashes every field that changes what leaves the host. Any later SSH
 * entry point must call `isRemoteTrusted` before it runs an ssh command and run
 * NONE for an unconfirmed remote. Host-agnostic: no `vscode`, no global logger.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { chmod, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { RemoteDef } from '../../manifest/types.js';

/** The sibling file of `karst.db`. */
export const REMOTE_TRUST_FILE = 'ssh-trust.json';

/** remote name → the hash of the definition the user allowed. */
export type RemoteTrustRecord = Readonly<Record<string, string>>;

/**
 * A digest over `name` and every field that changes what leaves the host:
 * `host`, `port`, `user`, `keyPath`, `mode`, `remoteDir`, `allowHostServices`.
 * An absent optional and its explicit default form hash the same.
 */
export function remoteTrustKey(name: string, def: RemoteDef): string {
  const payload = JSON.stringify([
    name,
    def.host,
    def.port ?? null,
    def.user,
    def.keyPath ?? null,
    def.mode,
    def.remoteDir,
    def.allowHostServices === true,
  ]);
  return createHash('sha256').update(payload).digest('hex');
}

/** The record; a missing or corrupt file reads as empty. A corrupt one warns once. */
export function readRemoteTrust(dir: string, warn?: (message: string) => void): RemoteTrustRecord {
  const file = join(dir, REMOTE_TRUST_FILE);
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') warn?.(`ssh trust: cannot read ${file}: ${describe(err)}`);
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    const trust: Record<string, string> = {};
    for (const [name, hash] of Object.entries(parsed)) {
      if (typeof hash === 'string') trust[name] = hash;
    }
    return trust;
  } catch (err) {
    warn?.(`ssh trust: ignoring corrupt ${file}: ${describe(err)}`);
    return {};
  }
}

/** Whether the user allowed this exact definition of this remote. */
export function isRemoteTrusted(trust: RemoteTrustRecord, name: string, def: RemoteDef): boolean {
  return trust[name] === remoteTrustKey(name, def);
}

/**
 * Store the confirm for ONE remote: temp file + rename, mode 0600, so a crash
 * never leaves half a file. Other remotes' entries are kept.
 */
export async function recordRemoteTrust(dir: string, name: string, def: RemoteDef, warn?: (message: string) => void): Promise<void> {
  const file = join(dir, REMOTE_TRUST_FILE);
  const tmp = join(dir, `.${REMOTE_TRUST_FILE}.${process.pid}.${Date.now()}.tmp`);
  await mkdir(dir, { recursive: true });
  const next = { ...readRemoteTrust(dir, warn), [name]: remoteTrustKey(name, def) };
  try {
    await writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    await chmod(tmp, 0o600);
    await rename(tmp, file);
    await chmod(file, 0o600);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
}

/** The modal title: short, names the remote. */
export function remoteConfirmMessage(name: string, _def: RemoteDef): string {
  return `Allow the agent to run on ssh remote '${name}'?`;
}

/** The modal detail: every field that leaves the host. */
export function remoteConfirmDetail(_name: string, def: RemoteDef): string {
  return [
    `target: ${def.user}@${def.host}:${def.port ?? 22}`,
    `key: ${def.keyPath ?? '(ssh default key)'}`,
    `mode: ${def.mode}`,
    `remoteDir: ${def.remoteDir}`,
    `allowHostServices: ${def.allowHostServices === true ? 'yes' : 'no'}`,
  ].join('\n');
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
