import type { RemoteDef } from '../../manifest/types.js';
import { isMirrorName } from '../bridge/mirror.js';
import { SEQ_PATTERN } from '../bridge/markerReply.js';
import { isRemoteTrusted, readRemoteTrust } from './remoteTrust.js';
import { ensureSshControlDir, sshControlDir, type SshControlResult } from './sshControlDir.js';
import { NODE_SSH_PROCESS, sshArgv, type SshProcess } from './sshProcess.js';
import { sshQuote } from './sshQuote.js';

/**
 * The remote half of the evidence bridge (D556, edit 2): one host-written file
 * copied into the remote bridge run dir, by stdin, so the remote agent reads the
 * same inbox brief, results reply, attachment or log it would read on the host.
 *
 * The host keeps its ONE verified append-only `events.ndjson`; this module never
 * touches it. The remote never connects to the host (no listener, no `ssh -R`).
 *
 * Trust is first (D553): an unconfirmed remote returns `ok: false` and runs no
 * ssh. The remote path is built only from a validated relative name, never from
 * arbitrary agent text, and the write is atomic (stdin into `cat > tmp`, then
 * `mv`).
 */

/** What the caller names: the manifest name (the trust key) plus its definition. */
export interface MirrorRemote {
  readonly name: string;
  readonly def: RemoteDef;
}

export type MirrorResult = { readonly ok: true } | { readonly ok: false; readonly reason: string };

export interface SshMirrorDeps {
  /** `<globalStorage>`: the dir of `ssh-trust.json` (D553). */
  readonly trustDir: string;
  readonly ssh?: SshProcess;
  readonly controlDir?: string;
  /** Defaults to `ensureSshControlDir`; tests inject a no-op. */
  readonly ensureControlDir?: (dir: string) => Promise<SshControlResult>;
  readonly warn?: (message: string) => void;
  readonly debug?: (message: string) => void;
}

/** The only relative names a mirror accepts: a marker reply, an inbox brief, an attachment, a log. */
const RESULTS_REL = /^results\/([^/]+)\.json$/;
const SIMPLE_REL = /^(inbox|attachments|logs)\/([^/]+)$/;

/** True for exactly `results/<seq>.json`, `inbox/<name>`, `attachments/<name>` or `logs/<name>`. */
export function isValidMirrorRel(rel: string): boolean {
  if (rel.includes('\0') || rel.includes('\\') || rel.startsWith('/') || rel.includes('..')) return false;
  const results = RESULTS_REL.exec(rel);
  if (results !== null) return SEQ_PATTERN.test(results[1]!);
  const simple = SIMPLE_REL.exec(rel);
  return simple !== null && isMirrorName(simple[2]!);
}

function lastLine(text: string): string {
  const line = text.trim().split('\n').filter((l) => l.trim() !== '').at(-1);
  return line === undefined ? '' : line.slice(0, 300);
}

/**
 * The remote script of one mirror. `umask 077` keeps the temp private, the
 * `trap` cleans it on any failure, and the `mv` is the atomic publish the poller
 * on the remote side expects.
 */
export function mirrorScript(runDir: string, rel: string): string {
  const target = `${runDir.replace(/\/+$/, '')}/${rel}`;
  const dir = target.slice(0, target.lastIndexOf('/'));
  return [
    '# karst-ssh-mirror',
    'umask 077',
    `d=${sshQuote(dir)}`,
    'mkdir -p -m 700 "$d" || exit 1',
    `t=${sshQuote(target)}.tmp.$$`,
    `trap 'rm -f "$t"' EXIT`,
    'cat > "$t" || exit 1',
    `mv -f "$t" ${sshQuote(target)}`,
  ].join('\n');
}

/**
 * Copy `body` to `<runDir>/<rel>` on the remote. `runDir` is the remote bridge
 * run dir (`<ws>/bridge/<ticketId>`, D555 `bridgeRunDir`), NOT the host dir.
 *
 * Returns `ok: false` for an unconfirmed remote, a bad relative name, a control
 * dir that is not private, a transport failure or a non-zero remote exit. A
 * failed mirror means the caller must not nudge: the host file stays and the
 * fix-delivery sweep retries.
 */
export async function mirrorToRemote(
  remote: MirrorRemote,
  runDir: string,
  rel: string,
  body: string,
  deps: SshMirrorDeps,
): Promise<MirrorResult> {
  const trust = readRemoteTrust(deps.trustDir, deps.warn);
  if (!isRemoteTrusted(trust, remote.name, remote.def)) {
    return { ok: false, reason: `ssh remote ${remote.name} not confirmed` };
  }
  if (!isValidMirrorRel(rel)) return { ok: false, reason: `ssh mirror: invalid bridge path ${JSON.stringify(rel)}` };
  if (runDir === '' || runDir.includes('\0') || runDir.includes('\n')) {
    return { ok: false, reason: 'ssh mirror: invalid remote bridge dir' };
  }
  const controlDir = deps.controlDir ?? sshControlDir();
  const control = await (deps.ensureControlDir ?? ensureSshControlDir)(controlDir).catch(
    (err: unknown): SshControlResult => ({ ok: false, reason: err instanceof Error ? err.message : String(err) }),
  );
  if (!control.ok) return { ok: false, reason: control.reason };
  const ssh = deps.ssh ?? NODE_SSH_PROCESS;
  const out = await ssh.runWithStdin(
    sshArgv(remote.def, controlDir, mirrorScript(runDir, rel)),
    Buffer.from(body, 'utf8'),
    { maxStdoutBytes: 4 * 1024 },
  );
  if (out.transport === true) {
    return { ok: false, reason: `ssh ${remote.name}: transport failed while mirroring ${rel}: ${lastLine(out.stderr)}` };
  }
  if (out.code !== 0) {
    return { ok: false, reason: `ssh ${remote.name}: mirror ${rel} failed (exit ${String(out.code)})${lastLine(out.stderr) === '' ? '' : `: ${lastLine(out.stderr)}`}` };
  }
  deps.debug?.(`[ssh ${remote.name}] mirrored ${rel}`);
  return { ok: true };
}
