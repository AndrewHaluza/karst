import { readFileSync } from 'node:fs';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import type { HookPayload } from '../../hooks/dispatch.js';
import { isMarkerStage, type MarkerStage } from '../markerStage.js';
import type { BridgePaths } from './bridgeDir.js';
import { createBridgePoller, type BridgePoller } from './bridgePoller.js';
import { verifyBridgeLine, type BridgeExpectation } from './bridgeVerifier.js';
import { createMarkerFlow, type MarkerFailure, type MarkerOutcome, type PendingMarkerStore } from './markerFlow.js';
import { writeMarkerReply } from './markerReply.js';

export type MarkerRunner = (stage: MarkerStage) => Promise<MarkerOutcome>;

export interface BridgeAttachmentDeps {
  readonly paths: BridgePaths;
  readonly expect: BridgeExpectation;
  readonly dispatch: (payload: HookPayload) => void;
  readonly runMarker: MarkerRunner;
  /** A verified ack line: the agent read inbox brief `ref`. The host decides whether `ref` is a pending delivery. */
  readonly onAck?: (ref: string) => void;
  readonly intervalMs: number;
  readonly debug?: (message: string) => void;
  /** A marker failure the user must see (WARN log + notification); the sink logs it either way. */
  readonly onMarkerFailure?: (failure: MarkerFailure) => void;
  /** Test seam for the retry timer. */
  readonly schedule?: (fn: () => void, ms: number) => () => void;
  readonly backoffMs?: readonly number[];
}

export type BridgeAttachment = Pick<BridgePoller, 'start' | 'stop' | 'pollOnce'> & {
  /** Re-run a marker that failed transiently (boot sweep, successful sync). */
  retryPending?(): Promise<void>;
};

/** The retry record lives in the host-only state dir (never the sandbox-writable events dir); a garbled file reads as none. */
function filePendingStore(file: string): PendingMarkerStore {
  return {
    load: async () => {
      try {
        const parsed: unknown = JSON.parse(await readFile(file, 'utf8'));
        const stage = (parsed as { stage?: unknown } | null)?.stage;
        return typeof stage === 'string' && isMarkerStage(stage) ? stage : undefined;
      } catch {
        return undefined;
      }
    },
    save: async (stage) => {
      await writeFile(`${file}.tmp`, JSON.stringify({ stage }));
      await rename(`${file}.tmp`, file);
    },
    clear: () => rm(file, { force: true }),
  };
}

/** How many handled marker seqs are remembered (oldest dropped): enough for any realistic rescan. */
const MAX_HANDLED_SEQS = 256;

/** The seqs of markers this host already handled, kept host-side so a reattach or a rewritten events file never replays one. */
function handledSeqs(file: string, log: (m: string) => void) {
  let seqs: string[] = [];
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (Array.isArray(parsed)) seqs = parsed.filter((s): s is string => typeof s === 'string').slice(-MAX_HANDLED_SEQS);
  } catch {
    seqs = [];
  }
  const seen = new Set(seqs);
  return {
    has: (seq: string): boolean => seen.has(seq),
    add: (seq: string): void => {
      seen.add(seq);
      seqs = [...seqs, seq].slice(-MAX_HANDLED_SEQS);
      void writeFile(`${file}.tmp`, JSON.stringify(seqs))
        .then(() => rename(`${file}.tmp`, file))
        .catch((err: unknown) => log(`handled-seq record failed: ${err instanceof Error ? err.message : String(err)}`));
    },
  };
}

/**
 * Tails one ticket's bridge file (arch:AC-34): verified hooks go to
 * `dispatch`, a verified own-stage marker goes through the marker flow (run
 * the host's marker CLI, reply to the agent, retry a transient failure). A
 * marker run is queued, so a slow CLI never stalls the tail.
 */
export function createBridgeAttachment(deps: BridgeAttachmentDeps): BridgeAttachment {
  const log = (m: string): void => deps.debug?.(`[bridge] ${m}`);
  const id = deps.expect.ticketId;
  const flow = createMarkerFlow({
    runMarker: deps.runMarker,
    reply: (seq, reply) => writeMarkerReply(deps.paths, seq, reply),
    pending: filePendingStore(deps.paths.pendingFile),
    currentStage: deps.expect.stage,
    report: (failure) => {
      log(`ticket ${id} marker ${failure.stage} failed: ${failure.reason}`);
      deps.onMarkerFailure?.(failure);
    },
    ...(deps.schedule ? { schedule: deps.schedule } : {}),
    ...(deps.backoffMs ? { backoffMs: deps.backoffMs } : {}),
  });
  const handled = handledSeqs(deps.paths.handledFile, log);
  const poller = createBridgePoller({
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
      else if (verdict.event.kind === 'ack') deps.onAck?.(verdict.event.ref);
      else {
        const { stage, seq } = verdict.event;
        if (seq !== undefined) {
          if (handled.has(seq)) {
            log(`ticket ${id} marker ${stage} seq ${seq} already handled: skipped`);
            return;
          }
          handled.add(seq);
        }
        void flow.handle(stage, seq).catch((err: unknown) => log(`ticket ${id} marker failed: ${err instanceof Error ? err.message : String(err)}`));
      }
    },
  });
  return {
    pollOnce: poller.pollOnce,
    start: () => {
      poller.start();
      void flow.retryPending().catch(() => undefined);
    },
    stop: async () => {
      flow.stop();
      await poller.stop();
    },
    retryPending: () => flow.retryPending(),
  };
}
