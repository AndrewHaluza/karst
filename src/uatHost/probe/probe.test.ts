import { describe, expect, it } from 'vitest';
import { probeEnabled } from './gate.js';
import { ProbeRecorder, normalizeLogLine } from './recorder.js';
import { conditionMet, runSteps, type ProbeHost, type Snapshot } from './runner.js';
import { parseSteps } from './steps.js';

const empty = (): Snapshot => ({ tickets: [], sidebar: { lastMessage: null }, webviews: [], notifications: [], logTail: [] });

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
});

describe('runSteps', () => {
  const mkHost = (over: Partial<ProbeHost> = {}): ProbeHost => ({
    execute: async () => undefined,
    snapshot: empty,
    ...over,
  });
  const run = (steps: unknown, host: ProbeHost, extra = {}) => {
    const evidence: Array<[number, unknown]> = [];
    return runSteps(parseSteps(steps), { host, writeEvidence: (i, e) => evidence.push([i, e]), pollMs: 5, ...extra })
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
});
