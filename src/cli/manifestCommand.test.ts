import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, mkdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runManifestCommand, parseManifestArgs } from './manifestCommand.js';
import type { ManifestProposal } from '../setup/proposal.js';

const VALID = `
host: localhost
portRange: [4000, 4999]
baselineBranch: main
repositories:
  web:
    repoPath: ../web
    service:
      start: npm run dev
      ports:
        - { name: port, env: PORT, default: 5173 }
      dependsOn: []
  docs:
    repoPath: ../docs
`;

const INVALID = `
host: localhost
portRange: [4000, 4999]
baselineBranch: main
repositories: {}
`;

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'karst-manifest-cmd-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function writeYaml(text: string): string {
  const p = join(dir, 'draft.yml');
  writeFileSync(p, text);
  return p;
}

describe('parseManifestArgs', () => {
  it('parses validate and propose with a file and optional summary', () => {
    expect(parseManifestArgs(['manifest', 'validate', '--file', '/a.yml'])).toEqual({
      sub: 'validate',
      file: '/a.yml',
    });
    expect(parseManifestArgs(['manifest', 'propose', '--file', '/a.yml', '--summary', 'hi'])).toEqual({
      sub: 'propose',
      file: '/a.yml',
      summary: 'hi',
    });
  });

  it('rejects an unknown subcommand, a missing file and unknown args', () => {
    expect(() => parseManifestArgs(['manifest', 'nope'])).toThrow(/unknown subcommand/);
    expect(() => parseManifestArgs(['manifest', 'validate'])).toThrow(/missing --file/);
    expect(() => parseManifestArgs(['manifest', 'validate', '--file', '/a', '--nope'])).toThrow(/unknown argument/);
  });
});

describe('runManifestCommand validate', () => {
  it('validates a draft with the real loader and prints its identity', () => {
    const out = JSON.parse(runManifestCommand(['manifest', 'validate', '--file', writeYaml(VALID)]));
    expect(out.ok).toBe(true);
    expect([...out.repositories].sort()).toEqual(['docs', 'web']);
  });

  it('throws the loader error for an invalid manifest', () => {
    expect(() => runManifestCommand(['manifest', 'validate', '--file', writeYaml(INVALID)])).toThrow(
      /repositories/,
    );
  });
});

describe('runManifestCommand propose', () => {
  it('writes a kind:manifest proposal into KARST_SETUP_OUTBOX', () => {
    const outbox = join(dir, 'outbox');
    mkdirSync(outbox, { recursive: true });

    const file = writeYaml(VALID);
    const out = JSON.parse(
      runManifestCommand(['manifest', 'propose', '--file', file], { outboxEnv: outbox, uuid: () => 'fixed' }),
    );
    expect(out).toEqual({ ok: true, kind: 'manifest', file: join(realpathSync(outbox), 'fixed.json') });
    const written = JSON.parse(readFileSync(join(outbox, 'fixed.json'), 'utf8')) as ManifestProposal;
    expect(written.kind).toBe('manifest');
    expect(written.targetPath).toBe(file);
    expect(written.yaml).toContain('repositories:');
    expect(written.summary).toMatch(/2 repositories, 1 with a service/);
  });

  it('uses a caller-supplied summary', () => {
    const outbox = join(dir, 'outbox2');
    mkdirSync(outbox, { recursive: true });
    runManifestCommand(['manifest', 'propose', '--file', writeYaml(VALID), '--summary', 'mine'], {
      outboxEnv: outbox,
      uuid: () => 'fixed',
    });
    const written = JSON.parse(readFileSync(join(outbox, 'fixed.json'), 'utf8')) as ManifestProposal;
    expect(written.summary).toBe('mine');
  });

  it('refuses to propose without KARST_SETUP_OUTBOX', () => {
    expect(() => runManifestCommand(['manifest', 'propose', '--file', writeYaml(VALID)])).toThrow(
      /KARST_SETUP_OUTBOX/,
    );
  });
});
