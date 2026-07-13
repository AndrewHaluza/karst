import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openStore, type Store } from '../store/db.js';
import { createTicket, updateTicketOnboarding } from '../store/tickets.js';
import { parseContextArgs, runContextCommand, composeContextCommand } from './context.js';
import type { Manifest } from '../manifest/types.js';

const MANIFEST: Manifest = {
  host: 'localhost',
  portRange: [3000, 3999],
  baselineBranch: 'main',
  services: {
    frontend: {
      repoPath: '/repos/frontend',
      start: 'npm run dev',
      ports: [{ name: 'port', env: 'PORT', default: 3000 }],
      dependsOn: [],
      hasMigrations: false,
    },
  },
};

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
    expect(parsed.services[0].name).toBe('frontend');
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
});
