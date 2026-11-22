import { describe, it, expect } from 'vitest';
import { buildPeek, type PeekInput } from './peek.js';
import type { Stage } from '../../store/stages.js';
import type { GateRun } from '../../store/gateRuns.js';
import type { SessionAction } from '../../agent/sessionAction.js';
import type { RailNeeds } from '../../model/railNeeds.js';

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
    paused: false,
    glyph: 'gray',
    needs: null,
    lastHookAt: null,
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

const NEEDS_SHIP: RailNeeds = { detail: 'ready to open the PRs', action: 'Confirm ship', cta: { kind: 'ship-confirm' } };

describe('buildPeek — state word, tone and age', () => {
  it('a live agent reads "Agent working" in the glyph tone', () => {
    const peek = buildPeek(input({ stageCurrent: 'impl', agentState: 'running', sessionAction: SESS_OPEN, glyph: 'blue' }));
    expect(peek.title).toBe('Agent working');
    expect(peek.tone).toBe('blue');
    expect(peek.next).toBeNull();
  });

  it('a waiting agent reads "Waiting for you"', () => {
    const peek = buildPeek(
      input({
        stageCurrent: 'impl',
        agentState: 'waiting',
        sessionAction: SESS_CONT,
        glyph: 'amber',
        needs: { detail: 'the agent asked you something', action: 'Open session', cta: { kind: 'open-session' } },
      }),
    );
    expect(peek.title).toBe('Waiting for you');
    expect(peek.needs?.cta).toEqual({ kind: 'open-session' });
  });

  it('a quota park (needs open-session, no agent state) reads "Waiting for you"', () => {
    const peek = buildPeek(
      input({
        stageCurrent: 'review',
        current: stage({ stageKey: 'review', status: 'failed' }),
        needs: { detail: 'the provider is out of quota', action: 'Open session', cta: { kind: 'open-session' } },
      }),
    );
    expect(peek.title).toBe('Waiting for you');
  });

  it('a graph wait reads "Waiting for you" and carries the graph-panel cta', () => {
    const peek = buildPeek(
      input({
        stageCurrent: 'impl',
        needs: { detail: 'the graph needs a recovery decision', action: 'Open graph', cta: { kind: 'graph-panel' } },
      }),
    );
    expect(peek.title).toBe('Waiting for you');
    expect(peek.needs?.cta.kind).toBe('graph-panel');
  });

  it('a running ship never reads its leftover waiting as needs-you', () => {
    const peek = buildPeek(
      input({
        stageCurrent: 'ship',
        agentState: 'waiting',
        current: stage({ stageKey: 'ship', status: 'running' }),
        mergeGate: { kind: 'nothing-to-merge' },
      }),
    );
    expect(peek.title).not.toBe('Waiting for you');
  });

  it('a paused ticket reads "Paused" with the resume note', () => {
    const peek = buildPeek(input({ stageCurrent: 'impl', paused: true, glyph: 'amber' }));
    expect(peek.title).toBe('Paused');
    expect(peek.pausedNote).toBe('No stage starts until you resume');
  });

  it('a live agent outranks a pause, but the note stays', () => {
    const peek = buildPeek(input({ stageCurrent: 'impl', agentState: 'running', paused: true }));
    expect(peek.title).toBe('Agent working');
    expect(peek.pausedNote).toBe('No stage starts until you resume');
  });

  it('an unpaused ticket has no paused note', () => {
    expect(buildPeek(input({ stageCurrent: 'impl' })).pausedNote).toBeNull();
  });

  it('a running stage ages from startedAt ("for")', () => {
    const peek = buildPeek(
      input({ stageCurrent: 'impl', current: stage({ status: 'running', startedAt: '2026-08-12T08:00:00Z' }) }),
    );
    expect(peek.since).toEqual({ at: '2026-08-12T08:00:00Z', kind: 'for' });
  });

  it('a finished stage ages from endedAt ("ago")', () => {
    const peek = buildPeek(
      input({
        stageCurrent: 'uat',
        current: stage({ stageKey: 'uat', status: 'failed', startedAt: '2026-08-12T08:00:00Z', endedAt: '2026-08-12T09:00:00Z' }),
      }),
    );
    expect(peek.since).toEqual({ at: '2026-08-12T09:00:00Z', kind: 'ago' });
  });

  it('a stage with no timestamps has no age', () => {
    expect(buildPeek(input({ stageCurrent: 'impl', current: stage() })).since).toBeNull();
  });

  it('shows the attempt only above one', () => {
    expect(buildPeek(input({ current: stage({ attempt: 1 }) })).attempt).toBeNull();
    expect(buildPeek(input({ current: stage({ attempt: 3 }) })).attempt).toBe(3);
  });
});

describe('buildPeek — gate facts', () => {
  it('a failed gate stage lists the passed count and the failed gate names', () => {
    const peek = buildPeek(
      input({
        stageCurrent: 'uat',
        current: stage({ stageKey: 'uat', status: 'failed', attempt: 2 }),
        glyph: 'red',
        gateRuns: [
          gateRun({ id: 1, gateName: 'build (api)' }),
          gateRun({ id: 2, gateName: 'types (api)' }),
          gateRun({ id: 3, gateName: 'docs (api)' }),
          gateRun({ id: 4, gateName: 'lint (api)', exitCode: 1 }),
          gateRun({ id: 5, gateName: 'test (api)', exitCode: 2 }),
        ],
      }),
    );
    expect(peek.title).toBe('UAT failed');
    expect(peek.gates).toEqual({ text: '3 passed · 2 failed: lint, test', tone: 'failed' });
  });

  it('a running gate stage counts running gates', () => {
    const peek = buildPeek(
      input({
        stageCurrent: 'uat',
        current: stage({ stageKey: 'uat', status: 'running' }),
        glyph: 'blue',
        gateRuns: [
          gateRun({ id: 1 }),
          gateRun({ id: 2, gateName: 'lint (api)' }),
          gateRun({ id: 3, gateName: 'a (api)' }),
          gateRun({ id: 4, gateName: 'b (api)', exitCode: null }),
          gateRun({ id: 5, gateName: 'c (api)', exitCode: null }),
        ],
      }),
    );
    expect(peek.title).toBe('Gates running');
    expect(peek.gates).toEqual({ text: '3 passed · 2 running', tone: 'running' });
  });

  it('a gate stage that has not recorded rows has no gate line', () => {
    const peek = buildPeek(input({ stageCurrent: 'uat', current: stage({ stageKey: 'uat', status: 'running' }) }));
    expect(peek.title).toBe('Gates running');
    expect(peek.gates).toBeNull();
  });

  it('reads only the latest batch of the current stage', () => {
    const peek = buildPeek(
      input({
        stageCurrent: 'uat',
        current: stage({ stageKey: 'uat', status: 'passed' }),
        gateRuns: [
          gateRun({ id: 1, runAt: '2026-08-12T09:00:00Z', exitCode: 1 }),
          gateRun({ id: 2, runAt: '2026-08-12T10:00:00Z' }),
          gateRun({ id: 3, stageKey: 'review', runAt: '2026-08-12T11:00:00Z', exitCode: 1 }),
        ],
      }),
    );
    expect(peek.gates).toEqual({ text: '1 passed', tone: 'ok' });
  });

  it('a skipped gate never counts as a pass', () => {
    const peek = buildPeek(
      input({
        stageCurrent: 'uat',
        current: stage({ stageKey: 'uat', status: 'passed' }),
        gateRuns: [gateRun({ id: 1 }), gateRun({ id: 2, skipped: true, exitCode: null })],
      }),
    );
    expect(peek.gates?.text).toBe('1 passed');
  });

  it('a failed stage with no gate rows shows its verdict as one red line', () => {
    const peek = buildPeek(
      input({
        stageCurrent: 'impl',
        current: stage({ status: 'failed', verdict: 'build broke\nsecond line' }),
        glyph: 'red',
      }),
    );
    expect(peek.title).toBe('Implementation failed');
    expect(peek.gates).toEqual({ text: 'build broke', tone: 'failed' });
  });

  it('a failed stage with neither rows nor verdict has no gate line', () => {
    const peek = buildPeek(input({ stageCurrent: 'impl', current: stage({ status: 'failed' }) }));
    expect(peek.gates).toBeNull();
  });
});

describe('buildPeek — ship family', () => {
  it('a freshly parked ship reads "Ready to ship" and carries the rail needs', () => {
    const peek = buildPeek(
      input({
        stageCurrent: 'ship',
        current: stage({ stageKey: 'ship', status: 'pending' }),
        mergeGate: { kind: 'nothing-to-merge' },
        needs: NEEDS_SHIP,
        glyph: 'amber',
      }),
    );
    expect(peek.title).toBe('Ready to ship');
    expect(peek.needs).toEqual(NEEDS_SHIP);
    expect(peek.repos).toBeNull();
  });

  it('a single repo awaiting merge lists its PR', () => {
    const peek = buildPeek(
      input({
        stageCurrent: 'ship',
        current: stage({ stageKey: 'ship', status: 'passed' }),
        mergeGate: { kind: 'awaiting', repos: ['karst'] },
        prs: [{ repo: 'karst', number: 1148, status: 'open' }],
        needs: { detail: '1 repo to merge', action: 'Merge', cta: { kind: 'merge', repo: 'karst' } },
      }),
    );
    expect(peek.title).toBe('Awaiting merge');
    expect(peek.repos).toEqual([{ repo: 'karst', number: 1148, state: 'ready' }]);
    expect(peek.needs?.cta).toEqual({ kind: 'merge', repo: 'karst' });
  });

  it('several repos awaiting merge list every PR and point at the merge panel', () => {
    const peek = buildPeek(
      input({
        stageCurrent: 'ship',
        current: stage({ stageKey: 'ship', status: 'passed' }),
        mergeGate: { kind: 'awaiting', repos: ['karst', 'karst-docs'] },
        prs: [
          { repo: 'karst', number: 1, status: 'open' },
          { repo: 'karst-docs', number: 2, status: 'open' },
        ],
        needs: { detail: '2 repos to merge', action: 'Merge', cta: { kind: 'merge-panel' } },
      }),
    );
    expect(peek.repos).toHaveLength(2);
    expect(peek.needs?.cta.kind).toBe('merge-panel');
  });

  it('an awaiting ship drops merged PR rows', () => {
    const peek = buildPeek(
      input({
        stageCurrent: 'ship',
        mergeGate: { kind: 'awaiting', repos: ['api'] },
        prs: [
          { repo: 'api', number: 4, status: 'merged' },
          { repo: 'api', number: 9, status: 'open' },
        ],
      }),
    );
    expect(peek.repos).toEqual([{ repo: 'api', number: 9, state: 'ready' }]);
  });

  it('a conflict reads "Merge conflict" and lists conflicted repos before ready ones', () => {
    const peek = buildPeek(
      input({
        stageCurrent: 'ship',
        current: stage({ stageKey: 'ship', status: 'passed' }),
        mergeGate: { kind: 'conflicted', repos: ['api'], pending: ['web'] },
        prs: [
          { repo: 'web', number: 8, status: 'open' },
          { repo: 'api', number: 7, status: 'open' },
        ],
        needs: { detail: '1 repo no longer merges cleanly', action: 'Resolve', cta: { kind: 'resolve-conflicts', repo: 'api' } },
      }),
    );
    expect(peek.title).toBe('Merge conflict');
    expect(peek.repos).toEqual([
      { repo: 'api', number: 7, state: 'conflict' },
      { repo: 'web', number: 8, state: 'ready' },
    ]);
    expect(peek.needs?.cta).toEqual({ kind: 'resolve-conflicts', repo: 'api' });
  });

  it('a failed ship reads "Ship failed" with the retry needs and the verdict line', () => {
    const peek = buildPeek(
      input({
        stageCurrent: 'ship',
        current: stage({ stageKey: 'ship', status: 'failed', verdict: 'push rejected' }),
        needs: { detail: 'push rejected', action: 'Retry ship', cta: { kind: 'retry-ship' } },
      }),
    );
    expect(peek.title).toBe('Ship failed');
    expect(peek.gates).toEqual({ text: 'push rejected', tone: 'failed' });
    expect(peek.needs?.cta).toEqual({ kind: 'retry-ship' });
  });

  it('failing CI on an awaiting ship keeps the send-ci-failure strip', () => {
    const peek = buildPeek(
      input({
        stageCurrent: 'ship',
        mergeGate: { kind: 'awaiting', repos: ['api'] },
        ciFailingRepos: ['api'],
      }),
    );
    expect(peek.title).toBe('Awaiting merge');
    expect(peek.next).toEqual({ kind: 'send-ci-failure', label: 'Send CI failure to agent' });
  });
});

describe('buildPeek — done, closed and scope', () => {
  it('a done ticket reads "Shipped" and offers the follow-up', () => {
    const peek = buildPeek(input({ stageCurrent: 'done', current: stage({ stageKey: 'done', status: 'passed' }), glyph: 'green' }));
    expect(peek.title).toBe('Shipped');
    expect(peek.next).toEqual({ kind: 'create-follow-up', label: 'Create follow-up' });
    expect(peek.needs).toBeNull();
  });

  it('a closed ticket reads closed outside Karst and quotes the reason', () => {
    const peek = buildPeek(
      input({ stageCurrent: 'closed', current: stage({ stageKey: 'closed', status: 'passed', verdict: 'fixed upstream' }) }),
    );
    expect(peek.title).toBe('Closed outside Karst');
    expect(peek.gates).toEqual({ text: 'fixed upstream', tone: 'ok' });
    expect(peek.next).toBeNull();
  });

  it('an unscoped ticket reads "Not scoped yet"', () => {
    expect(buildPeek(input()).title).toBe('Not scoped yet');
  });

  it('a scoped ticket reads ready to work, naming running servers when there are some (one plural, @arch:NTF-07)', () => {
    const wt = [{ repo: 'api' }];
    expect(buildPeek(input({ worktrees: wt })).title).toBe('Scoped — ready to work');
    expect(buildPeek(input({ worktrees: wt, servers: [{ status: 'running' }] })).title).toBe('1 server running');
    expect(buildPeek(input({ worktrees: wt, servers: [{ status: 'running' }, { status: 'running' }] })).title).toBe(
      '2 servers running',
    );
  });

  it('impl with no live session reads "No active session"; idle reads "Session idle"', () => {
    expect(buildPeek(input({ stageCurrent: 'impl', current: stage() })).title).toBe('No active session');
    expect(buildPeek(input({ stageCurrent: 'impl', agentState: 'idle', current: stage() })).title).toBe('Session idle');
  });
});

describe('buildPeek — the agent line', () => {
  it('is absent when no session exists', () => {
    expect(buildPeek(input({ stageCurrent: 'impl', provider: 'claude', model: 'opus' })).agent).toBeNull();
  });

  it('names the core, the model, the activity and the last hook time when a session exists', () => {
    const peek = buildPeek(
      input({
        stageCurrent: 'impl',
        agentState: 'running',
        sessionAction: SESS_OPEN,
        provider: 'opencode',
        model: 'opencode-go/deepseek-v4-flash',
        lastHookAt: '2026-08-12T10:00:00.000Z',
      }),
    );
    expect(peek.agent).toEqual({
      provider: 'opencode',
      model: 'opencode-go/deepseek-v4-flash',
      activity: 'working',
      activeAt: '2026-08-12T10:00:00.000Z',
    });
  });

  it('reads waiting and idle activity words', () => {
    const base = { stageCurrent: 'impl', sessionAction: SESS_CONT, provider: 'claude' as const };
    expect(buildPeek(input({ ...base, agentState: 'waiting' })).agent?.activity).toBe('waiting for you');
    expect(buildPeek(input({ ...base, agentState: 'idle' })).agent?.activity).toBe('idle');
  });

  it('is absent when no core is configured', () => {
    expect(buildPeek(input({ stageCurrent: 'impl', sessionAction: SESS_OPEN, provider: null })).agent).toBeNull();
  });
});
