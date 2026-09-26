import { describe, it, expect } from 'vitest';
import { glyphFor } from './glyph.js';
import type { StageStatus, AgentState } from './types.js';

describe('glyphFor', () => {
  // waiting wins over everything — needs-you is the highest-priority signal.
  it('returns amber whenever the agent is waiting, regardless of stage', () => {
    const stages: StageStatus[] = ['pending', 'running', 'passed', 'failed', 'skipped', 'bypassed'];
    for (const s of stages) {
      expect(glyphFor(s, 'waiting')).toBe('amber');
    }
  });

  const cases: [StageStatus, AgentState, string][] = [
    ['failed', 'idle', 'red'],
    ['failed', 'none', 'red'],
    ['passed', 'idle', 'green'],
    ['passed', 'running', 'blue'], // a running agent beats a finished stage (the resolve session on a passed ship)
    ['running', 'idle', 'blue'],
    ['pending', 'running', 'blue'], // agent running drives blue even if stage pending
    ['pending', 'idle', 'gray'],
    ['pending', 'none', 'gray'],
    ['skipped', 'idle', 'gray'],
    ['bypassed', 'idle', 'gray'], // P2-18: disabled gates are not a green pass
    ['bypassed', 'none', 'gray'],
  ];

  it.each(cases)('stage=%s agent=%s → %s', (stage, agent, expected) => {
    expect(glyphFor(stage, agent)).toBe(expected);
  });

  it('prioritizes failed(red) over running-agent(blue)', () => {
    expect(glyphFor('failed', 'running')).toBe('red');
  });

  it('prioritizes waiting(amber) over failed(red)', () => {
    expect(glyphFor('failed', 'waiting')).toBe('amber');
  });
});
