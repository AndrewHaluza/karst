import { describe, it, expect } from 'vitest';
import { parseSchemaArgs, runSchemaCommand } from './schemaCommand.js';
import { commandNames } from './registry.js';
import { runCli } from './main.js';

describe('karst schema — parse', () => {
  it('accepts a bare schema command', () => {
    expect(parseSchemaArgs(['schema'])).toBeUndefined();
  });

  it('accepts one target command', () => {
    expect(parseSchemaArgs(['schema', 'subtask'])).toBe('subtask');
  });

  it('rejects an unknown command, naming the known ones', () => {
    expect(() => parseSchemaArgs(['schema', 'nope'])).toThrow(/unknown command 'nope'/);
    expect(() => parseSchemaArgs(['schema', 'nope'])).toThrow(/subtask/);
  });

  it('rejects a flag and trailing argv', () => {
    expect(() => parseSchemaArgs(['schema', '--json'])).toThrow(/unknown flag/);
    expect(() => parseSchemaArgs(['schema', 'subtask', 'extra'])).toThrow(/unexpected argument/);
  });

  it('rejects a missing command token', () => {
    expect(() => parseSchemaArgs([])).toThrow(/schema/);
  });
});

describe('karst schema — output', () => {
  it('prints every command schema by default', () => {
    const out = JSON.parse(runSchemaCommand(['schema']));
    expect(out.commands.map((c: { command: string }) => c.command)).toEqual(commandNames());
  });

  it('prints one command schema with its input shape', () => {
    const out = JSON.parse(runSchemaCommand(['schema', 'subtask']));
    expect(out.command).toBe('subtask');
    expect(out.writes).toBe(true);
    expect(out.input.properties.title.type).toBe('string');
    expect(out.input.required).toContain('title');
    expect(out.globals).toMatchObject({ db: true, ticket: true });
  });

  it('marks read-only verbs as non-writing', () => {
    const out = JSON.parse(runSchemaCommand(['schema', 'context']));
    expect(out.writes).toBe(false);
  });

  it('flags which verbs accept --file/--stdin structured input', () => {
    expect(JSON.parse(runSchemaCommand(['schema', 'subtask'])).structured).toBe(true);
    expect(JSON.parse(runSchemaCommand(['schema', 'graph'])).structured).toBe(false);
  });
});

describe('karst schema — CLI routing', () => {
  it('runs through runCli without a db', () => {
    expect(JSON.parse(runCli(['schema', 'stage'])).command).toBe('stage');
  });

  it('accepts a target command through structured stdin input', () => {
    const out = JSON.parse(
      runCli(['schema', '--stdin'], {}, { readStdin: () => '{"command":"env"}' }),
    );
    expect(out.command).toBe('env');
  });
});
