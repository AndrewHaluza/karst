import { describe, it, expect } from 'vitest';
import { buildNowLine } from './nowLine.js';
import type { StepperCell } from './stepper.js';

const cell = (over: Partial<StepperCell> & Pick<StepperCell, 'stageKey'>): StepperCell => ({
  status: 'running',
  ...over,
});

describe('buildNowLine', () => {
  it('names the agent terminal while impl runs', () => {
    expect(buildNowLine(cell({ stageKey: 'impl' }))).toEqual({
      text: 'Now: implementing — the agent is working in its terminal.',
    });
  });

  it('says not-started for a saved-but-never-run ticket (scope still pending)', () => {
    expect(buildNowLine(cell({ stageKey: 'scope', status: 'pending' }))).toEqual({
      text: 'Now: not started. Launch a session to begin.',
    });
  });

  it('still names live scoping once the scope stage is actually running', () => {
    expect(buildNowLine(cell({ stageKey: 'scope', status: 'running' }))).toEqual({
      text: 'Now: scoping the ticket — the agent is gathering context.',
    });
  });

  it('names the gate that is running', () => {
    expect(buildNowLine(cell({ stageKey: 'uat' })).text).toBe(
      'Now: running the UAT gate — tests in the ticket’s worktree.',
    );
    expect(buildNowLine(cell({ stageKey: 'review' })).text).toBe(
      'Now: running the review gate — lint, typecheck and tests.',
    );
  });

  it('offers the log on a failed gate', () => {
    expect(
      buildNowLine(
        cell({ stageKey: 'review', status: 'failed', artifactPath: '/logs/review-ticket-3.log' }),
      ),
    ).toEqual({
      text: 'Now: the review gate failed. Open the log to see which checks broke.',
      action: { kind: 'open-log', label: 'Open log', path: '/logs/review-ticket-3.log' },
    });
  });

  it('drops the log action when the failed stage wrote no log', () => {
    const line = buildNowLine(cell({ stageKey: 'uat', status: 'failed' }));
    expect(line.text).toBe('Now: the UAT gate failed. Open the log to see which checks broke.');
    expect(line.action).toBeUndefined();
  });

  it('counts fix attempts against the cap', () => {
    // The count comes from the gates' failures (countFixAttempts), never from the
    // fix stage's own attempt — the machine leaves that at 0.
    expect(buildNowLine(cell({ stageKey: 'fix' }), { fixAttempts: 2 }).text).toBe(
      'Now: fixing the failed gate — the agent is resumed (attempt 2 of 3).',
    );
    expect(buildNowLine(cell({ stageKey: 'fix' })).text).toBe(
      'Now: fixing the failed gate — the agent is resumed.',
    );
  });

  it('offers recovery instead of claiming an interrupted fix is still running', () => {
    expect(
      buildNowLine(cell({ stageKey: 'fix' }), {
        fixAttempts: 1,
        sessionAction: { kind: 'continue', label: 'Continue', detail: 'resume fix' },
      }),
    ).toEqual({
      text: 'Now: the fix is paused after gate failure. Continue the agent to retry.',
      action: { kind: 'session', label: 'Continue session', detail: 'resume fix' },
    });
  });

  it('keeps a live fix actionable by opening its session', () => {
    expect(
      buildNowLine(cell({ stageKey: 'fix' }), {
        fixAttempts: 1,
        sessionAction: {
          kind: 'open',
          label: 'Open',
          detail: 'session is live · jump to terminal',
        },
      }),
    ).toEqual({
      text: 'Now: fixing the failed gate — the agent is running (attempt 1 of 3).',
      action: {
        kind: 'session',
        label: 'Open session',
        detail: 'session is live · jump to terminal',
      },
    });
  });

  it('says fix attempts ran out at the cap, and offers a manual resume', () => {
    expect(buildNowLine(cell({ stageKey: 'fix' }), { fixAttempts: 3 })).toEqual({
      text: 'Now: fix attempts ran out after 3 tries. Resume the agent to try again.',
      action: { kind: 'resume', label: 'Resume agent' },
    });
  });

  it('says the fix did not complete for a PARKED fix row — never that the agent is fixing', () => {
    // A parked fix row: the execution ended without the done marker (or never
    // started), and the ticket rests at fix for a human. The old copy claimed
    // "the agent is resumed" beside a dead fix forever.
    expect(
      buildNowLine(cell({ stageKey: 'fix', status: 'failed' }), {
        fixAttempts: 1,
        sessionAction: { kind: 'continue', label: 'Continue', detail: 'resume fix' },
      }),
    ).toEqual({
      text: 'Now: the fix did not complete. Continue the agent to retry.',
      action: { kind: 'session', label: 'Continue session', detail: 'resume fix' },
    });
    expect(
      buildNowLine(cell({ stageKey: 'fix', status: 'failed' }), {
        fixAttempts: 1,
        sessionAction: { kind: 'start', label: 'Start', detail: 're-seed from context' },
      }),
    ).toEqual({
      text: 'Now: the fix did not complete. Start the agent to retry.',
      action: { kind: 'session', label: 'Start session', detail: 're-seed from context' },
    });
  });

  it('keeps the exhausted copy for a parked fix at the cap, whatever the row says', () => {
    expect(buildNowLine(cell({ stageKey: 'fix', status: 'failed' }), { fixAttempts: 3 })).toEqual({
      text: 'Now: fix attempts ran out after 3 tries. Resume the agent to try again.',
      action: { kind: 'resume', label: 'Resume agent' },
    });
  });

  it('offers ship confirmation at the ship boundary', () => {
    // `needsConfirm` (machine.ts) parks a stage requiring confirmation at
    // `pending`, not `running`, until the user clicks — real machine behavior.
    expect(buildNowLine(cell({ stageKey: 'ship', status: 'pending' }))).toEqual({
      text: 'Now: ready to ship. Confirm to open the PRs.',
      action: { kind: 'ship', label: 'Confirm ship' },
    });
  });

  it('names live shipping once confirmed, with no button — the click already happened', () => {
    // The old free-text overlay used to hijack this line entirely; the real
    // per-step progress now lives in the Inside block instead, so this is a
    // static sentence, never a spinner label.
    expect(buildNowLine(cell({ stageKey: 'ship', status: 'running' }))).toEqual({
      text: 'Now: shipping — committing, pushing, and opening PRs for each hot repo.',
    });
  });

  it('keeps saying it is shipping when the agent state reads waiting during the run', () => {
    // The hooks that set 'waiting' fire inside ship's own headless run, so the
    // waiting sentence would contradict the shipping in progress (869ed7bpd).
    expect(
      buildNowLine(cell({ stageKey: 'ship', status: 'running' }), { agentWaiting: true }),
    ).toEqual({
      text: 'Now: shipping — committing, pushing, and opening PRs for each hot repo.',
    });
  });

  it('says the PRs did not open when ship failed, and offers a retry', () => {
    // Ship has no failed edge, so the ticket parks here. Without this the user saw
    // a ticket sitting at ship with the gh error only in the output channel.
    expect(buildNowLine(cell({ stageKey: 'ship', status: 'failed' }))).toEqual({
      text: 'Now: ship failed — the PRs were not opened. Check the reason above, then try again.',
      action: { kind: 'ship', label: 'Retry ship' },
    });
  });

  it('closes out at done', () => {
    expect(buildNowLine(cell({ stageKey: 'done', status: 'passed' }))).toEqual({ text: 'Done.' });
  });

  it('invites a launch when nothing has started', () => {
    expect(buildNowLine(null)).toEqual({
      text: 'Now: not started. Launch a session to begin.',
    });
  });

  it('offers a discoverable Start button on a never-started ticket', () => {
    // Case (b)/(c): a returning user needs a visible action, not just prose.
    expect(buildNowLine(null, { sessionAction: { kind: 'start', label: 'Start', detail: 'fresh session' } })).toEqual({
      text: 'Now: not started. Launch a session to begin.',
      action: { kind: 'session', label: 'Start session', detail: 'fresh session' },
    });
    expect(
      buildNowLine(cell({ stageKey: 'scope', status: 'pending' }), {
        sessionAction: { kind: 'start', label: 'Start', detail: 'fresh session' },
      }).action,
    ).toEqual({ kind: 'session', label: 'Start session', detail: 'fresh session' });
  });

  it('offers a Continue button while impl is in progress', () => {
    // Case (a): mid-work, the dashboard must let the user resume in place.
    expect(
      buildNowLine(cell({ stageKey: 'impl' }), {
        sessionAction: { kind: 'continue', label: 'Continue', detail: 'resume impl' },
      }),
    ).toEqual({
      text: 'Now: implementing — the agent is working in its terminal.',
      action: { kind: 'session', label: 'Continue session', detail: 'resume impl' },
    });
  });

  it('says the agent is waiting when it asked for input — impl narration must not claim it is running', () => {
    // The agent stopped on a permission/question ask: the sentence beside the
    // amber rail must not contradict it by claiming the agent is working.
    expect(buildNowLine(cell({ stageKey: 'impl' }), { agentWaiting: true })).toEqual({
      text: 'Now: the agent is waiting — it asked for your input.',
    });
  });

  it('keeps the session button beside the waiting line', () => {
    expect(
      buildNowLine(cell({ stageKey: 'fix' }), {
        agentWaiting: true,
        sessionAction: { kind: 'open', label: 'Open', detail: 'session is live · jump to terminal' },
      }),
    ).toEqual({
      text: 'Now: the agent is waiting — it asked for your input.',
      action: { kind: 'session', label: 'Open session', detail: 'session is live · jump to terminal' },
    });
  });

  describe('ship blocked on the merge gate', () => {
    const merge = cell({
      stageKey: 'ship',
      status: 'passed',
      blocked: { kind: 'awaiting-merge', reason: '', at: '', resumable: false },
    });

    it('names how many repos are still to be merged', () => {
      expect(
        buildNowLine(merge, { mergeGate: { kind: 'awaiting', repos: ['api'] } }),
      ).toEqual({
        text: 'Now: shipped — waiting on 1 repo to be merged. Merge below to finish the ticket.',
      });
      expect(
        buildNowLine(merge, { mergeGate: { kind: 'awaiting', repos: ['api', 'web'] } }).text,
      ).toContain('waiting on 2 repos');
    });

    // The ticket's second ask: a conflict has to say so, in the same place the
    // user is already looking, rather than hiding in a PR row.
    it('says a branch no longer merges cleanly, and what else is left after it', () => {
      expect(
        buildNowLine(merge, {
          mergeGate: { kind: 'conflicted', repos: ['api'], pending: ['web'] },
        }),
      ).toEqual({
        text:
          'Now: 1 repo no longer merges cleanly into the base. Resolve the conflicts below, '
          + 'then merge. 1 repo still needs merging after that.',
      });
    });

    it('does not trail a count when the conflict is the only thing left', () => {
      expect(
        buildNowLine(merge, { mergeGate: { kind: 'conflicted', repos: ['api'], pending: [] } }).text,
      ).toBe('Now: 1 repo no longer merges cleanly into the base. Resolve the conflicts below, then merge.');
    });

    // Merging and resolving are both per-repo and both irreversible; a single
    // button here would have to pick a repo on the user's behalf.
    it('offers no action of its own, and no session button borrows the slot', () => {
      expect(
        buildNowLine(merge, {
          mergeGate: { kind: 'awaiting', repos: ['api'] },
          sessionAction: { kind: 'resume', label: 'Resume', detail: 'picks up at merge' },
        }).action,
      ).toBeUndefined();
    });

    // A gate nobody asked still has to produce a sentence — the panel renders
    // this line unconditionally.
    it('degrades to a plain waiting line when the gate was not read', () => {
      expect(buildNowLine(merge)).toEqual({
        text: 'Now: waiting for the pull requests to be merged.',
      });
    });
  });

  it('never lets the session button override a stage that owns its action', () => {
    // Ship keeps its own confirm/retry action even when a sessionAction is passed.
    expect(
      buildNowLine(cell({ stageKey: 'ship', status: 'pending' }), {
        sessionAction: { kind: 'start', label: 'Start', detail: 'fresh session' },
      }).action,
    ).toEqual({ kind: 'ship', label: 'Confirm ship' });
  });
});
