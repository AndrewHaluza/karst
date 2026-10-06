import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, realpathSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MAX_PROPOSAL_BYTES } from '../planning/proposal.js';
import { runDraftCommand } from './draftCommand.js';

const proposal = { title: 'Add auth', description: 'JWT', summary: 'Decided JWT', repos: ['api'] };

describe('draft propose', () => {
  let dir: string;
  let outbox: string;
  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'karst-propose-')));
    outbox = join(dir, 'outbox');
    mkdirSync(outbox);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const run = (argv: string[], stdin: string, env: string | null = outbox): string =>
    runDraftCommand(argv, { outboxEnv: env ?? undefined, readStdin: () => stdin });

  it('writes one uuid-named proposal file atomically and prints its path', () => {
    const out = JSON.parse(run(['draft', 'propose'], JSON.stringify(proposal)));
    const files = readdirSync(outbox);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^[0-9a-f-]{36}\.json$/);
    expect(out).toEqual({ ok: true, file: join(outbox, files[0]!) });
    expect(JSON.parse(readFileSync(out.file, 'utf8'))).toEqual(proposal);
  });

  it('writes the validated (control-stripped) value', () => {
    run(['draft', 'propose'], JSON.stringify({ ...proposal, title: 'A‮b' }));
    const file = readdirSync(outbox)[0]!;
    expect(JSON.parse(readFileSync(join(outbox, file), 'utf8')).title).toBe('Ab');
  });

  it.each([
    [['draft', 'create']],
    [['draft', 'propose', '--db', '/x.db']],
    [['draft', 'propose', '--manifest', '/k.yml']],
    [['draft', 'propose', '--session', '1']],
    [['draft', 'propose', 'extra']],
  ])('rejects argv %j', (argv) => {
    expect(() => run(argv, JSON.stringify(proposal))).toThrow(/draft propose/);
    expect(readdirSync(outbox)).toEqual([]);
  });

  it('requires KARST_OUTBOX naming a real directory', () => {
    expect(() => run(['draft', 'propose'], JSON.stringify(proposal), null)).toThrow(/KARST_OUTBOX/);
    expect(() => run(['draft', 'propose'], JSON.stringify(proposal), join(dir, 'nope'))).toThrow(/KARST_OUTBOX/);
    writeFileSync(join(dir, 'file'), '');
    expect(() => run(['draft', 'propose'], JSON.stringify(proposal), join(dir, 'file'))).toThrow(/KARST_OUTBOX/);
  });

  it('writes through the realpath of a symlinked outbox', () => {
    symlinkSync(outbox, join(dir, 'link'));
    const out = JSON.parse(run(['draft', 'propose'], JSON.stringify(proposal), join(dir, 'link')));
    expect(out.file.startsWith(outbox)).toBe(true);
  });

  it('rejects invalid JSON, oversized input and an invalid proposal, writing nothing', () => {
    expect(() => run(['draft', 'propose'], '{nope')).toThrow(/JSON/);
    expect(() => run(['draft', 'propose'], 'x'.repeat(MAX_PROPOSAL_BYTES + 1))).toThrow(/too large/);
    expect(() => run(['draft', 'propose'], JSON.stringify({ ...proposal, extra: 1 }))).toThrow(/keys/);
    expect(readdirSync(outbox)).toEqual([]);
  });
});
