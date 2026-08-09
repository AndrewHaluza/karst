import type { StageKey, AgentState } from '../model/types.js';
import type { AgentProvider } from '../manifest/types.js';
import { shouldResumeSession } from './resumeDecision.js';

/**
 * What the returning-user session entry point (sidebar button, dashboard Now
 * line) will DO when clicked, and the verb it reads. The set is honest about
 * which of several returning states the ticket is in — "Start" no longer
 * collapses a ticket full of work into a verb that reads like "wipe and restart".
 *
 * `continue` — resume the exact captured interactive session (§5.3).
 * `open`     — a session is already live; jump to its terminal.
 * `resume`   — parked at a gate/ship; open a fresh session that picks up there.
 * `reopen`   — shipped; open a follow-up session.
 * `start`    — no resumable work: a never-run draft, or an interactive stage
 *              with no captured id (re-seed from context).
 */
export type SessionActionKind = 'start' | 'continue' | 'open' | 'resume' | 'reopen';

export interface SessionAction {
  kind: SessionActionKind;
  /** The button verb — "Start" | "Continue" | "Open" | "Resume" | "Reopen". */
  label: string;
  /** Short subtitle: what the click does. Viewer-clock-free (no "2h ago"). */
  detail: string;
}

function act(kind: SessionActionKind, label: string, detail: string): SessionAction {
  return { kind, label, detail };
}

/**
 * Decide the entry-point verb + subtitle for a ticket. The `continue` branch
 * defers to `shouldResumeSession` — the same predicate `openSession` uses — so
 * the label's promise can never drift from the actual `--resume` decision; the
 * verb is a preview of it. That includes the provider check: a session minted by
 * a different core reads "Start", because offering "Continue" there would flash
 * a terminal that dies on an id the launching CLI cannot find.
 */
export function sessionAction(
  t: {
    sessionId: string | null;
    sessionProvider?: AgentProvider | null;
    stageCurrent: StageKey | string | null;
    agentState?: AgentState | string | null;
    selectedRepos?: readonly string[];
  },
  /**
   * The core this ticket would launch with. Omitted → the session's provider
   * cannot be checked, so a captured session is treated as unresumable and the
   * verb honestly reads "Start" rather than promising a Continue that dies.
   */
  provider?: AgentProvider,
): SessionAction {
  const stage = t.stageCurrent;

  // A live agent: the move is to jump to the running terminal, not re-launch.
  if (t.agentState === 'running') {
    return act('open', 'Open', 'session is live · jump to terminal');
  }

  // Interactive stages: resume the exact session, or re-seed if none was captured.
  if (stage === 'impl' || stage === 'fix') {
    const resumable =
      provider !== undefined &&
      shouldResumeSession({
        sessionId: t.sessionId,
        sessionProvider: t.sessionProvider ?? null,
        stageCurrent: stage,
        provider,
      });
    return resumable
      ? act('continue', 'Continue', `resume ${stage}`)
      : act('start', 'Start', 're-seed from context');
  }

  // Parked at a gate or ship (including ship blocked awaiting a merge): a fresh
  // session picks up where the ticket sits. Ship stays in this bucket rather
  // than `done`'s — a ticket blocked on a merge still has work in front of it
  // (a conflict to resolve, most often), and "Reopen · shipped" would claim an
  // outcome the ticket has not reached.
  if (stage === 'uat' || stage === 'review' || stage === 'ship') {
    return act('resume', 'Resume', `picks up at ${stage}`);
  }

  if (stage === 'done') {
    return act('reopen', 'Reopen', 'shipped · follow-up session');
  }

  // Draft (null) or scope: a fresh, self-scoping start. Name the repo count when
  // known so "Start" states what it will do.
  const n = t.selectedRepos?.length ?? 0;
  return act('start', 'Start', n > 0 ? `fresh · scopes ${n} repo${n === 1 ? '' : 's'}` : 'fresh session');
}
