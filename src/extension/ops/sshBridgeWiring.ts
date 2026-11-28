import type { RemoteDef } from '../../manifest/types.js';
import type { SshControlResult } from '../../agent/ssh/sshControlDir.js';
import type { SshProcess } from '../../agent/ssh/sshProcess.js';
import type { TicketPlacement } from '../../store/placement.js';
import { makeSshBridgeLifecycle, type SshBridgeLifecycle, type SshBridgeLifecycleDeps } from './sshBridgeOps.js';
import { makeTicketMirror, makeTicketMirrorDirs, type TicketMirror, type TicketMirrorDirs } from './sshMirrorFor.js';

/**
 * The window wiring of the D556 ssh evidence bridge: one forwarder lifecycle
 * (edit 6), one mirror seam for fix briefs and marker replies (edit 2) and one
 * for the attachment and gate-log copies (edit 5). All three share one deps set.
 * `extension.ts` keeps only this call and the dispose registration.
 */
export interface SshBridgeWiringDeps {
  readonly bridgeRoot: () => string | undefined;
  /** `<globalStorage>`: the dir of `ssh-trust.json` (D553). */
  readonly trustDir: string;
  readonly placementOf: (ticketId: number) => TicketPlacement | null;
  readonly remotes: () => Readonly<Record<string, RemoteDef>> | undefined;
  readonly ssh?: SshProcess;
  readonly ensureControlDir?: (dir: string) => Promise<SshControlResult>;
  readonly debug: (message: string) => void;
  readonly warn: (message: string) => void;
  /** The forwarder lifecycle factory; a test injects a fake (default {@link makeSshBridgeLifecycle}). */
  readonly makeLifecycle?: (deps: SshBridgeLifecycleDeps) => SshBridgeLifecycle;
}

export interface SshBridgeWiring {
  readonly sshBridge: SshBridgeLifecycle;
  readonly mirrorTicketFile: TicketMirror;
  readonly mirrorTicketDirs: TicketMirrorDirs;
  /** Window close: abort every stream, then stop every forwarder (the offset file keeps the reconnect point). */
  readonly dispose: () => void;
}

export function wireSshBridge(deps: SshBridgeWiringDeps): SshBridgeWiring {
  // The callees default `ssh` (NODE_SSH_PROCESS) and `ensureControlDir` (ensureSshControlDir) themselves.
  const ensureControlDir = deps.ensureControlDir;
  const abort = new AbortController();
  const shared = { trustDir: deps.trustDir, placementOf: deps.placementOf, remotes: deps.remotes, ssh: deps.ssh, warn: deps.warn, debug: deps.debug };
  const sshBridge = (deps.makeLifecycle ?? makeSshBridgeLifecycle)({ ...shared, bridgeRoot: deps.bridgeRoot, signal: abort.signal });
  const mirrorTicketFile = makeTicketMirror({ ...shared, ensureControlDir });
  const mirrorTicketDirs = makeTicketMirrorDirs({ ...shared, ensureControlDir, bridgeRoot: deps.bridgeRoot });
  const dispose = (): void => {
    abort.abort();
    void sshBridge.stopAll().catch((e: unknown) => deps.debug(`[ssh] bridge forwarders on dispose failed: ${e instanceof Error ? e.message : String(e)}`));
  };
  return { sshBridge, mirrorTicketFile, mirrorTicketDirs, dispose };
}
