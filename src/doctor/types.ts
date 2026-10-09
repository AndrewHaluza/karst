/**
 * Shared shapes for `karst doctor`. Every check is a pure function over
 * injected probes and returns plain data; nothing here touches the machine.
 * A fix is DATA too: only `tier: 'auto'` fixes carry an `action`, and only the
 * executor in `applyFixes.ts` ever acts on one — a consented or report-only
 * fix cannot be applied by construction (it has nothing executable).
 */

export type DoctorArea = 'tools' | 'manifest' | 'state' | 'wiring';
export type DoctorStatus = 'ok' | 'warn' | 'fail';

export const DOCTOR_AREAS: readonly DoctorArea[] = ['tools', 'manifest', 'state', 'wiring'];

/** Karst-owned state doctor may repair itself, provable from the DB. */
export type AutoFixAction =
  | { kind: 'mark-server-stopped'; serverId: number; pid: number | null }
  | {
      kind: 'kill-process';
      serverId: number;
      pid: number;
      /** `servers.started_at` (ISO or SQLite datetime, UTC) — the pid-reuse guard. */
      startedAt: string;
    }
  | {
      kind: 'prune-worktree';
      ticketId: number;
      repo: string;
      path: string;
      branch: string | null;
    }
  | { kind: 'quarantine-outbox'; path: string }
  | { kind: 'recreate-launcher' };

export type DoctorFix =
  /** Applied by `--fix` / "Fix safe issues". */
  | { tier: 'auto'; summary: string; action: AutoFixAction }
  /** Touches user repos / manifest / global config / installs: proposal or exact command, never applied. */
  | { tier: 'consented'; summary: string; command: string }
  /** Doctor cannot fix it safely; `nextStep` is the exact thing the user does. */
  | { tier: 'report'; summary: string; nextStep: string };

export interface DoctorCheck {
  /** Stable, dotted id, e.g. `tools.git`, `state.server-dead.12`. */
  id: string;
  area: DoctorArea;
  status: DoctorStatus;
  detail: string;
  fix?: DoctorFix;
}

/** One fix doctor applied (or tried to): what, why, evidence. */
export interface AppliedFix {
  checkId: string;
  what: string;
  why: string;
  evidence: string;
  ok: boolean;
}

export interface DoctorReport {
  /** Areas that were run. */
  areas: DoctorArea[];
  /** True when `--fix` was requested (otherwise the run made no writes). */
  fixRequested: boolean;
  /** Checks as they stand AFTER fixes (re-run when anything was applied). */
  checks: DoctorCheck[];
  applied: AppliedFix[];
  summary: { ok: number; warn: number; fail: number };
  /** 1 when any check is `fail` after fixes, else 0. */
  exitCode: 0 | 1;
}
