/**
 * The host-side confirm step for an SSH remote (T1387). The trust RECORD lives in
 * `agent/ssh/remoteTrust.ts`; this module only decides when to ask, so the
 * extension binding stays a modal and a closure. Host-agnostic: no `vscode`
 * import, the caller injects the modal (@arch:DBG-01 debug is a callback).
 */
import { backendForCore, parseSshBackend, type AgentBackends } from '../../agent/backendChoices.js';
import { ticketBackendSetting } from '../../agent/effectiveBackend.js';
import {
  isRemoteTrusted,
  readRemoteTrust,
  recordRemoteTrust,
  remoteConfirmDetail,
  remoteConfirmMessage,
  type RemoteTrustRecord,
} from '../../agent/ssh/remoteTrust.js';
import type { RemoteDef } from '../../manifest/types.js';

/** One `ssh:<name>` choice of a launch, resolved to the declared remote. */
export interface SshRemoteChoice {
  readonly name: string;
  readonly def: RemoteDef;
}

/**
 * The remote a launch would use, or undefined when the launch is not on ssh (or
 * names a remote the manifest does not declare). A missing definition is not a
 * trust decision: `resolveBackend` fails closed to the host without a runner.
 */
export function sshRemoteFor(
  backends: AgentBackends | undefined,
  remotes: Readonly<Record<string, RemoteDef>> | undefined,
  core: string,
  ticketOverride?: 'host' | null,
): SshRemoteChoice | undefined {
  const setting = ticketBackendSetting(backendForCore(backends, core), ticketOverride);
  const name = setting === undefined ? undefined : parseSshBackend(setting);
  const def = name === undefined ? undefined : remotes?.[name];
  return name === undefined || def === undefined ? undefined : { name, def };
}

export interface ConfirmRemoteDeps {
  /** The dir of `karst.db`: the trust file is its sibling, shared with the CLI. */
  readonly storageDir: string;
  /** The modal: true only on an explicit allow. */
  readonly confirm: (message: string, detail: string) => Promise<boolean>;
  readonly warn?: (message: string) => void;
  /** The already-read record (the host keeps it in memory); absent reads the file. */
  readonly trust?: () => RemoteTrustRecord;
  /** Test seam for the write. */
  readonly record?: (dir: string, name: string, def: RemoteDef, warn?: (message: string) => void) => Promise<void>;
}

/**
 * Before the first use of a remote, and after any keyed field changed, ask once
 * and store the answer. A decline stores nothing, so the launch resolves to
 * `host (ssh: remote '<name>' not confirmed)`.
 */
export async function confirmRemoteTrust(deps: ConfirmRemoteDeps, remote: SshRemoteChoice): Promise<boolean> {
  const trust = deps.trust ? deps.trust() : readRemoteTrust(deps.storageDir, deps.warn);
  if (isRemoteTrusted(trust, remote.name, remote.def)) return true;
  const accepted = await deps.confirm(remoteConfirmMessage(remote.name, remote.def), remoteConfirmDetail(remote.name, remote.def));
  if (!accepted) return false;
  await (deps.record ?? recordRemoteTrust)(deps.storageDir, remote.name, remote.def, deps.warn);
  return true;
}
