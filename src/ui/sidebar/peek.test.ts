import { describe, it, expect } from 'vitest';
import { buildPeek, type PeekInput } from './peek.js';
import type { Stage } from '../../store/stages.js';
import type { GateRun } from '../../store/gateRuns.js';
import type { SessionAction } from '../../agent/sessionAction.js';

function stage(over: Partial<Stage> = {}): Stage {
  return {
    ticketId: 1,
    stageKey: 'impl',
    status: 'running',
    attempt: 0,
    verdict: null,
    artifactPath: null,
    startedAt: null,
    endedAt: null,
    blockedKind: null,
    blockedReason: null,
    blockedAt: null,
    ...over,
  };
}

const SESSION: SessionAction = { kind: 'start', label: 'Start', detail: 'fresh session' };
const SESS_OPEN: SessionAction = { kind: 'open', label: 'Open', detail: 'session is live · jump to terminal' };
const SESS_CONT: SessionAction = { kind: 'continue', label: 'Continue', detail: 'resume impl' };
const SESS_RESUME: SessionAction = { kind: 'resume', label: 'Resume', detail: 'picks up at uat' };

function input(over: Partial<PeekInput> = {}): PeekInput {
  return {
    stageCurrent: 'scope',
    current: null,
    agentState: null,
    sessionAction: SESSION,
    worktrees: [],
    servers: [],
    gateRuns: [],
    mergeGate: null,
    provider: null,
    model: null,
    prs: [],
    ...over,
  };
}

function gateRun(over: Partial<GateRun> = {}): GateRun {
  return {
    id: 1,
    ticketId: 1,
    stageKey: 'uat',
    attempt: 0,
    runAt: '2026-08-12T10:00:00Z',
    gateName: 'test (api)',
    exitCode: 0,
    startedAt: null,
    endedAt: null,
    repo: null,
    command: null,
    args: null,
    skipped: false,
    stageRunId: null,
    summary: null,
    ...over,
  };
}

describe('buildPeek — the expanded mini-dashboard summary', () => {
  it('a live agent is the strongest signal, whatever the stage', () => {
    expect(
      buildPeek(input({ stageCurrent: 'impl', agentState: 'running', sessionAction: SESS_OPEN })),
    ).toEqual({
      title: 'Agent running',
      detail: 'session is live · jump to terminal',
      next: { kind: 'open-session', label: 'Open session' },
      agent: null,
    });
  });

  it('names the working agent core and model on the live readings', () => {
    const peek = buildPeek(
      input({
        stageCurrent: 'impl',
        agentState: 'running',
        sessionAction: SESS_OPEN,
        provider: 'opencode',
        model: 'opencode-go/deepseek-v4-flash',
      }),
    );
    expect(peek.agent).toEqual({ provider: 'opencode', model: 'opencode-go/deepseek-v4-flash' });
  });

  it('a waiting agent reads as needs-you with the continue verb', () => {
    expect(
      buildPeek(input({ stageCurrent: 'impl', agentState: 'waiting', sessionAction: SESS_CONT })),
    ).toEqual({
      title: 'Agent waiting for input',
      detail: 'resume impl',
      next: { kind: 'open-session', label: 'Continue session' },
      agent: null,
    });
  });

  it('a ship that is RUNNING never reads its leftover waiting as needs-you', () => {
    // `waiting` during a running ship is the driver's own headless work — the
    // peek must not claim "Agent waiting for input".
    expect(
      buildPeek(
        input({
          stageCurrent: 'ship',
          agentState: 'waiting',
          current: stage({ stageKey: 'ship', status: 'running' }),
          mergeGate: { kind: 'nothing-to-merge' },
        }),
      ).title,
    ).toBe('Ready to ship');
  });

  it('a done ticket stays compact and offers the follow-up as its primary action', () => {
    expect(
      buildPeek(input({ stageCurrent: 'done', current: stage({ stageKey: 'done', status: 'passed' }) })),
    ).toEqual({
      title: 'Shipped',
      detail: null,
      next: { kind: 'create-follow-up', label: 'Create follow-up' },
    });
  });

  it('a conflicted ship names the conflict and offers Resolve conflicts for the first repo', () => {
    expect(
      buildPeek(
        input({
          stageCurrent: 'ship',
          current: stage({ stageKey: 'ship', status: 'passed' }),
          mergeGate: { kind: 'conflicted', repos: ['api', 'web'], pending: [] },
        }),
      ),
    ).toEqual({
      title: '2 merge conflicts in api, web',
      detail: null,
      next: { kind: 'resolve-conflicts', label: 'Resolve conflicts', repo: 'api' },
      repos: [
        { repo: 'api', number: null, state: 'conflict' },
        { repo: 'web', number: null, state: 'conflict' },
      ],
    });
  });

  it('a conflicted ship lists conflicted repos first, then ready-pending ones, with PR numbers', () => {
    expect(
      buildPeek(
        input({
          stageCurrent: 'ship',
          current: stage({ stageKey: 'ship', status: 'passed' }),
          mergeGate: { kind: 'conflicted', repos: ['web'], pending: ['api'] },
          prs: [
            { repo: 'web', number: 413, status: 'open' },
            { repo: 'api', number: 412, status: 'open' },
          ],
        }),
      ).repos,
    ).toEqual([
      { repo: 'web', number: 413, state: 'conflict' },
      { repo: 'api', number: 412, state: 'ready' },
    ]);
  });

  it('a ship waiting on its PRs states how many are unmerged', () => {
    expect(
      buildPeek(
        input({
          stageCurrent: 'ship',
          current: stage({ stageKey: 'ship', status: 'passed' }),
          mergeGate: { kind: 'awaiting', repos: ['web'] },
        }),
      ),
    ).toEqual({
      title: '1 pull request awaiting merge',
      detail: 'web',
      next: null,
      repos: [{ repo: 'web', number: null, state: 'ready' }],
    });
  });

  it('an awaiting ship drops merged PR rows and keeps the current number per repo', () => {
    expect(
      buildPeek(
        input({
          stageCurrent: 'ship',
          current: stage({ stageKey: 'ship', status: 'passed' }),
          mergeGate: { kind: 'awaiting', repos: ['api', 'web'] },
          prs: [
            { repo: 'api', number: 410, status: 'merged' },
            { repo: 'api', number: 412, status: 'open' },
            { repo: 'web', number: 413, status: 'open' },
          ],
        }),
      ).repos,
    ).toEqual([
      { repo: 'api', number: 412, state: 'ready' },
      { repo: 'web', number: 413, state: 'ready' },
    ]);
  });

  it('a freshly-parked ship (no PR yet) reads as ready to confirm', () => {
    expect(
      buildPeek(
        input({
          stageCurrent: 'ship',
          current: stage({ stageKey: 'ship', status: 'pending' }),
          mergeGate: { kind: 'nothing-to-merge' },
        }),
      ).title,
    ).toBe('Ready to ship');
  });

  it('a failed ship names the verdict reason', () => {
    expect(
      buildPeek(
        input({
          stageCurrent: 'ship',
          current: stage({ stageKey: 'ship', status: 'failed', verdict: 'push refused' }),
          mergeGate: null,
        }),
      ),
    ).toEqual({ title: 'Ship failed', detail: 'push refused', next: null });
  });

  it('a running gate stage shows its gate progress, never a session line', () => {
    const runs = [
      gateRun({ gateName: 'lint', exitCode: 0 }),
      gateRun({ id: 2, gateName: 'test', exitCode: 1 }),
    ];
    expect(
      buildPeek(
        input({
          stageCurrent: 'uat',
          current: stage({ stageKey: 'uat', status: 'running' }),
          sessionAction: SESS_RESUME,
          gateRuns: runs,
        }),
      ),
    ).toEqual({
      title: 'UAT running',
      detail: '1/2 gates passed',
      next: null,
      agent: null,
      progress: { passed: 1, total: 2 },
    });
  });

  it('a running gate names the executing core when one is configured', () => {
    const runs = [gateRun({ gateName: 'test', exitCode: 0 })];
    expect(
      buildPeek(
        input({
          stageCurrent: 'review',
          current: stage({ stageKey: 'review', status: 'running' }),
          gateRuns: runs,
          provider: 'claude',
          model: 'opus-4.1',
        }),
      ).agent,
    ).toEqual({ provider: 'claude', model: 'opus-4.1' });
  });

  it('a running gate with no recorded rows yet has no progress bar to draw', () => {
    expect(
      buildPeek(
        input({
          stageCurrent: 'review',
          current: stage({ stageKey: 'review', status: 'running' }),
          gateRuns: [],
        }),
      ).progress,
    ).toBeNull();
  });

  it('a running gate stage with no recorded rows yet says the gates are resolving', () => {
    expect(
      buildPeek(
        input({
          stageCurrent: 'review',
          current: stage({ stageKey: 'review', status: 'running' }),
          gateRuns: [],
        }),
      ).detail,
    ).toBe('gates resolving per repository');
  });

  it('a failed gate names the failing gate and the attempt, and offers Resume', () => {
    const runs = [gateRun({ gateName: 'test (api)', exitCode: 1 })];
    expect(
      buildPeek(
        input({
          stageCurrent: 'uat',
          current: stage({ stageKey: 'uat', status: 'failed', attempt: 2 }),
          sessionAction: SESS_RESUME,
          gateRuns: runs,
        }),
      ),
    ).toEqual({
      title: 'UAT failed',
      detail: 'attempt 2 · test',
      next: { kind: 'open-session', label: 'Resume session' },
    });
  });

  it('a passed gate stage reads as passed with the recorded count', () => {
    const runs = [
      gateRun({ stageKey: 'review', gateName: 'test', exitCode: 0 }),
      gateRun({ id: 2, stageKey: 'review', gateName: 'lint', exitCode: 0 }),
    ];
    expect(
      buildPeek(
        input({
          stageCurrent: 'review',
          current: stage({ stageKey: 'review', status: 'passed' }),
          gateRuns: runs,
        }),
      ),
    ).toEqual({
      title: 'Review passed',
      detail: '2/2 gates passed',
      next: null,
    });
  });

  it('a skipped gate never reads as a pass — it is left out of the count', () => {
    const runs = [gateRun({ gateName: 'test', exitCode: 0 }), gateRun({ id: 2, gateName: 'lint', exitCode: null, skipped: true })];
    expect(
      buildPeek(
        input({
          stageCurrent: 'uat',
          current: stage({ stageKey: 'uat', status: 'running' }),
          gateRuns: runs,
        }),
      ).detail,
    ).toBe('1/2 gates passed');
  });

  it('impl with no live session reads as a plain session state with the start verb', () => {
    expect(
      buildPeek(input({ stageCurrent: 'impl', agentState: 'none' })),
    ).toEqual({
      title: 'No active session',
      detail: 'fresh session',
      next: { kind: 'open-session', label: 'Start session' },
      agent: null,
    });
  });

  it('impl names its configured core even with no live session', () => {
    expect(
      buildPeek(input({ stageCurrent: 'impl', agentState: 'none', provider: 'codex', model: 'gpt-5.6' }))
        .agent,
    ).toEqual({ provider: 'codex', model: 'gpt-5.6' });
  });

  it('impl with an idle session reads Session idle', () => {
    expect(
      buildPeek(input({ stageCurrent: 'impl', agentState: 'idle' })).title,
    ).toBe('Session idle');
  });

  it('an unscoped ticket reads Not scoped yet with the start action', () => {
    expect(
      buildPeek(input({ stageCurrent: 'scope', worktrees: [] })),
    ).toEqual({
      title: 'Not scoped yet',
      detail: 'fresh session',
      next: { kind: 'open-session', label: 'Start session' },
    });
  });

  it('a scoped ticket with running servers names the count', () => {
    expect(
      buildPeek(
        input({
          stageCurrent: 'scope',
          worktrees: [{ repo: 'api' }, { repo: 'web' }],
          servers: [{ status: 'running' }, { status: 'running' }],
        }),
      ).title,
    ).toBe('2 servers running');
  });

  it('a scoped ticket with nothing running reads ready to work', () => {
    expect(
      buildPeek(
        input({
          stageCurrent: 'scope',
          worktrees: [{ repo: 'api' }],
          servers: [{ status: 'stopped' }],
        }),
      ).title,
    ).toBe('Scoped — ready to work');
  });
});
