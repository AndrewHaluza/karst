import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runManifestCommand, parseManifestArgs } from './manifestCommand.js';

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
  it('parses validate with a file', () => {
    expect(parseManifestArgs(['manifest', 'validate', '--file', '/a.yml'])).toEqual({ sub: 'validate', file: '/a.yml' });
  });

  it('rejects an unknown subcommand, a missing file and unknown args', () => {
    expect(() => parseManifestArgs(['manifest', 'nope'])).toThrow(/unknown subcommand/);
    expect(() => parseManifestArgs(['manifest', 'validate'])).toThrow(/missing --file/);
    expect(() => parseManifestArgs(['manifest', 'validate', '--file', '/a', '--nope'])).toThrow(/unknown argument/);
  });

  it('no longer knows propose, and its flags', () => {
    expect(() => parseManifestArgs(['manifest', 'propose', '--file', '/a.yml'])).toThrow(/unknown subcommand 'propose'/);
    expect(() => runManifestCommand(['manifest', 'propose', '--file', writeYaml(VALID)])).toThrow(/want 'validate' or 'show'/);
    expect(() => parseManifestArgs(['manifest', 'validate', '--file', '/a', '--summary', 'x'])).toThrow(/unknown argument/);
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

describe('manifest validate against the current manifest', () => {
  const CURRENT = `${VALID}archiveDoneAfterDays: 3\n`;
  const REVIEW_ONLY = `${VALID}archiveDoneAfterDays: 9\n`;

  function current(): string {
    const manifestPath = join(dir, 'current.yml');
    writeFileSync(manifestPath, CURRENT);
    return manifestPath;
  }

  it('prints wouldDrop for a protected change on a non-scaffold manifest', () => {
    const out = JSON.parse(
      runManifestCommand(['manifest', 'validate', '--file', writeYaml(REVIEW_ONLY)], { manifestPath: current(), scaffold: () => undefined }),
    );
    expect(out.wouldDrop).toEqual(['archiveDoneAfterDays']);
  });

  it('prints an empty wouldDrop with no current manifest, or an unreadable one', () => {
    const file = writeYaml(REVIEW_ONLY);
    expect(JSON.parse(runManifestCommand(['manifest', 'validate', '--file', file], {})).wouldDrop).toEqual([]);
    const bad = join(dir, 'bad.yml');
    writeFileSync(bad, 'repositories: 3');
    expect(JSON.parse(runManifestCommand(['manifest', 'validate', '--file', file], { manifestPath: bad })).wouldDrop).toEqual([]);
  });

  it('writes nothing', () => {
    mkdirSync(join(dir, 'ob'));
    runManifestCommand(['manifest', 'validate', '--file', writeYaml(REVIEW_ONLY)], { manifestPath: current(), scaffold: () => undefined });
    expect(readdirSync(join(dir, 'ob'))).toEqual([]);
  });
});
