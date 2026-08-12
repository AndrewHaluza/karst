import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseGlobalFlags, runCli } from './main.js';
import { openStore, type Store } from '../store/db.js';
import { createTicket, getTicket, setAgentState } from '../store/tickets.js';
import { insertAttachment } from '../store/attachments.js';
import { transition } from '../workflow/machine.js';

describe('parseGlobalFlags', () => {
  it('extracts --db and --manifest, leaving the subcommand argv', () => {
    const g = parseGlobalFlags(['context', 'PROJ-9', '--db', '/x.db', '--manifest', '/k.yml', '--md']);
    expect(g.db).toBe('/x.db');
    expect(g.manifest).toBe('/k.yml');
    expect(g.rest).toEqual(['context', 'PROJ-9', '--md']);
  });

  it('extracts --ticket for the stage marker', () => {
    const g = parseGlobalFlags(['stage', 'impl', 'pass', '--db', '/x.db', '--ticket', 'K-1']);
    expect(g.db).toBe('/x.db');
    expect(g.ticket).toBe('K-1');
    expect(g.rest).toEqual(['stage', 'impl', 'pass']);
  });

  it('leaves flags absent when not given', () => {
    const g = parseGlobalFlags(['context', 'PROJ-9']);
    expect(g.db).toBeUndefined();
    expect(g.manifest).toBeUndefined();
    expect(g.ticket).toBeUndefined();
    expect(g.rest).toEqual(['context', 'PROJ-9']);
  });
});

describe('runCli — stage marker', () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'karst-cli-'));
    dbPath = join(dir, 'karst.db');
    const seed = openStore(dbPath);
    createTicket(seed, { key: 'K-1', title: 'demo' });
    transition(seed, 1, 'scope', { kind: 'passed' }); // -> impl
    seed.close();
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('advances impl->uat by ticket key and prints the next stage', () => {
    const out = runCli(['stage', 'impl', 'pass', '--db', dbPath, '--ticket', 'K-1']);
    expect(out.trim()).toBe('uat');

    const check: Store = openStore(dbPath);
    const t = getTicket(check, 1);
    expect(t.stages.find((s) => s.stageKey === 'impl')?.status).toBe('passed');
    expect(t.stages.find((s) => s.stageKey === 'uat')?.status).toBe('running');
    check.close();
  });

  it('fails loudly on an unknown ticket key', () => {
    expect(() => runCli(['stage', 'impl', 'pass', '--db', dbPath, '--ticket', 'NOPE'])).toThrow(/NOPE/);
  });

  it('refuses the impl marker while the agent is waiting for user input', () => {
    const seed = openStore(dbPath);
    setAgentState(seed, 1, 'waiting');
    seed.close();

    expect(() => runCli(['stage', 'impl', 'pass', '--db', dbPath, '--ticket', 'K-1'])).toThrow(
      /waiting for|waiting on|asked/i,
    );

    const check: Store = openStore(dbPath);
    const t = getTicket(check, 1);
    expect(t.stageCurrent).toBe('impl');
    expect(t.stages.find((s) => s.stageKey === 'impl')?.status).toBe('running');
    check.close();
  });

  it('requires --ticket for a stage command', () => {
    expect(() => runCli(['stage', 'impl', 'pass', '--db', dbPath])).toThrow(/ticket/);
  });

  it('requires --db', () => {
    expect(() => runCli(['stage', 'impl', 'pass', '--ticket', 'K-1'])).toThrow(/db/);
  });

  it('rejects an unknown subcommand', () => {
    expect(() => runCli(['bogus', '--db', dbPath])).toThrow(/bogus|unknown/);
  });

  it('names every verb it accepts when the subcommand is unknown', () => {
    expect(() => runCli(['bogus', '--db', dbPath])).toThrow(/phase/);
  });
});

describe('runCli — populated attachment context over node:sqlite', () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'karst-cli-attachments-'));
    dbPath = join(dir, 'karst.db');
    const seed = openStore(dbPath);
    const ticket = createTicket(seed, { key: 'MEDIA-1', title: 'has media' });
    insertAttachment(seed, {
      ticketId: ticket.id,
      kind: 'image',
      storedName: 'aaaa1111bbbb2222.png',
      originalName: 'screen.png',
      byteSize: 12,
    });
    insertAttachment(seed, {
      ticketId: ticket.id,
      kind: 'video',
      storedName: 'cccc3333dddd4444.mp4',
      originalName: 'repro.mov',
      byteSize: 34,
    });
    seed.close();
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('renders absolute paths and the video unreadable marker through runCli', () => {
    const parsed = JSON.parse(
      runCli(['context', 'MEDIA-1', '--db', dbPath, '--json']),
    ) as { attachments: Array<{ kind: string; path: string; name: string }> };
    expect(parsed.attachments).toEqual([
      {
        kind: 'image',
        path: join(dir, 'attachments', '1', 'aaaa1111bbbb2222.png'),
        name: 'screen.png',
      },
      {
        kind: 'video',
        path: join(dir, 'attachments', '1', 'cccc3333dddd4444.mp4'),
        name: 'repro.mov',
      },
    ]);

    const markdown = runCli(['context', 'MEDIA-1', '--db', dbPath, '--md']);
    expect(markdown).toContain(
      `- video: ${join(dir, 'attachments', '1', 'cccc3333dddd4444.mp4')} — "repro.mov" (not agent-readable)`,
    );
  });
});

describe('runCli — legacy manifest deprecation warning', () => {
  let dir: string;
  let dbPath: string;
  let legacyManifestPath: string;

  const LEGACY_MANIFEST = `
id: proj
host: localhost
portRange: [4000, 4999]
baselineBranch: develop
services:
  backend:
    repoPath: ../backend
    start: npm run dev
    ports:
      - { name: http, env: PORT, default: 3000 }
`;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'karst-cli-legacy-'));
    dbPath = join(dir, 'karst.db');
    legacyManifestPath = join(dir, 'karst.yml');
    writeFileSync(legacyManifestPath, LEGACY_MANIFEST);
    const seed = openStore(dbPath);
    createTicket(seed, { key: 'K-1', title: 'demo' });
    seed.close();
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('writes the legacy-manifest warning to stderr, prefixed `karst: `, and keeps stdout clean', () => {
    const writeSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const out = runCli(['context', 'K-1', '--db', dbPath, '--manifest', legacyManifestPath]);

      expect(out).not.toMatch(/legacy/i);
      expect(out).not.toMatch(/karst:/);

      const written = writeSpy.mock.calls.map((c) => String(c[0])).join('');
      expect(written).toMatch(/^karst: /m);
      expect(written).toMatch(/legacy `services:` key/);
    } finally {
      writeSpy.mockRestore();
    }
  });

  it('surfaces the warning for the stage marker path too (loadProjectSlug)', () => {
    // Closed, not leaked: the registry file is deleted in afterEach, and Windows
    // refuses to unlink a database another handle still has open.
    const seed = openStore(dbPath);
    transition(seed, 1, 'scope', { kind: 'passed' });
    seed.close();
    const writeSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      runCli(['stage', 'impl', 'pass', '--db', dbPath, '--ticket', 'K-1', '--manifest', legacyManifestPath]);
      const written = writeSpy.mock.calls.map((c) => String(c[0])).join('');
      expect(written).toMatch(/karst: .*legacy `services:` key/);
    } finally {
      writeSpy.mockRestore();
    }
  });

  it('reports no warning for a current (non-legacy) manifest', () => {
    const currentPath = join(dir, 'current.yml');
    writeFileSync(
      currentPath,
      `
id: proj2
host: localhost
portRange: [4000, 4999]
baselineBranch: develop
repositories:
  backend:
    repoPath: ../backend
`,
    );
    const writeSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      runCli(['context', 'K-1', '--db', dbPath, '--manifest', currentPath]);
      const written = writeSpy.mock.calls.map((c) => String(c[0])).join('');
      expect(written).not.toMatch(/legacy/i);
    } finally {
      writeSpy.mockRestore();
    }
  });

  it('writes inert-key notices to stderr, keeping stdout clean JSON', () => {
    const manifestWithInertKeys = join(dir, 'inert.yml');
    writeFileSync(
      manifestWithInertKeys,
      `
id: proj3
host: localhost
portRange: [4000, 4999]
baselineBranch: develop
repositories:
  backend:
    repoPath: ../backend
uat:
  secrets:
    - API_KEY
  origins:
    - http://localhost:3000
`,
    );
    const writeSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const out = runCli(['context', 'K-1', '--db', dbPath, '--manifest', manifestWithInertKeys, '--json']);
      const written = writeSpy.mock.calls.map((c) => String(c[0])).join('');
      expect(written).toContain('uat.secrets');
      expect(written).toContain('not yet active');
      // stdout is consumed by an agent — it must stay parseable.
      expect(() => JSON.parse(out)).not.toThrow();
    } finally {
      writeSpy.mockRestore();
    }
  });
});
