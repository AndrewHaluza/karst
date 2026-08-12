import type { Store } from '../../store/db.js';
import type { StageKey } from '../../model/types.js';
import { GATE_STAGES } from '../../workflow/graph.js';
import { recordGateRun } from '../../store/gateRuns.js';
import { stageAttempt } from '../../store/stages.js';
import { nowIso } from '../../model/time.js';
import { recordTestLog } from './testMode.js';
import { parseFlags, requireFlag, requireIntFlag, type TestFlags } from './flags.js';

/**
 * `karst test run-gate` — record a gate result directly (no shell execution),
 * so a test controls the exit code the aggregation rules will read. The gate
 * outcome is written through `recordGateRun`, the same append-only seam the
 * real gate runner uses, filed under the stage's CURRENT attempt unless the
 * caller overrides it.
 *
 * `--stdout`/`--stderr` carry the evidence a real gate would have printed; they
 * are stored as structured `test_logs` rows (module `[gate]`) rather than on the
 * `gate_runs` row, which has no output column and must not gain one — it is read
 * on the panel's render path.
 */

export interface ParsedRunGate {
  stage: StageKey;
  gate: string;
  exitCode: number;
  attempt: number | null;
  stdout: string | undefined;
  stderr: string | undefined;
}

export function parseRunGateArgs(argv: string[]): ParsedRunGate {
  const flags: TestFlags = parseFlags(argv);
  const stage = requireFlag(flags, 'stage');
  if (!GATE_STAGES.includes(stage as StageKey)) {
    throw new Error(`run-gate stage must be one of ${GATE_STAGES.join(', ')} (got '${stage}')`);
  }
  const exitCode = requireIntFlag(flags, 'exit-code');
  const attemptRaw = flags.attempt;
  if (attemptRaw !== undefined && !/^\d+$/.test(attemptRaw)) {
    throw new Error(`flag '--attempt' must be a non-negative integer (got '${attemptRaw}')`);
  }
  return {
    stage: stage as StageKey,
    gate: requireFlag(flags, 'gate'),
    exitCode,
    attempt: attemptRaw === undefined ? null : parseInt(attemptRaw, 10),
    stdout: flags.stdout,
    stderr: flags.stderr,
  };
}

export function runRunGate(store: Store, ticketId: number, parsed: ParsedRunGate): string {
  const attempt = parsed.attempt ?? stageAttempt(store, ticketId, parsed.stage);
  const runAt = nowIso();
  recordGateRun(store, {
    ticketId,
    stageKey: parsed.stage,
    attempt,
    runAt,
    gates: [
      {
        gateName: parsed.gate,
        exitCode: parsed.exitCode,
        startedAt: runAt,
        endedAt: runAt,
      },
    ],
  });
  // Evidence a real gate run would have carried on its streams. Only recorded
  // when the caller supplied it — an absent stream is absent, never blanked.
  if (parsed.stdout !== undefined || parsed.stderr !== undefined) {
    recordTestLog(store, {
      ticketId,
      level: 'info',
      module: '[gate]',
      message: `gate '${parsed.gate}' (${parsed.stage}) exit ${parsed.exitCode}`,
      meta: { gate: parsed.gate, stage: parsed.stage, exitCode: parsed.exitCode, stdout: parsed.stdout, stderr: parsed.stderr },
    });
  }
  return JSON.stringify({ stage: parsed.stage, gate: parsed.gate, exitCode: parsed.exitCode, attempt, runAt });
}
