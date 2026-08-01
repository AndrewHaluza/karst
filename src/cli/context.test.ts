import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { openStore, type Store } from '../store/db.js';
import { createTicket, updateTicketOnboarding } from '../store/tickets.js';
import { insertAttachment } from '../store/attachments.js';
import { upsertProject } from '../store/projects.js';
import { parseContextArgs, runContextCommand, composeContextCommand } from './context.js';
import type { Manifest } from '../manifest/types.js';
import { manifest as buildManifest, runnableRepo, slot } from '../manifest/fixtures.js';

const MANIFEST: Manifest = buildManifest(
  {
    frontend: runnableRepo(
      { ports: [slot('port', 'PORT', 3000)] },
      { repoPath: '/repos/frontend' },
    ),
  },
  { portRange: [3000, 3999], baselineBranch: 'main' },
);

describe('parseContextArgs', () => {
  it('parses a bare key, defaulting to json', () => {
    expect(parseContextArgs(['context', 'PROJ-9'])).toEqual({ key: 'PROJ-9', format: 'json' });
  });

  it('honors --md and --json', () => {
    expect(parseContextArgs(['context', 'PROJ-9', '--md']).format).toBe('md');
    expect(parseContextArgs(['context', 'PROJ-9', '--json']).format).toBe('json');
  });

  it('throws on the wrong command', () => {
    expect(() => parseContextArgs(['stage', 'PROJ-9'])).toThrow(/context/);
  });

  it('throws when the key is missing', () => {
    expect(() => parseContextArgs(['context'])).toThrow(/key/);
  });
});

describe('composeContextCommand', () => {
  it('quotes paths and includes the manifest when given', () => {
    expect(
      composeContextCommand('/ext/dist/cli/main.js', '/store/karst.db', '/repo/.karst/karst.yml'),
    ).toBe('node "/ext/dist/cli/main.js" context --db "/store/karst.db" --manifest "/repo/.karst/karst.yml"');
  });

  it('omits the manifest flag when no path is given', () => {
    expect(composeContextCommand('/a b/cli.js', '/c d/x.db')).toBe(
      'node "/a b/cli.js" context --db "/c d/x.db"',
    );
  });
});

describe('runContextCommand', () => {
  let store: Store;
  beforeEach(() => (store = openStore(':memory:')));
  afterEach(() => store.close());

  function seed(): void {
    const t = createTicket(store, { key: 'PROJ-9', title: 'Do research' });
    updateTicketOnboarding(store, t.id, {
      description: 'Audit the app',
      selectedRepos: ['frontend'],
    });
  }

  it('renders json by default with the aggregated shape', () => {
    seed();
    const out = runContextCommand(store, MANIFEST, { key: 'PROJ-9', format: 'json' });
    const parsed = JSON.parse(out);
    expect(parsed.key).toBe('PROJ-9');
    expect(parsed.prompt).toBe('Audit the app');
    expect(parsed.repos[0].name).toBe('frontend');
  });

  it('renders markdown when asked', () => {
    seed();
    const out = runContextCommand(store, MANIFEST, { key: 'PROJ-9', format: 'md' });
    expect(out).toContain('# Ticket: PROJ-9 — Do research');
    expect(out).toContain('## Prompt\nAudit the app');
  });

  it('throws a clear error for an unknown key', () => {
    expect(() => runContextCommand(store, MANIFEST, { key: 'NOPE-1', format: 'json' })).toThrow(
      /NOPE-1/,
    );
  });

  it('renders attachments with paths rooted beside the registry file', () => {
    const ticketId = createTicket(store, { key: 'K-1', title: 'has media' }).id;
    insertAttachment(store, {
      ticketId,
      kind: 'image',
      storedName: 'aaaa1111bbbb2222.png',
      originalName: 'shot.png',
      byteSize: 12,
    });

    const md = runContextCommand(
      store,
      undefined,
      { key: 'K-1', format: 'md' },
      '/storage/karst.db',
    );
    expect(md).toContain('## Attachments');
    expect(md).toContain(
      join('/storage', 'attachments', String(ticketId), 'aaaa1111bbbb2222.png'),
    );
  });

  it('omits attachments when no db path is supplied', () => {
    const ticketId = createTicket(store, { key: 'K-2', title: 'has media' }).id;
    insertAttachment(store, {
      ticketId,
      kind: 'image',
      storedName: 'aaaa.png',
      originalName: 'a.png',
      byteSize: 1,
    });

    expect(runContextCommand(store, undefined, { key: 'K-2', format: 'md' })).not.toContain(
      '## Attachments',
    );
  });

  /**
   * The CLI is handed the same key from any project's session. Once two projects
   * can share a key, the manifest's `id` is what disambiguates them.
   */
  describe('project scoping', () => {
    it('resolves the ticket belonging to the manifest\'s project', () => {
      const mine = upsertProject(store, { slug: 'mine', name: 'mine', rootPath: '/w/mine' });
      const theirs = upsertProject(store, { slug: 'theirs', name: 'theirs', rootPath: '/w/t' });
      createTicket(store, { key: 'SHARED-1', title: 'theirs', projectId: theirs.id });
      createTicket(store, { key: 'SHARED-1', title: 'mine', projectId: mine.id });

      const out = runContextCommand(store, { ...MANIFEST, id: 'mine' }, {
        key: 'SHARED-1',
        format: 'json',
      });
      expect(JSON.parse(out).title).toBe('mine');
    });

    it('still finds an unadopted legacy ticket when the project has none', () => {
      // A session launched mid-upgrade: the manifest names a project, but the
      // ticket predates scoping. Falling back beats failing.
      upsertProject(store, { slug: 'mine', name: 'mine', rootPath: '/w/mine' });
      createTicket(store, { key: 'OLD-1', title: 'legacy' });

      const out = runContextCommand(store, { ...MANIFEST, id: 'mine' }, {
        key: 'OLD-1',
        format: 'json',
      });
      expect(JSON.parse(out).title).toBe('legacy');
    });

    it('falls back to an unscoped lookup when the manifest has no id', () => {
      seed();
      const out = runContextCommand(store, MANIFEST, { key: 'PROJ-9', format: 'json' });
      expect(JSON.parse(out).key).toBe('PROJ-9');
    });
  });
});
