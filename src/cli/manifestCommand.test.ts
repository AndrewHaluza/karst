import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, mkdirSync, realpathSync, readdirSync } from 'node:fs';
import { loadManifestWithDiagnostics } from '../manifest/load.js';
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
    expect(out).toEqual({ ok: true, kind: 'manifest', id: 'fixed', file: join(realpathSync(outbox), 'fixed.json'), wouldDrop: [] });
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

describe('manifest show --active', () => {
  const yml = '# top comment\nid: p\n# why\nhost: 127.0.0.1\nrepositories:\n  web:\n    repoPath: /w/web # inline\n';

  it('prints the active manifest without comments', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mshow-'));
    const file = join(dir, 'karst.yml');
    writeFileSync(file, yml);
    const out = runManifestCommand(['manifest', 'show', '--active'], { manifestPath: file });
    expect(out).not.toContain('#');
    expect(out).toContain('id: p');
    expect(out).toContain('repoPath: /w/web');
    rmSync(dir, { recursive: true, force: true });
  });

  it('needs --active', () => {
    expect(() => runManifestCommand(['manifest', 'show'], { manifestPath: '/x' })).toThrow(/--active/);
  });

  it('says there is no active manifest when the file is missing or no path is given', () => {
    expect(() => runManifestCommand(['manifest', 'show', '--active'], { manifestPath: '/nope/karst.yml' })).toThrow(/no active manifest/);
    expect(() => runManifestCommand(['manifest', 'show', '--active'], {})).toThrow(/--manifest/);
  });
});

describe('manifest validate/propose against the current manifest', () => {
  const CURRENT = `${VALID}archiveDoneAfterDays: 3\n`;
  const REVIEW_ONLY = `${VALID}archiveDoneAfterDays: 9\n`;
  const REPO_AND_PROTECTED = REVIEW_ONLY.replace('  docs:\n    repoPath: ../docs\n', '  docs:\n    repoPath: ../docs\n  api:\n    repoPath: ../api\n');

  function setup(): { manifestPath: string; outbox: string } {
    const manifestPath = join(dir, 'current.yml');
    writeFileSync(manifestPath, CURRENT);
    const outbox = join(dir, 'ob');
    mkdirSync(outbox, { recursive: true });
    return { manifestPath, outbox };
  }

  it('validate prints wouldDrop', () => {
    const { manifestPath } = setup();
    const out = JSON.parse(
      runManifestCommand(['manifest', 'validate', '--file', writeYaml(REVIEW_ONLY)], { manifestPath, scaffold: () => undefined }),
    );
    expect(out.wouldDrop).toEqual(['archiveDoneAfterDays']);
  });

  it('refuses a draft that changes only protected fields on a non-scaffold manifest, queuing nothing', () => {
    const { manifestPath, outbox } = setup();
    expect(() =>
      runManifestCommand(['manifest', 'propose', '--file', writeYaml(REVIEW_ONLY)], {
        manifestPath,
        outboxEnv: outbox,
        scaffold: () => undefined,
      }),
    ).toThrow(/archiveDoneAfterDays.*Settings/);
    expect(readdirSync(outbox)).toEqual([]);
  });

  it('refuses a draft with no difference at all', () => {
    const { manifestPath, outbox } = setup();
    expect(() =>
      runManifestCommand(['manifest', 'propose', '--file', writeYaml(CURRENT)], {
        manifestPath,
        outboxEnv: outbox,
        scaffold: () => undefined,
      }),
    ).toThrow(/no difference/);
    expect(readdirSync(outbox)).toEqual([]);
  });

  it('passes the same draft when the current manifest is the unedited scaffold', () => {
    const { manifestPath, outbox } = setup();
    const out = JSON.parse(
      runManifestCommand(['manifest', 'propose', '--file', writeYaml(REVIEW_ONLY)], {
        manifestPath,
        outboxEnv: outbox,
        uuid: () => 'fixed',
        scaffold: () => loadManifestWithDiagnostics(manifestPath).manifest,
      }),
    );
    expect(out.ok).toBe(true);
    expect(out.wouldDrop).toEqual([]);
  });

  it('queues a draft with a repository change and a protected change, printing wouldDrop', () => {
    const { manifestPath, outbox } = setup();
    const out = JSON.parse(
      runManifestCommand(['manifest', 'propose', '--file', writeYaml(REPO_AND_PROTECTED)], {
        manifestPath,
        outboxEnv: outbox,
        uuid: () => 'fixed',
        scaffold: () => undefined,
      }),
    );
    expect(out.ok).toBe(true);
    expect(out.wouldDrop).toEqual(['archiveDoneAfterDays']);
    expect(readdirSync(outbox)).toEqual(['fixed.json']);
  });
});
