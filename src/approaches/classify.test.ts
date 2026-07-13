import { describe, it, expect } from 'vitest';
import { classifyPath } from './classify.js';

describe('classifyPath', () => {
  it('maps .claude/agents to agent kind under agents/', () => {
    expect(classifyPath('.claude/agents')).toEqual({ kind: 'agent', destDir: 'agents' });
  });

  it('maps .claude/commands to command kind under commands/', () => {
    expect(classifyPath('.claude/commands')).toEqual({ kind: 'command', destDir: 'commands' });
  });

  it('maps a bare agents dir', () => {
    expect(classifyPath('agents')).toEqual({ kind: 'agent', destDir: 'agents' });
  });

  it('maps a whole skills dir', () => {
    expect(classifyPath('skills')).toEqual({ kind: 'skill', destDir: 'skills' });
    expect(classifyPath('.claude/skills')).toEqual({ kind: 'skill', destDir: 'skills' });
  });

  it('maps a single skill folder preserving its name', () => {
    expect(classifyPath('skills/writing-plans')).toEqual({
      kind: 'skill',
      destDir: 'skills/writing-plans',
    });
  });

  it('returns null for an unrecognized layout (falls back to flat prompts)', () => {
    expect(classifyPath('prompts')).toBeNull();
    expect(classifyPath('docs')).toBeNull();
    expect(classifyPath('')).toBeNull();
  });

  it('classifies a marker nested under base dirs (subfolder source layout)', () => {
    expect(classifyPath('development-workflows/rpi/.claude/agents')).toEqual({
      kind: 'agent',
      destDir: 'agents',
    });
    expect(classifyPath('development-workflows/rpi/commands/rpi')).toEqual({
      kind: 'command',
      destDir: 'commands',
    });
    // The real rpi layout: commands namespaced under .claude/commands/<ns>.
    expect(classifyPath('development-workflows/rpi/.claude/commands/rpi')).toEqual({
      kind: 'command',
      destDir: 'commands',
    });
  });

  it('classifies a nested single skill folder preserving its name', () => {
    expect(classifyPath('packages/foo/skills/tdd')).toEqual({
      kind: 'skill',
      destDir: 'skills/tdd',
    });
  });
});
