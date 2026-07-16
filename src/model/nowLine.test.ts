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
    expect(buildNowLine(cell({ stageKey: 'ship' }))).toEqual({
      text: 'Now: ready to ship. Confirm to open the PRs.',
      action: { kind: 'ship', label: 'Confirm ship' },
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
});
