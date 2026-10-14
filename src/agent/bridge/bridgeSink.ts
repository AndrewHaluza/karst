import type { HookPayload } from '../../hooks/dispatch.js';
import type { MarkerStage } from '../markerStage.js';
import type { BridgePaths } from './bridgeDir.js';
import { createBridgePoller, type BridgePoller } from './bridgePoller.js';
import { verifyBridgeLine, type BridgeExpectation } from './bridgeVerifier.js';

export type MarkerRunner = (stage: MarkerStage) => Promise<{ readonly code: number; readonly stderr: string }>;

export interface BridgeAttachmentDeps {
  readonly paths: BridgePaths;
  readonly expect: BridgeExpectation;
  readonly dispatch: (payload: HookPayload) => void;
  readonly runMarker: MarkerRunner;
  readonly intervalMs: number;
  readonly debug?: (message: string) => void;
}

export type BridgeAttachment = Pick<BridgePoller, 'start' | 'stop' | 'pollOnce'>;

/**
 * Tails one ticket's bridge file (arch:AC-34): verified hooks go to
 * `dispatch`, a verified own-stage marker runs the host's marker CLI. The
 * marker run is not awaited, so a slow CLI never stalls the tail.
 */
export function createBridgeAttachment(deps: BridgeAttachmentDeps): BridgeAttachment {
  const log = (m: string): void => deps.debug?.(`[bridge] ${m}`);
  const id = deps.expect.ticketId;
  const runMarker = (stage: MarkerStage): void => {
    void deps.runMarker(stage).then(
      (r) => {
        if (r.code !== 0) log(`ticket ${id} marker ${stage} exited ${r.code}: ${r.stderr.trim()}`);
      },
      (err: unknown) => log(`ticket ${id} marker ${stage} failed: ${err instanceof Error ? err.message : String(err)}`),
    );
  };
  return createBridgePoller({
    file: deps.paths.eventsFile,
    stateFile: deps.paths.stateFile,
    intervalMs: deps.intervalMs,
    ...(deps.debug ? { debug: deps.debug } : {}),
    onLine: (line) => {
      const verdict = verifyBridgeLine(line, deps.expect);
      if (!verdict.ok) {
        log(`ticket ${id} dropped: ${verdict.reason}`);
        return;
      }
      if (verdict.event.kind === 'hook') deps.dispatch(verdict.event.payload);
      else runMarker(verdict.event.stage);
    },
  });
}
