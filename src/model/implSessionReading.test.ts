import { describe, it, expect } from 'vitest';
import { implSessionReading, isSessionless } from './implSessionReading.js';
import { implementationSessionProcess } from './inside/agent.js';
import { buildStageRail } from './stageRail.js';
import type { StepperCell } from './stepper.js';

const NOW = '2026-11-05T10:00:00.000Z';
const running: StepperCell = { stageKey: 'impl', status: 'running', startedAt: '2026-11-03T10:00:00.000Z' };
const facts = (agentState: string, hasRun = false, graphRunLive = false) => ({ agentState, hasRun, graphRunLive });

const row = (reading: ReturnType<typeof implSessionReading>) =>
  implementationSessionProcess(running, null, [], null, null, NOW, () => ({ kind: 'open-session' }) as never, [], false, reading);
const rail = (reading: ReturnType<typeof implSessionReading>) =>
  buildStageRail([running], [running] as never, { current: 'impl', needsUser: false, needs: null, implSession: reading })
    .main.find((s) => s.cell.stageKey === 'impl')!;

describe('implSessionReading', () => {
  it('1: agent_state running is live, spinner and duration kept', () => {
    const r = implSessionReading(running, facts('running'));
    expect(r).toBe('live');
    expect(row(r).status).toBe('run');
    expect(row(r).detail).toBe('agent session running');
    expect(row(r).duration).toBeDefined();
    expect(rail(r).status).toBe('running');
  });
  it('2: waiting is unchanged', () => {
    expect(implSessionReading(running, facts('waiting', true))).toBe('waiting');
  });
  it('3: not-started says the session did not start, no spinner', () => {
    const r = implSessionReading(running, facts('not-started'));
    expect(row(r).status).toBe('pending');
    expect(row(r).detail).toBe('the session did not start');
    expect(rail(r).status).toBe('pending');
  });
  it('4/T952: no run, agent_state none: no session started, Open session, no duration', () => {
    const r = implSessionReading(running, facts('none'));
    expect(r).toBe('no-session');
    const p = row(r);
    expect(p.status).toBe('pending');
    expect(p.detail).toBe('no session started');
    expect(p.action).toBeDefined();
    expect(p.duration).toBeUndefined();
    expect(p.time).toBeDefined();
    expect(rail(r).status).toBe('pending');
  });
  it('5: a run with idle or none reads agent session idle', () => {
    for (const s of ['idle', 'none']) {
      const r = implSessionReading(running, facts(s, true));
      expect(r).toBe('idle');
      expect(row(r).detail).toBe('agent session idle');
      expect(row(r).duration).toBeUndefined();
      expect(rail(r).status).toBe('pending');
    }
  });
  it('6: a graph run that is open stays live without a session', () => {
    expect(implSessionReading(running, facts('none', false, true))).toBe('live');
  });
  it('does not apply to other stages or non-running impl', () => {
    expect(implSessionReading({ stageKey: 'uat', status: 'running' }, facts('none'))).toBeNull();
    expect(implSessionReading({ stageKey: 'impl', status: 'passed' }, facts('none'))).toBeNull();
    expect(isSessionless(null)).toBe(false);
  });
});
