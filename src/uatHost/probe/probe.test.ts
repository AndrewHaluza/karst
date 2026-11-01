import { describe, expect, it } from 'vitest';
import { probeEnabled } from './gate.js';
import { ProbeRecorder, normalizeLogLine } from './recorder.js';
import { conditionMet, runSteps, type ProbeHost, type Snapshot, type SnapshotScope } from './runner.js';
import { parseSteps } from './steps.js';

const empty = (): Snapshot => ({ tickets: [], sidebar: { lastMessage: null }, webviews: [], notifications: [], logTail: [], launches: [] });

describe('probeEnabled', () => {
  it('is on only for KARST_UAT_PROBE=1', () => {
    expect(probeEnabled({})).toBe(false);
    expect(probeEnabled({ KARST_UAT_PROBE: '0' })).toBe(false);
    expect(probeEnabled({ KARST_UAT_PROBE: 'true' })).toBe(false);
    expect(probeEnabled({ KARST_UAT_PROBE: '1' })).toBe(true);
  });
});

describe('parseSteps', () => {
  it('accepts a bare array or {steps}, and clamps timeouts', () => {
    const steps = parseSteps({ steps: [
      { type: 'command', command: 'karst.x', args: [1], timeoutMs: 999_999 },
      { type: 'wait', for: { ticketStage: { key: 'A', stage: 'impl' } } },
      { type: 'snapshot', label: 'l' },
    ] });
    expect(steps).toEqual([
      { type: 'command', command: 'karst.x', args: [1], timeoutMs: 60_000 },
      { type: 'wait', for: { ticketStage: { key: 'A', stage: 'impl' } } },
      { type: 'snapshot', label: 'l' },
    ]);
    expect(parseSteps([{ type: 'snapshot' }])).toEqual([{ type: 'snapshot' }]);
    expect(parseSteps([{ type: 'restart', timeoutMs: 999_999 }])).toEqual([{ type: 'restart', timeoutMs: 60_000 }]);
  });
  it.each([
    [{}, 'non-empty'],
    [[], 'non-empty'],
    [['x'], 'step 0: must be an object'],
    [[{ type: 'eval' }], 'unknown step type "eval"'],
    [[{ type: 'command' }], 'command needs a name'],
    [[{ type: 'command', command: 'a', args: 'b' }], 'args must be an array'],
    [[{ type: 'command', command: 'a', timeoutMs: -1 }], 'timeoutMs'],
    [[{ type: 'wait', for: 1 }], '"for" must be an object'],
    [[{ type: 'wait', for: { log: 'a', notification: 'b' } }], 'exactly one'],
    [[{ type: 'wait', for: { code: 'x' } }], 'unknown wait condition "code"'],
    [[{ type: 'wait', for: { log: '' } }], 'non-empty string'],
    [[{ type: 'wait', for: { ticketStage: { key: 'A' } } }], 'string key and stage'],
  ])('rejects %j', (input, msg) => {
    expect(() => parseSteps(input)).toThrow(msg);
  });
});

describe('ProbeRecorder', () => {
  it('tracks webviews, notifications and a bounded timestamp-free log tail', () => {
    const r = new ProbeRecorder();
    r.webviewOpened('b', 'v', 'B');
    r.webviewOpened('a', 'v', 'A');
    r.webviewPosted('a', { n: 1 });
    r.webviewPosted('a', { n: 2 });
    r.webviewPosted('gone', 1);
    r.notification('warning', 'hi');
    for (let i = 0; i < 45; i++) r.logLine(`2026-01-01T00:00:00.000Z line ${i}`);
    const v = r.view();
    expect(v.webviews.map((w) => w.id)).toEqual(['a', 'b']);
    expect(v.webviews[0]).toMatchObject({ messageCount: 2, lastMessage: { n: 2 } });
    expect(v.notifications).toEqual([{ level: 'warning', message: 'hi' }]);
    expect(v.logTail).toHaveLength(40);
    expect(v.logTail[0]).toBe('line 5');
    r.webviewClosed('a');
    expect(r.view().webviews.map((w) => w.id)).toEqual(['b']);
  });
  it('normalizes bracketed and plain timestamps', () => {
    expect(normalizeLogLine('[2026-10-13 12:00:00.123] INFO x')).toBe('INFO x');
    expect(normalizeLogLine('no stamp')).toBe('no stamp');
    expect(normalizeLogLine('project "workspace-66aa979b" and workspace-a2f8b8ed')).toBe('project "workspace-<hash>" and workspace-<hash>');
  });
});

describe('conditionMet', () => {
  const s: Snapshot = {
    ...empty(),
    tickets: [{ key: 'A', title: 't', stage: 'impl', stages: [] }],
    notifications: [{ level: 'info', message: 'hello world' }],
    logTail: ['Karst activated'],
    sidebar: { lastMessage: { type: 'state', n: 7 } },
    webviews: [{ id: 'w', viewType: 'v', title: 't', messageCount: 1, lastMessage: { type: 'push' } }],
  };
  it('matches each condition kind', () => {
    expect(conditionMet({ ticketStage: { key: 'A', stage: 'impl' } }, s)).toBe(true);
    expect(conditionMet({ ticketStage: { key: 'A', stage: 'uat' } }, s)).toBe(false);
    expect(conditionMet({ notification: 'world' }, s)).toBe(true);
    expect(conditionMet({ notification: 'nope' }, s)).toBe(false);
    expect(conditionMet({ log: 'activated' }, s)).toBe(true);
    expect(conditionMet({ log: 'zzz' }, s)).toBe(false);
    expect(conditionMet({ webviewMessage: 'push' }, s)).toBe(true);
    expect(conditionMet({ webviewMessage: '"n":7' }, s)).toBe(true);
    expect(conditionMet({ webviewMessage: 'absent' }, s)).toBe(false);
  });
  it('matches a launch by provider, or any launch when none is named', () => {
    const l = { ...s, launches: [{ provider: 'codex', argv: [], envKeys: [], cwd: '/w' }] };
    expect(conditionMet({ launch: {} }, l)).toBe(true);
    expect(conditionMet({ launch: { provider: 'codex' } }, l)).toBe(true);
    expect(conditionMet({ launch: { provider: 'claude' } }, l)).toBe(false);
    expect(conditionMet({ launch: {} }, s)).toBe(false);
  });
  it('parses launch waits and refuses a bad provider', () => {
    expect(parseSteps([{ type: 'wait', for: { launch: { provider: 'claude' } } }]))
      .toEqual([{ type: 'wait', for: { launch: { provider: 'claude' } } }]);
    expect(parseSteps([{ type: 'wait', for: { launch: {} } }])).toEqual([{ type: 'wait', for: { launch: {} } }]);
    expect(() => parseSteps([{ type: 'wait', for: { launch: { provider: '' } } }])).toThrow(/launch.provider/);
    expect(() => parseSteps([{ type: 'wait', for: { launch: 'x' } }])).toThrow(/launch needs an object/);
  });
});

describe('runSteps', () => {
  const mkHost = (over: Partial<ProbeHost> = {}): ProbeHost => ({
    execute: async () => undefined,
    restart: async () => undefined,
    snapshot: empty,
    ...over,
  });
  const run = (steps: unknown, host: ProbeHost, extra = {}) => {
    const evidence: Array<[number, unknown]> = [];
    return runSteps(parseSteps(steps), { host, writeEvidence: (i, e) => { evidence.push([i, e]); }, pollMs: 5, ...extra })
      .then((results) => ({ results, evidence }));
  };

  it('runs a 3-step script and writes evidence after each step', async () => {
    const calls: unknown[] = [];
    const { results, evidence } = await run(
      [{ type: 'command', command: 'c', args: [1] }, { type: 'wait', for: { log: 'x' } }, { type: 'snapshot' }],
      mkHost({ execute: async (c, a) => { calls.push([c, a]); }, snapshot: () => ({ ...empty(), logTail: ['x'] }) }),
    );
    expect(calls).toEqual([['c', [1]]]);
    expect(results.map((r) => r.status)).toEqual(['pass', 'pass', 'pass']);
    expect(evidence.map(([i]) => i)).toEqual([0, 1, 2]);
  });
  it('scopes the poll snapshot to what the wait needs, but takes a full snapshot for evidence', async () => {
    const scopes: Array<SnapshotScope | undefined> = [];
    await run([{ type: 'wait', for: { log: 'x' } }],
      mkHost({ snapshot: (scope) => { scopes.push(scope); return { ...empty(), logTail: ['x'] }; } }));
    expect(scopes[0]).toEqual({ tickets: false, launches: false });
    expect(scopes.at(-1)).toBeUndefined(); // evidence snapshot is unscoped (full)

    const ticketScopes: Array<SnapshotScope | undefined> = [];
    await run([{ type: 'wait', for: { ticketStage: { key: 'A', stage: 'impl' } }, timeoutMs: 20 }],
      mkHost({ snapshot: (scope) => { ticketScopes.push(scope); return empty(); } }));
    expect(ticketScopes).toContainEqual({ tickets: true, launches: false });

    const launchScopes: Array<SnapshotScope | undefined> = [];
    await run([{ type: 'wait', for: { launch: {} }, timeoutMs: 20 }],
      mkHost({ snapshot: (scope) => { launchScopes.push(scope); return empty(); } }));
    expect(launchScopes).toContainEqual({ tickets: false, launches: true });
  });
  it('reports a throwing command as fail and stops', async () => {
    const { results, evidence } = await run(
      [{ type: 'command', command: 'c' }, { type: 'snapshot' }],
      mkHost({ execute: async () => { throw new Error('boom'); } }),
    );
    expect(results).toEqual([{ index: 0, type: 'command', status: 'fail', detail: 'boom' }]);
    expect(evidence).toHaveLength(1);
  });
  it('reports a non-Error throw', async () => {
    const { results } = await run([{ type: 'command', command: 'c' }],
      mkHost({ execute: () => Promise.reject('str') }));
    expect(results[0]?.detail).toBe('str');
  });
  it('times out a hung command with its index instead of hanging', async () => {
    const { results } = await run(
      [{ type: 'snapshot' }, { type: 'command', command: 'c', timeoutMs: 20 }],
      mkHost({ execute: () => new Promise(() => undefined) }),
    );
    expect(results[1]).toMatchObject({ index: 1, status: 'timeout' });
    expect(results[1]?.detail).toContain('c exceeded 20ms');
  });
  it('times out an unmet wait', async () => {
    const { results } = await run([{ type: 'wait', for: { log: 'never' }, timeoutMs: 30 }], mkHost());
    expect(results[0]).toMatchObject({ status: 'timeout' });
    expect(results[0]?.detail).toContain('not met in 30ms');
  });
  it('enforces the total script timeout', async () => {
    const { results } = await run([{ type: 'snapshot' }, { type: 'snapshot' }], mkHost(), { totalTimeoutMs: -1 });
    expect(results).toEqual([{ index: 0, type: 'snapshot', status: 'timeout', detail: 'script total timeout exceeded' }]);
  });

  it('restart calls the host, then later steps see the restarted state', async () => {
    const calls: string[] = [];
    const host = mkHost({
      restart: async () => { calls.push('restart'); },
      execute: async (c) => { calls.push(c); },
    });
    const { results } = await run([{ type: 'restart' }, { type: 'command', command: 'after' }], host);
    expect(calls).toEqual(['restart', 'after']);
    expect(results.map((r) => [r.type, r.status])).toEqual([['restart', 'pass'], ['command', 'pass']]);
  });
  it('a failing restart fails the step and stops the run', async () => {
    const host = mkHost({ restart: async () => { throw new Error('activate blew up'); } });
    const { results } = await run([{ type: 'restart' }, { type: 'snapshot' }], host);
    expect(results).toEqual([{ index: 0, type: 'restart', status: 'fail', detail: 'activate blew up' }]);
  });
  it('a hung restart times out and names itself', async () => {
    const host = mkHost({ restart: () => new Promise<void>(() => undefined) });
    const { results } = await run([{ type: 'restart', timeoutMs: 20 }], host);
    expect(results[0]).toMatchObject({ status: 'timeout', detail: 'restart exceeded 20ms' });
  });
});

describe('ticketSettled wait and raised step cap (eval runs)', () => {
  const snap = (stage: string, blockedKind: string | null) => ({
    tickets: [{ key: 'A', title: 't', stage, stages: [{ stage, status: 'running', blockedKind }] }],
    sidebar: { lastMessage: null }, webviews: [], notifications: [], logTail: [], launches: [],
  });
  it('is met on ship or on a blocked current stage, not on a running one', () => {
    const c = { ticketSettled: { key: 'A' } };
    expect(conditionMet(c, snap('impl', null))).toBe(false);
    expect(conditionMet(c, snap('ship', null))).toBe(true);
    expect(conditionMet(c, snap('uat', 'boot-failed'))).toBe(true);
    expect(conditionMet({ ticketSettled: { key: 'B' } }, snap('ship', null))).toBe(false);
  });
  it('parses, and only a caller-given cap lifts the 60s clamp', () => {
    const raw = { steps: [{ type: 'wait', for: { ticketSettled: { key: 'A' } }, timeoutMs: 600_000 }] };
    expect(parseSteps(raw)[0]).toMatchObject({ timeoutMs: 60_000 });
    expect(parseSteps(raw, 900_000)[0]).toMatchObject({ timeoutMs: 600_000 });
    expect(() => parseSteps({ steps: [{ type: 'wait', for: { ticketSettled: {} } }] })).toThrow('string key');
  });
});
