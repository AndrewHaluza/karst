import { describe, it, expect } from 'vitest';
import {
  COMMAND_SPECS,
  commandNames,
  getCommandSpec,
  validateCommandInput,
} from './registry.js';

describe('command registry', () => {
  it('registers every CLI verb the guide documents', () => {
    for (const verb of [
      'context',
      'stats',
      'stage',
      'phase',
      'graph',
      'node',
      'test',
      'guide',
      'compact',
      'servers',
      'env',
      'pause',
      'unpause',
      'subtask',
      'draft',
      'message',
      'inbox',
      'notes',
      'fix-brief',
      'conflict-brief',
      'schema',
      'manifest',
      'setup',
    ]) {
      expect(getCommandSpec(verb), verb).toBeDefined();
    }
  });

  it('has no duplicate names and returns them in order', () => {
    const names = commandNames();
    expect(new Set(names).size).toBe(names.length);
    expect(names[0]).toBe('context');
  });

  it('gives every spec an object input schema', () => {
    for (const spec of COMMAND_SPECS) {
      expect(spec.input.type, spec.name).toBe('object');
      expect(spec.summary.length, spec.name).toBeGreaterThan(0);
    }
  });

  it('returns undefined for an unknown or absent command', () => {
    expect(getCommandSpec('nope')).toBeUndefined();
    expect(getCommandSpec(undefined)).toBeUndefined();
  });
});

describe('validateCommandInput', () => {
  it('accepts a valid subtask input', () => {
    expect(validateCommandInput('subtask', { title: 'Piece', blocking: true })).toEqual({
      title: 'Piece',
      blocking: true,
    });
  });

  it('rejects a missing required field, naming the command', () => {
    expect(() => validateCommandInput('subtask', {})).toThrow(/subtask: invalid input.*title/);
  });

  it('rejects an unknown field', () => {
    expect(() => validateCommandInput('subtask', { title: 'x', nope: 1 })).toThrow(/nope/);
  });

  it('rejects an enum violation', () => {
    expect(() => validateCommandInput('stage', { stage: 'ship' })).toThrow(/one of/);
  });

  it('rejects a CSV array element containing a comma', () => {
    expect(() => validateCommandInput('subtask', { title: 'x', repos: ['a,b'] })).toThrow(
      /repos\[0\].*must match/,
    );
  });

  it('rejects env set/unset keys containing =', () => {
    const spec = getCommandSpec('env')!;
    expect(() => spec.toArgv!({ action: 'set', set: { 'A=B': 'v' } })).toThrow(/cannot contain '='/);
    expect(() => spec.toArgv!({ action: 'unset', unset: ['A=B'] })).toThrow(/cannot contain '='/);
  });

  it('rejects a non-object', () => {
    expect(() => validateCommandInput('stats', 'nope')).toThrow(/expected object/);
  });

  it('rejects an unknown command', () => {
    expect(() => validateCommandInput('nope', {})).toThrow(/unknown command/);
  });
});

describe('toArgv encoders', () => {
  it('encodes subtask create with flags and inverse --no-start', () => {
    const spec = getCommandSpec('subtask')!;
    expect(spec.toArgv!({ title: 'T', description: 'D', blocking: true, repos: ['a', 'b'] })).toEqual(
      ['subtask', 'create', '--title', 'T', '--description', 'D', '--blocking', '--repos', 'a,b'],
    );
    expect(spec.toArgv!({ title: 'T', start: false })).toContain('--no-start');
    expect(spec.toArgv!({ title: 'T' })).not.toContain('--no-start');
  });

  it('encodes stage as <stage> pass', () => {
    expect(getCommandSpec('stage')!.toArgv!({ stage: 'fix' })).toEqual(['stage', 'fix', 'pass']);
  });

  it('encodes context format', () => {
    expect(getCommandSpec('context')!.toArgv!({ key: 'K-1', format: 'md' })).toEqual([
      'context',
      'K-1',
      '--md',
    ]);
    expect(getCommandSpec('context')!.toArgv!({ key: 'K-1' })).toEqual(['context', 'K-1']);
  });

  it('encodes env set pairs', () => {
    expect(
      getCommandSpec('env')!.toArgv!({ action: 'set', service: 'app', set: { A: '1', B: '2' } }),
    ).toEqual(['env', 'set', '--service', 'app', 'A=1', 'B=2']);
  });

  it('encodes message send', () => {
    expect(getCommandSpec('message')!.toArgv!({ to: 'parent', body: 'hi' })).toEqual([
      'message',
      'send',
      '--to',
      'parent',
      '--body',
      'hi',
    ]);
  });

  it('encodes schema command targeting', () => {
    expect(getCommandSpec('schema')!.toArgv!({})).toEqual(['schema']);
    expect(getCommandSpec('schema')!.toArgv!({ command: 'subtask' })).toEqual(['schema', 'subtask']);
  });

  it('omits optional flags that are absent', () => {
    expect(getCommandSpec('stats')!.toArgv!({})).toEqual(['stats']);
    expect(getCommandSpec('compact')!.toArgv!({})).toEqual(['compact']);
    expect(getCommandSpec('inbox')!.toArgv!({})).toEqual(['inbox']);
  });

  it('has no encoder for internal verbs', () => {
    for (const name of ['graph', 'node', 'test', 'guide']) {
      expect(getCommandSpec(name)!.toArgv, name).toBeUndefined();
    }
  });

  it('models the graph submit verb in its schema', () => {
    expect(getCommandSpec('graph')!.input.properties?.verb).toMatchObject({ enum: ['submit'] });
  });
});
