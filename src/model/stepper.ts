import { STAGE_KEYS, type BlockerKind, type StageKey, type StageStatus } from './types.js';
import { collapseDiagnostic } from './diagnosticText.js';

/**
 * One stepper cell — a stage node in a workflow stepper (§14). Shared by the
 * dashboard (live, per-server view) and the ticket form in edit mode (read-only
 * progress glance) so both order and shape stay identical.
 *
 * Beyond `status`, a cell carries the machine truth the stage row already
 * records, so a red node can explain itself in the UI instead of forcing the
 * user into the dev-only output channel: why it failed (`reason`), where the
 * full log is (`artifactPath`), when it ran, and which attempt this was.
 * Detail fields are absent (never null) when the stage has nothing to say.
 */
export interface StepperCell {
  stageKey: StageKey;
  status: StageStatus;
  /** The stage's verdict reason, e.g. `gates failed: lint, test`. */
  reason?: string;
  /** Path to the stage's log on disk — what an "Open log" action opens. */
  artifactPath?: string;
  startedAt?: string;
  endedAt?: string;
  attempt?: number;
  /**
   * Why karst could not ask this stage's question — set only while the stage is
   * parked (`parkGateStage`/`clearStageBlock`, `store/stageBlocks.ts`). Absent
   * (never null) exactly like every other detail field here: a stage that has
   * never been blocked has nothing to say about it.
   */
  blocked?: { kind: BlockerKind; reason: string; at: string };
}

/**
 * A stage row as the stepper reads it. Only `stageKey`/`status` are required so
 * callers with a partial projection (e.g. tests, the ticket-form glance) still
 * work; the store's `Stage` satisfies it.
 */
export interface StepperStageRow {
  stageKey: StageKey;
  status: StageStatus;
  verdict?: string | null;
  artifactPath?: string | null;
  startedAt?: string | null;
  endedAt?: string | null;
  attempt?: number;
  blockedKind?: BlockerKind | null;
  blockedReason?: string | null;
  blockedAt?: string | null;
}

/** Drop a nullish value so it never lands in the cell as an explicit null. */
function detail<T>(key: string, value: T | null | undefined): Record<string, T> {
  return value === null || value === undefined ? {} : { [key]: value };
}

/**
 * `verdict`/`blockedReason` are untrusted CLI/git prose (e.g. raw `git
 * status` stderr, `workflow/gates/targets.ts`) — unbounded, possibly
 * multi-line, and this is the ONE place both reach the cell that every
 * rendered surface (fault card, blocked banner, Inside op row) reads from.
 * Collapsed to one line and capped here, not per-surface, so no renderer can
 * forget to.
 */
function collapsedReason(value: string | null | undefined): string | null | undefined {
  return value == null ? value : collapseDiagnostic(value);
}

/**
 * The stage's block, or nothing. Keyed off `blockedKind` alone — a park always
 * writes all three fields in one transaction (`parkGateStage`), so a present
 * kind with an absent reason/at would mean the store lied, not that there is
 * partial information to show.
 */
function blockedDetail(row?: StepperStageRow): Record<'blocked', StepperCell['blocked']> | Record<string, never> {
  if (!row?.blockedKind) return {};
  return {
    blocked: {
      kind: row.blockedKind,
      reason: collapseDiagnostic(row.blockedReason ?? ''),
      at: row.blockedAt ?? '',
    },
  };
}

/**
 * Project a ticket's stage rows onto the canonical, stable stepper order
 * (`STAGE_KEYS`, not stage-row insertion order). A stage with no row yet reads
 * as `pending` — the pre-run default — so the stepper is complete on every
 * ticket regardless of how many stages have actually started.
 */
export function buildStepper(stages: readonly StepperStageRow[]): StepperCell[] {
  const byKey = new Map(stages.map((s) => [s.stageKey, s]));
  return STAGE_KEYS.map((stageKey) => {
    const row = byKey.get(stageKey);
    return {
      stageKey,
      status: row?.status ?? 'pending',
      ...detail('reason', collapsedReason(row?.verdict)),
      ...detail('artifactPath', row?.artifactPath),
      ...detail('startedAt', row?.startedAt),
      ...detail('endedAt', row?.endedAt),
      ...detail('attempt', row?.attempt),
      ...blockedDetail(row),
    };
  });
}
