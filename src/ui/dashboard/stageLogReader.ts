import type { Store } from '../../store/db.js';
import { getStage } from '../../store/stages.js';
import type { ConsoleStage } from '../../store/ticketGates.js';
import { listDeliverResults } from '../../store/deliverRuns.js';
import type { StageLogResult } from './messages.js';

/**
 * Read one gate stage's console log for the terminal "detailed mode" view.
 *
 * The webview names only a closed-vocabulary stage; the path is resolved HERE
 * from the store (never accepted from a message), the file is read bounded,
 * and every failure is a named `error` result — a missing file is a normal
 * refusal, never a throw, mirroring `openArtifactResource`'s copy.
 */

/** Defensive read bound. The recording itself caps at 1 MiB + marker + headers. */
export const STAGE_LOG_READ_CAP_BYTES = 2 * 1024 * 1024;

export function readStageLog(
  store: Store,
  ticketId: number,
  stage: ConsoleStage,
  readFile: (path: string) => string,
  debug?: (msg: string) => void,
): StageLogResult {
  debug?.(`[stage-log] reading ${stage} for ticket ${ticketId}`);
  if (stage === 'ship') return readShipLog(store, ticketId);
  const row = getStage(store, ticketId, stage);
  const path = row?.artifactPath;
  if (!path) {
    debug?.(`[stage-log] ${stage} has no recorded artifact path`);
    return { kind: 'error', message: 'This stage has no recorded console log.' };
  }
  try {
    const content = readFile(path);
    if (Buffer.byteLength(content, 'utf8') <= STAGE_LOG_READ_CAP_BYTES) {
      return { kind: 'ok', content, truncated: false };
    }
    return {
      kind: 'ok',
      content: `${content.slice(0, STAGE_LOG_READ_CAP_BYTES)}\n[console output truncated]\n`,
      truncated: true,
    };
  } catch {
    debug?.(`[stage-log] artifact file unreadable: ${path}`);
    return { kind: 'error', message: 'The recorded log file is no longer available.' };
  }
}

/**
 * The post-run ship console: the live stream persists nothing (@arch:GATE-OUTPUT), so the
 * record is the kept gate results of the auto-deliver (gate, exit code, head, summary).
 */
function readShipLog(store: Store, ticketId: number): StageLogResult {
  const results = listDeliverResults(store, ticketId);
  if (results.length === 0) return { kind: 'error', message: 'This ticket has no recorded delivery gate run.' };
  const content = results
    .map((r) => `$ ${r.gateName} (${r.repo}) exit ${r.exitCode ?? 'none'} on ${r.headSha?.slice(0, 9) ?? 'unknown head'}\n${r.summary ?? ''}\n`)
    .join('\n');
  return { kind: 'ok', content, truncated: false };
}
