import type { Store } from '../../store/db.js';
import type { BlockerKind, StageKey, StageStatus } from '../../model/types.js';
import { STAGE_KEYS } from '../../model/types.js';
import { setStage } from '../../store/stages.js';
import { nowIso } from '../../model/time.js';
import { parseFlags, requireFlag, type TestFlags } from './flags.js';

/**
 * `karst test set-stage` — move a ticket to a stage directly, bypassing the
 * machine. This is a RAW state mutation for driving deterministic tests, which
 * is exactly why `done` is refused: `done` means every PR merged, and that fact
 * is only ever established by a real ship verdict through the machine (or the
 * merge gate). Setting `done` here would let a test claim a landing nothing
 * ever performed.
 *
 * The optional `--block <kind>` / `--block-reason <reason>` flags create the
 * parked state the merge gate works with — a test drives the
 * ship-waits-awaiting-merge path by parking the ticket at `ship` with the
 * `awaiting-merge` block, the way a real ship's tail does, so `merge-pr` can
 * then land it.
 */

const STATUS_VALUES: readonly StageStatus[] = ['pending', 'running', 'passed', 'failed', 'skipped', 'bypassed'];

const BLOCK_KINDS: readonly BlockerKind[] = [
  'nothing-to-run',
  'capability-missing',
  'no-independent-signal',
  'boot-failed',
  'lease-lost',
  'awaiting-merge',
  'unmapped-repository',
];

export interface ParsedSetStage {
  stage: StageKey;
  status: StageStatus;
  blockKind: BlockerKind | null;
  blockReason: string | null;
}

export function parseSetStageArgs(argv: string[]): ParsedSetStage {
  const flags: TestFlags = parseFlags(argv);
  const stage = requireFlag(flags, 'stage');
  const status = requireFlag(flags, 'status');
  if (!STAGE_KEYS.includes(stage as StageKey)) {
    throw new Error(
      `unknown stage '${stage}' (want one of ${STAGE_KEYS.join(', ')})`,
    );
  }
  if (stage === 'done') {
    throw new Error(
      "cannot set-stage 'done' directly — 'done' means every PR merged, which only a ship verdict establishes (use advance or merge-pr)",
    );
  }
  if (!STATUS_VALUES.includes(status as StageStatus)) {
    throw new Error(
      `unknown stage status '${status}' (want one of ${STATUS_VALUES.join(', ')})`,
    );
  }
  const blockKind = flags.block ?? null;
  if (blockKind !== null && !BLOCK_KINDS.includes(blockKind as BlockerKind)) {
    throw new Error(
      `unknown blocker kind '${blockKind}' (want one of ${BLOCK_KINDS.join(', ')})`,
    );
  }
  if (flags.block !== undefined && flags['block-reason'] === undefined) {
    throw new Error("flag '--block' requires '--block-reason'");
  }
  return {
    stage: stage as StageKey,
    status: status as StageStatus,
    blockKind: blockKind as BlockerKind | null,
    blockReason: flags['block-reason'] ?? null,
  };
}

export function runSetStage(store: Store, ticketId: number, parsed: ParsedSetStage): string {
  // The stage row may not exist (a ticket from before the stage was added, or a
  // row a prior migration never seeded) — `setStage` is an UPDATE and would
  // silently write nothing. Seed a pending row first, then patch.
  store.db
    .prepare(
      `INSERT OR IGNORE INTO stages (ticket_id, stage_key, status, attempt)
       VALUES (?, ?, 'pending', 0)`,
    )
    .run(ticketId, parsed.stage);
  setStage(store, ticketId, parsed.stage, {
    status: parsed.status,
    startedAt: nowIso(),
    ...(parsed.blockKind !== null
      ? {
          blockedKind: parsed.blockKind,
          blockedReason: parsed.blockReason,
          blockedAt: nowIso(),
        }
      : {}),
  });
  store.db
    .prepare('UPDATE tickets SET stage_current = ? WHERE id = ?')
    .run(parsed.stage, ticketId);
  return JSON.stringify({
    stageKey: parsed.stage,
    status: parsed.status,
    block: parsed.blockKind,
  });
}
