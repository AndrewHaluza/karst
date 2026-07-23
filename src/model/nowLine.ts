import { FIX_ATTEMPT_CAP } from '../workflow/fixAttempts.js';
import type { SessionAction } from '../agent/sessionAction.js';
import type { StepperCell } from './stepper.js';

/**
 * The one thing the user can do about the current stage. Rendered as a button
 * beside the "Now" line; `open-log` carries the path the host should open.
 * `session` is the returning-user continue-or-start entry point (its label
 * already carries the verb).
 */
export type NowAction =
  | { kind: 'open-log'; label: string; path: string }
  | { kind: 'ship'; label: string }
  | { kind: 'resume'; label: string }
  | { kind: 'session'; label: string };

/** A plain sentence naming what is happening, plus the next action (if any). */
export interface NowLine {
  text: string;
  action?: NowAction;
}

const GATE_LABEL: Partial<Record<StepperCell['stageKey'], string>> = {
  uat: 'UAT',
  review: 'review',
};

/** The failed-gate line: always explain, offer the log only when one exists. */
function gateFailed(cell: StepperCell): NowLine {
  const label = GATE_LABEL[cell.stageKey] ?? cell.stageKey;
  const text = `Now: the ${label} gate failed. Open the log to see which checks broke.`;
  return cell.artifactPath
    ? { text, action: { kind: 'open-log', label: 'Open log', path: cell.artifactPath } }
    : { text };
}

function fixing(attempts: number): NowLine {
  if (attempts >= FIX_ATTEMPT_CAP) {
    return {
      text: `Now: fix attempts ran out after ${FIX_ATTEMPT_CAP} tries. Resume the agent to try again.`,
      action: { kind: 'resume', label: 'Resume agent' },
    };
  }
  return {
    text: attempts > 0
      ? `Now: fixing the failed gate — the agent is resumed (attempt ${attempts} of ${FIX_ATTEMPT_CAP}).`
      : 'Now: fixing the failed gate — the agent is resumed.',
  };
}

/**
 * Turn the ticket's current stage into one plain, active-voice sentence naming
 * what is happening and what the user can do next — the dashboard's answer to
 * "why is this stuck?", which previously lived only in the dev output channel.
 *
 * Pure so the copy is unit-tested and ships inside `DashboardState`: the webview
 * is standalone HTML and cannot import this module, so it must not re-derive the
 * wording itself.
 *
 * `fixAttempts` is how many times a gate has already failed (`countFixAttempts`)
 * — the fix stage's own `attempt` is always 0, so the caller must supply it.
 */
export function buildNowLine(
  cell: StepperCell | null,
  ctx: { fixAttempts?: number; sessionAction?: SessionAction } = {},
): NowLine {
  // The returning-user entry point (§ start/continue): the verb rides on the
  // label ("Start session" / "Continue session"). Attached ONLY to the states
  // where launching is the user's move — never over a stage that owns its own
  // action (a failed gate's log, ship's confirm/retry, fix's manual resume).
  const session: NowAction | undefined = ctx.sessionAction
    ? { kind: 'session', label: `${ctx.sessionAction.label} session` }
    : undefined;
  const NOT_STARTED = 'Now: not started. Launch a session to begin.';

  if (!cell) return session ? { text: NOT_STARTED, action: session } : { text: NOT_STARTED };

  switch (cell.stageKey) {
    case 'scope':
      // A ticket saved without a run (§ save-without-run) sits here at
      // `pending` forever until startTicket runs — reuse the same "not
      // started" copy the null-cell (§ no stage row at all) case uses, so the
      // dashboard never claims an agent is active when nothing was launched.
      if (cell.status === 'pending') {
        return session ? { text: NOT_STARTED, action: session } : { text: NOT_STARTED };
      }
      return { text: 'Now: scoping the ticket — the agent is gathering context.' };
    case 'impl': {
      // Impl is interactive and can be interrupted — offer the continue-or-start
      // button so a returning user resumes without hunting the sidebar.
      const text = 'Now: implementing — the agent is working in its terminal.';
      return session ? { text, action: session } : { text };
    }
    case 'uat':
      return cell.status === 'failed'
        ? gateFailed(cell)
        : { text: 'Now: running the UAT gate — tests in the ticket’s worktree.' };
    case 'review':
      return cell.status === 'failed'
        ? gateFailed(cell)
        : { text: 'Now: running the review gate — lint, typecheck and tests.' };
    case 'fix':
      return fixing(ctx.fixAttempts ?? 0);
    case 'ship':
      // Ship has no failed edge (graph.ts): a ship that could not open its PRs
      // leaves the ticket parked right here, so the line has to say so and offer
      // the retry — the same action, renamed for what it now does.
      if (cell.status === 'failed') {
        return {
          text: 'Now: ship failed — the PRs were not opened. Check the reason above, then try again.',
          action: { kind: 'ship', label: 'Retry ship' },
        };
      }
      // Running: the confirm click already happened — no button, and no more
      // free-text step narration here. The real per-step progress lives in the
      // Inside block; this line just says what phase the ticket is in.
      if (cell.status === 'running') {
        return { text: 'Now: shipping — committing, pushing, and opening PRs for each hot repo.' };
      }
      return { text: 'Now: ready to ship. Confirm to open the PRs.', action: { kind: 'ship', label: 'Confirm ship' } };
    case 'done':
      return { text: 'Done.' };
  }
}
