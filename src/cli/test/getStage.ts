import type { Store } from '../../store/db.js';
import type { StageKey } from '../../model/types.js';
import { STAGE_KEYS } from '../../model/types.js';
import { getStage } from '../../store/stages.js';
import { listGateRuns } from '../../store/gateRuns.js';
import { parseFlags, requireFlag, type TestFlags } from './flags.js';

/**
 * `karst test get-stage` — one stage's row plus the evidence that stage
 * accumulated: its `gate_runs` and its findings. Findings are inherently
 * stage-keyed by table (`uat_findings` is UAT's, `review_findings` is review's),
 * so "findings for a stage" is reading the matching table — no join needed.
 */

export interface ParsedGetStage {
  stage: StageKey;
}

export function parseGetStageArgs(argv: string[]): ParsedGetStage {
  const flags: TestFlags = parseFlags(argv);
  const stage = requireFlag(flags, 'stage');
  if (!STAGE_KEYS.includes(stage as StageKey)) {
    throw new Error(`unknown stage '${stage}' (want one of ${STAGE_KEYS.join(', ')})`);
  }
  return { stage: stage as StageKey };
}

export function runGetStage(store: Store, ticketId: number, parsed: ParsedGetStage): string {
  const stage = getStage(store, ticketId, parsed.stage);
  if (stage === null) {
    throw new Error(`ticket ${ticketId} has no stage '${parsed.stage}'`);
  }
  const gates = listGateRuns(store, ticketId).filter((g) => g.stageKey === parsed.stage);
  const findingsTable =
    parsed.stage === 'uat' ? 'uat_findings' : parsed.stage === 'review' ? 'review_findings' : null;
  const findings = findingsTable
    ? (store.db
        .prepare(`SELECT * FROM ${findingsTable} WHERE ticket_id = ? ORDER BY id`)
        .all(ticketId) as unknown[])
    : [];

  return JSON.stringify(
    {
      stageKey: stage.stageKey,
      status: stage.status,
      attempt: stage.attempt,
      verdict: stage.verdict,
      startedAt: stage.startedAt,
      endedAt: stage.endedAt,
      blocked: stage.blockedKind === null ? null : {
        kind: stage.blockedKind,
        reason: stage.blockedReason,
        at: stage.blockedAt,
      },
      gateRuns: gates.map((g) => ({
        id: g.id,
        gate: g.gateName,
        exitCode: g.exitCode,
        attempt: g.attempt,
        runAt: g.runAt,
      })),
      findings,
    },
    null,
    2,
  );
}
