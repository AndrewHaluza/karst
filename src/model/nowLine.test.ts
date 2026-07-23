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

  it('says fix attempts ran out at the cap, and offers a manual resume', () => {
    expect(buildNowLine(cell({ stageKey: 'fix' }), { fixAttempts: 3 })).toEqual({
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
    expect(buildNowLine(null, { sessionAction: { kind: 'start', label: 'Start' } })).toEqual({
      text: 'Now: not started. Launch a session to begin.',
      action: { kind: 'session', label: 'Start session' },
    });
    expect(
      buildNowLine(cell({ stageKey: 'scope', status: 'pending' }), {
        sessionAction: { kind: 'start', label: 'Start' },
      }).action,
    ).toEqual({ kind: 'session', label: 'Start session' });
  });

  it('offers a Continue button while impl is in progress', () => {
    // Case (a): mid-work, the dashboard must let the user resume in place.
    expect(
      buildNowLine(cell({ stageKey: 'impl' }), {
        sessionAction: { kind: 'continue', label: 'Continue' },
      }),
    ).toEqual({
      text: 'Now: implementing — the agent is working in its terminal.',
      action: { kind: 'session', label: 'Continue session' },
    });
  });

  it('never lets the session button override a stage that owns its action', () => {
    // Ship keeps its own confirm/retry action even when a sessionAction is passed.
    expect(
      buildNowLine(cell({ stageKey: 'ship', status: 'pending' }), {
        sessionAction: { kind: 'start', label: 'Start' },
      }).action,
    ).toEqual({ kind: 'ship', label: 'Confirm ship' });
  });
});
