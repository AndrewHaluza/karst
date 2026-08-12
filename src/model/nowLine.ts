import { FIX_ATTEMPT_CAP } from '../workflow/fixAttempts.js';
import type { MergeGateState } from '../workflow/mergeGate.js';
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
  | { kind: 'session'; label: string; detail: string };

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

function fixing(cell: StepperCell, attempts: number, sessionAction?: SessionAction): NowLine {
  if (attempts >= FIX_ATTEMPT_CAP) {
    return {
      text: `Now: fix attempts ran out after ${FIX_ATTEMPT_CAP} tries. Resume the agent to try again.`,
      action: { kind: 'resume', label: 'Resume agent' },
    };
  }
  if (sessionAction?.kind === 'open') {
    const action: NowAction = {
      kind: 'session',
      label: `${sessionAction.label} session`,
      detail: sessionAction.detail,
    };
    return {
      text: attempts > 0
        ? `Now: fixing the failed gate — the agent is running (attempt ${attempts} of ${FIX_ATTEMPT_CAP}).`
        : 'Now: fixing the failed gate — the agent is running.',
      action,
    };
  }
  // A PARKED fix row (`failed` — the execution ended without the done marker,
  // or the budget never started): the agent is NOT fixing, and the sentence
  // must not claim it is. The previous copy ("the agent is resumed") was the
  // lie this replaces — a ticket resting at fix for a human read as actively
  // worked, forever.
  if (cell.status === 'failed') {
    if (sessionAction) {
      const action: NowAction = {
        kind: 'session',
        label: `${sessionAction.label} session`,
        detail: sessionAction.detail,
      };
      return {
        text: `Now: the fix did not complete. ${sessionAction.label} the agent to retry.`,
        action,
      };
    }
    return { text: 'Now: the fix did not complete — it is parked for you to retry.' };
  }
  if (sessionAction) {
    const action: NowAction = {
      kind: 'session',
      label: `${sessionAction.label} session`,
      detail: sessionAction.detail,
    };
    return {
      text: `Now: the fix is paused after gate failure. ${sessionAction.label} the agent to retry.`,
      action,
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
/**
 * The line for a `ship` blocked on the merge gate (`awaiting-merge`). The stage
 * row itself carries nothing to say here — its verdict is cleared by
 * `entryPatch`/`transition` rules, and a stale one beside a `passed` status
 * would read as a contradiction — so the wording comes from the gate's read of
 * the PR rows and the merge checks, which are the current state of the thing
 * being waited on.
 *
 * No action: merging and resolving are BOTH per-repo, and the buttons that do
 * them already sit on the PR rows just below. A single button here would have to
 * pick a repo on the user's behalf for an irreversible operation.
 */
function merging(state: MergeGateState | undefined): NowLine {
  const count = (repos: readonly string[]): string =>
    `${repos.length} ${repos.length === 1 ? 'repo' : 'repos'}`;

  if (!state) return { text: 'Now: waiting for the pull requests to be merged.' };
  switch (state.kind) {
    case 'conflicted': {
      const rest = state.pending.length
        ? ` ${count(state.pending)} still ${state.pending.length === 1 ? 'needs' : 'need'} merging after that.`
        : '';
      return {
        text: `Now: ${count(state.repos)} no longer ${
          state.repos.length === 1 ? 'merges' : 'merge'
        } cleanly into the base. Resolve the conflicts below, then merge.${rest}`,
      };
    }
    case 'awaiting':
      return {
        text: `Now: shipped — waiting on ${count(state.repos)} to be merged. Merge below to finish the ticket.`,
      };
    // Both landed states mean the gate is about to advance the ticket (or already
    // has, and this snapshot predates it). Say the truthful in-between thing
    // rather than claiming it is still waiting on someone.
    case 'merged':
    case 'nothing-to-merge':
      return { text: 'Now: everything is merged — finishing up.' };
  }
}

export function buildNowLine(
  cell: StepperCell | null,
  ctx: {
    fixAttempts?: number;
    sessionAction?: SessionAction;
    /** The merge gate's current read — supplied only when it has been asked. */
    mergeGate?: MergeGateState;
    /**
     * The live agent asked a question or permission (`agentState ===
     * 'waiting'`). The ticket is blocked on the user RIGHT NOW, so the sentence
     * must say so — claiming the agent is "running" beside an amber "Needs you"
     * rail is the contradiction this branch prevents. Mirrors `railNeeds`'
     * precedence: the live question outranks stage narration — except over a
     * RUNNING ship, where the hooks that set `waiting` fire inside ship's own
     * headless run and the line must keep saying it is shipping (869ed7bpd).
     */
    agentWaiting?: boolean;
    /**
     * A session is actively working the ticket (`agentState === 'running'`) —
     * the resolve-conflicts session on a ship waiting to land. The ticket reads
     * in progress, so the needs-you instruction copy ("Resolve the conflicts
     * below") must not keep telling the user to do what the agent is doing.
     */
    agentRunning?: boolean;
  } = {},
): NowLine {
  // The returning-user entry point (§ start/continue): the verb rides on the
  // label ("Start session" / "Continue session"). Attached ONLY to the states
  // where launching is the user's move — never over a stage that owns its own
  // action (a failed gate's log, ship's confirm/retry, fix's manual resume).
  const session: NowAction | undefined = ctx.sessionAction
    ? {
        kind: 'session',
        label: `${ctx.sessionAction.label} session`,
        detail: ctx.sessionAction.detail,
      }
    : undefined;
  const NOT_STARTED = 'Now: not started. Launch a session to begin.';

  if (!cell) return session ? { text: NOT_STARTED, action: session } : { text: NOT_STARTED };

  // A RUNNING ship is the exception to the waiting branch: ship is the driver's
  // own headless agent work (committing, pushing, opening PRs), and the hook
  // that set `waiting` fired inside that run — the waiting sentence would
  // contradict the shipping in progress (869ed7bpd).
  if (ctx.agentWaiting && !(cell.stageKey === 'ship' && cell.status === 'running')) {
    const line: NowLine = {
      text: 'Now: the agent is waiting — it asked for your input.',
    };
    if (session) line.action = session;
    return line;
  }

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
      return fixing(cell, ctx.fixAttempts ?? 0, ctx.sessionAction);
    case 'ship':
      // Ship has no failed edge (graph.ts): a ship that could not open its PRs
      // leaves the ticket parked right here, so the line has to say so and offer
      // the retry — the same action, renamed for what it now does. The recorded
      // reason (already collapsed/capped by the stepper) rides on the sentence
      // itself, so the copy never depends on a sibling surface rendering it —
      // the fault card still shows it large, with timing and attempt, but the
      // line alone carries the at-a-glance why (869eh44n5-fu1).
      if (cell.status === 'failed') {
        const why = cell.reason ? `: ${cell.reason}` : '';
        return {
          text: `Now: ship failed — the PRs were not opened${why}.`,
          action: { kind: 'ship', label: 'Retry ship' },
        };
      }
      // PRs are open but the entry gate into `done` (workflow/mergeGate.ts)
      // is holding: at least one still has to land.
      if (cell.blocked?.kind === 'awaiting-merge') {
        // The "Resolve conflicts" click opened a session: the user already
        // acted, so the instruction copy below is stale — say the agent is
        // doing the resolving, the same way the fix branch says the agent is
        // fixing. Once the session ends (idle) the instruction returns.
        if (ctx.agentRunning) {
          return { text: 'Now: resolving the merge conflict — the agent is running.' };
        }
        return merging(ctx.mergeGate);
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
