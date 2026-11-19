import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readEditOps } from '../../setup/editOps.js';
import { readdirSync, readFileSync } from 'node:fs';
import { findEditTool } from './tools.js';
import { buildEdits } from './build.js';
import { assertSetupSession, isEditTool, listEdits, runEditTool } from './command.js';
import type { EditCommandDeps } from './command.js';

const MANIFEST = `id: demo
host: 127.0.0.1
portRange: [4000, 4100]
baselineBranch: develop
repositories:
  web:
    repoPath: .
    enabled: true
`;

let dir: string;
let outbox: string;
let manifestPath: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'edit-cmd-'));
  outbox = join(dir, 'outbox');
  mkdirSync(outbox);
  manifestPath = join(dir, 'karst.yml');
  writeFileSync(manifestPath, MANIFEST);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const deps = (input: unknown, extra: Partial<EditCommandDeps> = {}): EditCommandDeps => ({
  outboxEnv: outbox,
  sessionEnv: 's1',
  manifestPath,
  readStdin: () => JSON.stringify(input),
  scaffold: () => undefined,
  ...extra,
});

describe('setup edit tools (CLI)', () => {
  it('knows the generated tool names', () => {
    expect(isEditTool('set-general')).toBe(true);
    expect(isEditTool('add-repo')).toBe(true);
    expect(isEditTool('propose')).toBe(false);
    expect(isEditTool(undefined)).toBe(false);
  });

  it('refuses a tool outside a setup session', () => {
    expect(() => runEditTool('set-general', [], deps({}, { sessionEnv: undefined }))).toThrow(/only in a setup session/);
    expect(() => assertSetupSession({ KARST_SETUP_SESSION: '' }, 'x')).toThrow(/only in a setup session/);
    expect(() => assertSetupSession({ KARST_SETUP_SESSION: 'a' }, 'x')).not.toThrow();
  });

  it('appends an op and reports the changes', () => {
    const out = JSON.parse(runEditTool('set-general', [], deps({ baselineBranch: 'main' })));
    expect(out.ok).toBe(true);
    expect(out.edits).toBe(1);
    expect(out.changes.join('\n')).toMatch(/baselineBranch/);
    expect(readEditOps(outbox)).toHaveLength(1);
    expect(listEdits(outbox).map((e) => e.tool)).toEqual(['set-general']);
  });

  it('returns a schema error at once and writes no op', () => {
    const out = JSON.parse(runEditTool('set-general', [], deps({ portRange: 'x' })));
    expect(out.ok).toBe(false);
    expect(out.field).toBe('portRange');
    expect(readEditOps(outbox)).toEqual([]);
  });

  it('rejects a key that is not a field of the section', () => {
    const out = JSON.parse(runEditTool('set-general', [], deps({ nope: 1 })));
    expect(out).toMatchObject({ ok: false, field: 'nope' });
  });

  it('rejects an input that is not an object, and invalid JSON', () => {
    expect(JSON.parse(runEditTool('remove-repo', [], deps([])))).toMatchObject({ ok: false, field: '$' });
    expect(() => runEditTool('set-git', [], deps(null, { readStdin: () => '{bad' }))).toThrow(/not one JSON object/);
  });

  it('checks a repository tool against its schema', () => {
    const out = JSON.parse(runEditTool('remove-repo', [], deps({})));
    expect(out.ok).toBe(false);
  });

  it('returns the loader message for a bad edit', () => {
    const out = JSON.parse(runEditTool('set-service', [], deps({ repo: 'web', patch: { start: 'x', ports: [{ name: 'http', env: 'PORT', default: 3000 }], dependsOn: [{ target: 'apii', port: 'http', bind: [{ env: 'API_URL', template: 'http://{host}:{port}' }] }] } })));
    expect(out.ok).toBe(false);
    expect(out.reason).toMatch(/apii/);
  });

  it('takes the item code of fix as a positional argument', () => {
    const out = JSON.parse(runEditTool('fix', ['nope'], deps({})));
    expect(out).toMatchObject({ ok: false, field: 'code' });
    expect(() => runEditTool('fix', ['a', 'b'], deps({}))).toThrow(/one item code only/);
  });

  it('reads the input from --file and refuses an unknown argument', () => {
    const out = JSON.parse(runEditTool('set-general', ['--file', 'in.json'], deps({}, { readFile: () => '{"debug":true}' })));
    expect(out.ok).toBe(true);
    expect(() => runEditTool('set-general', ['--x'], deps({}))).toThrow(/unknown argument/);
    expect(() => runEditTool('set-general', ['--file'], deps({}))).toThrow(/needs a path/);
  });

  it('notes the scaffold write when karst.yml does not exist', () => {
    const out = JSON.parse(
      runEditTool('set-general', [], deps({ debug: true }, { manifestPath: join(dir, 'none.yml'), scaffoldText: () => MANIFEST })),
    );
    expect(out.ok).toBe(true);
    expect(out.note).toMatch(/comments/);
  });
});

describe('setup run and write-file tools (host proposals)', () => {
  const files = (): string[] => readdirSync(outbox).filter((n) => n.endsWith('.json'));
  const written = (): unknown => JSON.parse(readFileSync(join(outbox, files()[0]!), 'utf8'));

  it('knows both tools, with a schema each', () => {
    expect(isEditTool('run')).toBe(true);
    expect(isEditTool('write-file')).toBe(true);
    expect(findEditTool('run')!.inputSchema.required).toEqual(['purpose', 'command']);
    expect(findEditTool('write-file')!.inputSchema.required).toEqual(['repo', 'path', 'content']);
  });

  it('writes a run proposal to the outbox, not an edit op', () => {
    const input = { repo: 'web', purpose: 'install-deps', command: 'npm ci' };
    const out = JSON.parse(runEditTool('run', [], deps(input)));
    expect(out).toMatchObject({ ok: true, kind: 'run', status: 'pending' });
    expect(written()).toEqual({ kind: 'run', ...input });
    expect(readEditOps(outbox)).toEqual([]);
  });

  it('writes a write-file proposal with the content byte for byte', () => {
    const input = { repo: 'web', path: 'a/.env.example', content: 'A=1\r\n' };
    expect(JSON.parse(runEditTool('write-file', [], deps(input)))).toMatchObject({ ok: true, kind: 'write-file' });
    expect(written()).toEqual({ kind: 'write-file', ...input });
  });

  it.each([
    ['run', { purpose: 'install-deps', command: 'npm ci' }, 'repo or a path'],
    ['run', { repo: 'web', purpose: 'deploy', command: 'x' }, 'purpose'],
    ['run', { repo: 'web', purpose: 'other' }, 'command'],
    ['write-file', { repo: 'web', path: '.karst/karst.yml', content: 'x' }, '.karst'],
    ['write-file', { repo: 'web', path: '../x', content: 'x' }, 'path'],
    ['write-file', { repo: 'web', path: '/etc/x', content: 'x' }, 'path'],
  ])('refuses a bad %s input %j and writes nothing', (tool, input, word) => {
    const out = JSON.parse(runEditTool(tool, [], deps(input)));
    expect(out.ok).toBe(false);
    expect(`${out.field ?? ''} ${out.reason}`).toContain(word);
    expect(files()).toEqual([]);
  });

  it('refuses both tools outside a setup session', () => {
    expect(() => runEditTool('run', [], deps({}, { sessionEnv: undefined }))).toThrow(/only in a setup session/);
  });

  it('keeps both tools out of an edit list', () => {
    const op = { id: 'o1', tool: 'run', input: { repo: 'web', purpose: 'other', command: 'ls' } };
    const built = buildEdits(MANIFEST, [op], { firstSetup: false }, (text) => ({ ok: true, manifest: {} as never, codedWarnings: [], text } as never));
    expect(built.ok).toBe(false);
    if (!built.ok) expect(built.reason).toContain('host proposal');
  });
});
