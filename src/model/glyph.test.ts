import { describe, it, expect } from 'vitest';
import { glyphFor, GLYPH_WORD, type Glyph } from './glyph.js';
import type { StageStatus, AgentState } from './types.js';

const GLYPHS: readonly Glyph[] = ['gray', 'blue', 'amber', 'green', 'red'];

describe('GLYPH_WORD', () => {
  it('names every glyph once, with one word per state (SB-13)', () => {
    expect(Object.keys(GLYPH_WORD).sort()).toEqual([...GLYPHS].sort());
    expect(GLYPH_WORD).toEqual({
      gray: 'Pending',
      blue: 'Running',
      amber: 'Needs you',
      green: 'Done',
      red: 'Failed',
    });
  });

  it('gives each state a distinct word, so no two states share a name', () => {
    const words = GLYPHS.map((g) => GLYPH_WORD[g]);
    expect(new Set(words).size).toBe(GLYPHS.length);
  });

  it('calls the red state Failed, never Blocked (a block is amber, @arch:BLOCKED)', () => {
    expect(GLYPH_WORD.red).toBe('Failed');
    expect(Object.values(GLYPH_WORD)).not.toContain('Blocked');
  });
});

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
    ['running', 'not-started', 'amber'], // v68 launch-delivery guard: needs-you
    ['passed', 'not-started', 'amber'],
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

  it('prioritizes not-started(amber) over failed(red)', () => {
    expect(glyphFor('failed', 'not-started')).toBe('amber');
  });
});
