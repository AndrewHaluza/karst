import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MAX_STRUCTURED_INPUT_BYTES, resolveStructuredInput } from './commandInput.js';
import { getCommandSpec } from './registry.js';
import { runCli } from './main.js';
import { openStore, type Store } from '../store/db.js';
import { createTicket } from '../store/tickets.js';

const subtaskSpec = () => getCommandSpec('subtask')!;
const deps = (raw: string) => ({ readStdin: () => raw });

describe('resolveStructuredInput', () => {
  it('returns undefined when neither --file nor --stdin is present', () => {
    expect(
      resolveStructuredInput(subtaskSpec(), ['subtask', '--title', 'x'], deps('')),
    ).toBeUndefined();
  });

  it('reads a JSON object from stdin and encodes argv', () => {
    const out = resolveStructuredInput(
      subtaskSpec(),
      ['subtask', '--stdin'],
      deps('{"title":"Piece","repos":["a"]}'),
    );
    expect(out?.source).toBe('stdin');
    expect(out?.argv).toEqual(['subtask', 'create', '--title', 'Piece', '--repos', 'a']);
  });

  it('reads a JSON object from --file', () => {
    const out = resolveStructuredInput(subtaskSpec(), ['subtask', '--file', '/x.json'], {
      readStdin: () => '',
      readFile: () => '{"title":"Piece"}',
    });
    expect(out?.source).toBe('file');
    expect(out?.argv).toEqual(['subtask', 'create', '--title', 'Piece']);
  });

  it('rejects non-JSON input', () => {
    expect(() =>
      resolveStructuredInput(subtaskSpec(), ['subtask', '--stdin'], deps('not json')),
    ).toThrow(/input is not JSON/);
  });

  it('rejects a schema violation with the command name', () => {
    expect(() =>
      resolveStructuredInput(subtaskSpec(), ['subtask', '--stdin'], deps('{}')),
    ).toThrow(/subtask: invalid input.*title/);
  });

  it('rejects --file and --stdin together', () => {
    expect(() =>
      resolveStructuredInput(
        subtaskSpec(),
        ['subtask', '--file', '/x.json', '--stdin'],
        deps('{}'),
      ),
    ).toThrow(/mutually exclusive/);
  });

  it('rejects --file without a path', () => {
    expect(() =>
      resolveStructuredInput(subtaskSpec(), ['subtask', '--file'], deps('')),
    ).toThrow(/--file needs a path/);
    expect(() =>
      resolveStructuredInput(subtaskSpec(), ['subtask', '--file='], deps('')),
    ).toThrow(/--file needs a path/);
  });

  it('accepts the --file=<path> form', () => {
    const out = resolveStructuredInput(subtaskSpec(), ['subtask', '--file=/x.json'], {
      readStdin: () => '',
      readFile: () => '{"title":"Piece"}',
    });
    expect(out?.argv).toEqual(['subtask', 'create', '--title', 'Piece']);
  });

  it('strips a UTF-8 BOM before parsing', () => {
    const out = resolveStructuredInput(subtaskSpec(), ['subtask', '--stdin'], {
      readStdin: () => '\uFEFF{"title":"BOM"}',
    });
    expect(out?.value).toEqual({ title: 'BOM' });
  });

  it('rejects a repo element containing a comma', () => {
    expect(() =>
      resolveStructuredInput(subtaskSpec(), ['subtask', '--stdin'], {
        readStdin: () => JSON.stringify({ title: 'x', repos: ['a,b'] }),
      }),
    ).toThrow(/repos\[0\].*must match/);
  });

  it('reports an unreadable --file', () => {
    expect(() =>
      resolveStructuredInput(subtaskSpec(), ['subtask', '--file', '/nope.json'], {
        readStdin: () => '',
        readFile: () => {
          throw new Error('ENOENT');
        },
      }),
    ).toThrow(/cannot read --file \/nope.json/);
  });

  it('refuses structured input for a command with no encoder', () => {
    expect(() =>
      resolveStructuredInput(getCommandSpec('test')!, ['test', 'get-state', '--stdin'], deps('{}')),
    ).toThrow(/not supported/);
  });

  it('keeps a flag value that is literally --file (no structured hijack)', () => {
    expect(
      resolveStructuredInput(subtaskSpec(), ['subtask', 'create', '--title', '--file'], deps('{}')),
    ).toBeUndefined();
    expect(
      resolveStructuredInput(
        subtaskSpec(),
        ['message', 'send', '--to', 'parent', '--body', '--file'],
        deps('{}'),
      ),
    ).toBeUndefined();
  });

  it('accepts a repeated documented subcommand token', () => {
    const out = resolveStructuredInput(subtaskSpec(), ['subtask', 'create', '--file', '/x.json'], {
      readStdin: () => '',
      readFile: () => '{"title":"Piece"}',
    });
    expect(out?.argv).toEqual(['subtask', 'create', '--title', 'Piece']);
  });

  it('accepts the documented `message send --file` form', () => {
    const out = resolveStructuredInput(
      getCommandSpec('message')!,
      ['message', 'send', '--file', '/x.json'],
      { readStdin: () => '', readFile: () => '{"to":"parent","body":"hi"}' },
    );
    expect(out?.argv).toEqual(['message', 'send', '--to', 'parent', '--body', 'hi']);
  });

  it('refuses a positional mixed with --file instead of silently dropping it', () => {
    expect(() =>
      resolveStructuredInput(subtaskSpec(), ['subtask', '--file', '/x.json', 'extra'], {
        readStdin: () => '',
        readFile: () => '{"title":"Piece"}',
      }),
    ).toThrow(/cannot be combined with 'extra'/);
  });

  it('refuses another flag mixed with --file with a clear message', () => {
    expect(() =>
      resolveStructuredInput(
        subtaskSpec(),
        ['subtask', '--file', '/x.json', '--session', 'S1'],
        { readStdin: () => '', readFile: () => '{"title":"Piece"}' },
      ),
    ).toThrow(/structured input cannot be combined with '--session'/);
  });

  it('bounds a --file read instead of loading the whole file', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'karst-cli-big-')), 'big.json');
    try {
      writeFileSync(file, 'x'.repeat(MAX_STRUCTURED_INPUT_BYTES + 1));
      expect(() =>
        resolveStructuredInput(subtaskSpec(), ['subtask', '--file', file], { readStdin: () => '' }),
      ).toThrow(/too large/);
    } finally {
      rmSync(file, { force: true });
    }
  });
});

describe('structured input through runCli', () => {
  let dir: string;
  let dbPath: string;
  let store: Store;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'karst-cli-input-'));
    dbPath = join(dir, 'karst.db');
    store = openStore(dbPath);
    createTicket(store, { key: 'K-1', title: 'parent' });
    store.close();
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('creates a sub-task from --file JSON', () => {
    const file = join(dir, 'input.json');
    writeFileSync(file, JSON.stringify({ title: 'From file' }));
    const out = JSON.parse(
      runCli(
        ['subtask', '--file', file, '--db', dbPath, '--ticket', 'K-1'],
        {},
        { readStdin: () => '' },
      ),
    );
    expect(out.ok).toBe(true);
    expect(out.title).toBe('From file');
  });

  it('reads a context request from --file', () => {
    const file = join(dir, 'ctx.json');
    writeFileSync(file, JSON.stringify({ key: 'K-1', format: 'md' }));
    const out = runCli(['context', '--file', file, '--db', dbPath], {}, { readStdin: () => '' });
    expect(out).toContain('# ');
    expect(out).toContain('parent');
  });

  it('rejects a malformed payload with a non-zero-style error', () => {
    expect(() =>
      runCli(['subtask', '--stdin', '--db', dbPath, '--ticket', 'K-1'], {}, { readStdin: () => '{}' }),
    ).toThrow(/subtask: invalid input/);
  });

  it('does not repeat the karst: prefix (the wrapper adds it once)', () => {
    try {
      runCli(['subtask', '--stdin', '--db', dbPath, '--ticket', 'K-1'], {}, { readStdin: () => '{}' });
      expect.unreachable('expected a validation error');
    } catch (e) {
      expect((e as Error).message).toMatch(/^subtask:/);
      expect((e as Error).message).not.toMatch(/^karst /);
    }
  });

  it('refuses a positional alongside --file instead of silently dropping it', () => {
    const file = join(dir, 'ctx2.json');
    writeFileSync(file, JSON.stringify({ key: 'K-1' }));
    expect(() =>
      runCli(['context', 'WRONGKEY-999', '--file', file, '--db', dbPath], {}, { readStdin: () => '' }),
    ).toThrow(/cannot be combined/);
  });

  it('accepts a schema-valid empty repos list', () => {
    const file = join(dir, 'empty-repos.json');
    writeFileSync(file, JSON.stringify({ title: 'Empty repos', repos: [] }));
    const out = JSON.parse(
      runCli(['subtask', '--file', file, '--db', dbPath, '--ticket', 'K-1'], {}, { readStdin: () => '' }),
    );
    expect(out.ok).toBe(true);
  });

  it('rejects a non-string value in env set (no "[object Object]" in the store)', () => {
    expect(() =>
      runCli(['env', '--stdin', '--db', dbPath, '--ticket', 'K-1'], {}, {
        readStdin: () =>
          JSON.stringify({ action: 'set', service: 'app', set: { NESTED: { a: 1 } } }),
      }),
    ).toThrow(/env: invalid input.*NESTED/);
  });

  it('accepts string env set values', () => {
    const out = JSON.parse(
      runCli(['env', '--stdin', '--db', dbPath, '--ticket', 'K-1'], {}, {
        readStdin: () => JSON.stringify({ action: 'set', service: 'app', set: { A: '1' } }),
      }),
    );
    expect(out.ok).toBe(true);
  });

  it('accepts an env set key that collides with Object.prototype', () => {
    const out = JSON.parse(
      runCli(['env', '--stdin', '--db', dbPath, '--ticket', 'K-1'], {}, {
        readStdin: () =>
          JSON.stringify({ action: 'set', service: 'app', set: { constructor: 'v' } }),
      }),
    );
    expect(out.ok).toBe(true);
    expect(out.set).toContain('constructor');
  });

  it('names the correct draft subcommand when a global is passed', () => {
    expect(() => runCli(['draft', 'list', '--db', dbPath], {}, { readStdin: () => '' })).toThrow(
      /draft list takes no arguments/,
    );
    expect(() =>
      runCli(['draft', 'propose', '--db', dbPath], { KARST_OUTBOX: dir }, { readStdin: () => '' }),
    ).toThrow(/draft propose takes no arguments/);
  });

  it('keeps a flag value that is literally --file (no structured hijack)', () => {
    const out = JSON.parse(
      runCli(
        ['subtask', 'create', '--title', '--file', '--db', dbPath, '--ticket', 'K-1'],
        {},
        { readStdin: () => '' },
      ),
    );
    expect(out.ok).toBe(true);
    expect(out.title).toBe('--file');
  });

  it('draft --file still refuses the globals the plain path refuses', () => {
    const outbox = mkdtempSync(join(tmpdir(), 'karst-cli-draft-'));
    const file = join(outbox, 'p.json');
    writeFileSync(file, JSON.stringify({ title: 'T', description: 'd', summary: 's', repos: [] }));
    try {
      for (const extra of [
        ['--db', join(outbox, 'x.db')],
        ['--manifest', join(outbox, 'k.yml')],
        ['--ticket', 'K-1'],
        ['--session', 'S1'],
      ]) {
        expect(() =>
          runCli(
            ['draft', '--file', file, ...extra],
            { KARST_OUTBOX: outbox },
            { readStdin: () => '', timeoutMs: 0 },
          ),
        ).toThrow(/draft/);
      }
    } finally {
      rmSync(outbox, { recursive: true, force: true });
    }
  });

  it('accepts the documented `draft propose --file` form', () => {
    const outbox = mkdtempSync(join(tmpdir(), 'karst-cli-draft-ok-'));
    const file = join(outbox, 'p.json');
    writeFileSync(file, JSON.stringify({ title: 'T', description: 'd', summary: 's', repos: [] }));
    try {
      const out = JSON.parse(
        runCli(
          ['draft', 'propose', '--file', file],
          { KARST_OUTBOX: outbox },
          { readStdin: () => '', timeoutMs: 0 },
        ),
      );
      expect(out.ok).toBe(true);
    } finally {
      rmSync(outbox, { recursive: true, force: true });
    }
  });
});
