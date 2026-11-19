import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readEditOps } from '../../setup/editOps.js';
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
