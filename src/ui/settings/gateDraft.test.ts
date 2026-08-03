import { describe, it, expect } from 'vitest';
import { emptyGate, setGateKind, validateGateDraft, gateSummary } from './gateDraft.js';

describe('gate draft helpers', () => {
  it('starts a new gate as an empty script gate', () => {
    expect(emptyGate()).toEqual({ name: '', kind: 'script', script: '' });
  });

  it('drops the other kind fields when switching kind', () => {
    const asCommand = setGateKind({ name: 'e2e', kind: 'script', script: 'test' }, 'command');
    expect(asCommand).toEqual({ name: 'e2e', kind: 'command', command: '', args: [] });
    expect(asCommand).not.toHaveProperty('script');
    const back = setGateKind(asCommand, 'script');
    expect(back).toEqual({ name: 'e2e', kind: 'script', script: '' });
  });

  it('never mutates its input', () => {
    const gate = { name: 'a', kind: 'script' as const, script: 's' };
    setGateKind(gate, 'command');
    expect(gate).toEqual({ name: 'a', kind: 'script', script: 's' });
  });

  it('rejects a nameless gate', () => {
    expect(validateGateDraft({ name: '  ', kind: 'script', script: 'test' }))
      .toContain('name');
  });

  it('rejects a script gate with no script and a command gate with no command', () => {
    expect(validateGateDraft({ name: 'a', kind: 'script' })).toContain('script');
    expect(validateGateDraft({ name: 'a', kind: 'command' })).toContain('command');
  });

  it('accepts a valid gate of each kind', () => {
    expect(validateGateDraft({ name: 'test', kind: 'script', script: 'test' })).toBeNull();
    expect(validateGateDraft({ name: 'e2e', kind: 'command', command: 'npx', args: ['playwright'] }))
      .toBeNull();
  });

  it('summarises each kind', () => {
    expect(gateSummary({ name: 'test', kind: 'script', script: 'test' })).toBe('npm run test');
    expect(gateSummary({ name: 'e2e', kind: 'command', command: 'npx', args: ['playwright', 'test'] }))
      .toBe('npx playwright test');
  });

  it('preserves repo across a kind switch — repo belongs to neither kind', () => {
    const scriptGate = { name: 'e2e', kind: 'script' as const, script: 'test', repo: 'frontend' };
    expect(setGateKind(scriptGate, 'command')).toEqual({
      name: 'e2e', kind: 'command', command: '', args: [], repo: 'frontend',
    });
    const commandGate = {
      name: 'e2e', kind: 'command' as const, command: 'npx', args: ['playwright'], repo: 'frontend',
    };
    expect(setGateKind(commandGate, 'script')).toEqual({
      name: 'e2e', kind: 'script', script: '', repo: 'frontend',
    });
  });

  it('summarises a half-filled gate without dangling whitespace', () => {
    expect(gateSummary({ name: 'a', kind: 'script' })).toBe('npm run');
    expect(gateSummary({ name: 'a', kind: 'command', command: 'npx', args: [] })).toBe('npx');
    expect(gateSummary({ name: 'a', kind: 'command', command: '' })).toBe('');
  });
});
