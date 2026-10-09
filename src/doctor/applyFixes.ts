import type { AppliedFix, AutoFixAction, DoctorCheck } from './types.js';

/** SQLite `datetime('now')` is UTC without a zone marker; ISO strings pass through. */
export function parseDbTimeMs(value: string): number {
  const iso = /[zZ]|[+-]\d\d:?\d\d$/.test(value) ? value : `${value.replace(' ', 'T')}Z`;
  return Date.parse(iso);
}

/** Slack for the gap between spawn and the DB row's `started_at`. */
export const PID_REUSE_SKEW_MS = 5000;

/** Every side effect doctor may perform. Injected so a test can prove which ran. */
export interface FixEffects {
  markServerStopped: (serverId: number) => void;
  pidStartedAtMs: (pid: number) => number | undefined;
  killProcess: (pid: number) => void;
  worktreeState: (path: string) => 'clean' | 'dirty' | 'unknown';
  pruneWorktree: (a: Extract<AutoFixAction, { kind: 'prune-worktree' }>) => void;
  quarantineOutbox: (path: string) => void;
  recreateLauncher: () => void;
}

type Outcome = { what: string; why: string; evidence: string; ok: boolean };

function apply(action: AutoFixAction, fx: FixEffects): Outcome {
  switch (action.kind) {
    case 'mark-server-stopped':
      fx.markServerStopped(action.serverId);
      return {
        what: `marked server ${action.serverId} stopped`,
        why: 'recorded running but its process is gone',
        evidence: `pid ${action.pid ?? 'none'} not alive`,
        ok: true,
      };
    case 'kill-process': {
      // Re-verify at apply time: the pid may have been reused since the check ran.
      const started = fx.pidStartedAtMs(action.pid);
      const recorded = parseDbTimeMs(action.startedAt);
      const evidence = `pid ${action.pid} started ${started ?? 'unknown'}, recorded ${action.startedAt}`;
      if (started === undefined || Number.isNaN(recorded) || started > recorded + PID_REUSE_SKEW_MS) {
        return { what: `skipped kill of pid ${action.pid}`, why: 'start time does not match the record (pid reuse)', evidence, ok: false };
      }
      fx.killProcess(action.pid);
      return { what: `killed pid ${action.pid}`, why: 'leaked karst-spawned process after its ticket finished', evidence, ok: true };
    }
    case 'prune-worktree': {
      const state = fx.worktreeState(action.path);
      if (state !== 'clean') {
        return { what: `skipped prune of ${action.path}`, why: `worktree is ${state}`, evidence: action.path, ok: false };
      }
      fx.pruneWorktree(action);
      return { what: `pruned worktree ${action.path}`, why: 'ticket is done and the worktree is clean and pushed', evidence: `ticket ${action.ticketId}, branch ${action.branch ?? 'none'}`, ok: true };
    }
    case 'quarantine-outbox':
      fx.quarantineOutbox(action.path);
      return { what: `quarantined outbox file ${action.path}`, why: 'never ingested', evidence: action.path, ok: true };
    case 'recreate-launcher':
      fx.recreateLauncher();
      return { what: 'recreated launcher', why: 'launcher was missing', evidence: 'wiring check', ok: true };
  }
}

/**
 * Apply ONLY `tier: 'auto'` fixes. A consented or report fix has no `action`,
 * so there is nothing here that could run it. Destructive actions re-verify
 * their precondition immediately before acting. One failing fix never stops the rest.
 */
export function applyFixes(checks: readonly DoctorCheck[], fx: FixEffects): AppliedFix[] {
  const applied: AppliedFix[] = [];
  for (const c of checks) {
    if (c.fix?.tier !== 'auto') continue;
    try {
      applied.push({ checkId: c.id, ...apply(c.fix.action, fx) });
    } catch (e) {
      applied.push({
        checkId: c.id,
        what: c.fix.summary,
        why: 'fix threw',
        evidence: e instanceof Error ? e.message : String(e),
        ok: false,
      });
    }
  }
  return applied;
}
