import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openStore, type Store } from './db.js';
import {
  upsertProject,
  getProjectBySlug,
  listProjects,
  adoptUnassignedTickets,
  countUnassignedTickets,
} from './projects.js';
import { createTicket } from './tickets.js';

describe('projects store', () => {
  let store: Store;

  beforeEach(() => {
    store = openStore(':memory:');
  });

  afterEach(() => {
    store.close();
  });

  it('creates a project on first upsert', () => {
    const p = upsertProject(store, { slug: 'karst', name: 'Karst', rootPath: '/w/karst' });
    expect(p.id).toBeGreaterThan(0);
    expect(p.slug).toBe('karst');
    expect(p.name).toBe('Karst');
    expect(p.rootPath).toBe('/w/karst');
  });

  it('returns the same row on a second upsert of the same slug', () => {
    const a = upsertProject(store, { slug: 'karst', name: 'Karst', rootPath: '/w/karst' });
    const b = upsertProject(store, { slug: 'karst', name: 'Karst', rootPath: '/w/karst' });
    expect(b.id).toBe(a.id);
    expect(listProjects(store)).toHaveLength(1);
  });

  it('refreshes name and rootPath when the project moves', () => {
    const a = upsertProject(store, { slug: 'karst', name: 'Karst', rootPath: '/old' });
    const b = upsertProject(store, { slug: 'karst', name: 'Karst v2', rootPath: '/new' });
    expect(b.id).toBe(a.id); // identity survives the move — that is the point of the slug
    expect(b.name).toBe('Karst v2');
    expect(b.rootPath).toBe('/new');
  });

  it('keeps distinct slugs as distinct projects', () => {
    upsertProject(store, { slug: 'karst', name: 'Karst', rootPath: '/w/karst' });
    upsertProject(store, { slug: 'other', name: 'Other', rootPath: '/w/other' });
    expect(listProjects(store).map((p) => p.slug).sort()).toEqual(['karst', 'other']);
  });

  it('finds a project by slug, or undefined when unknown', () => {
    upsertProject(store, { slug: 'karst', name: 'Karst', rootPath: '/w/karst' });
    expect(getProjectBySlug(store, 'karst')?.slug).toBe('karst');
    expect(getProjectBySlug(store, 'nope')).toBeUndefined();
  });

  describe('adoptUnassignedTickets', () => {
    it('claims every legacy ticket that has no project', () => {
      createTicket(store, { key: 'A-1', title: 'one' });
      createTicket(store, { key: 'A-2', title: 'two' });
      const p = upsertProject(store, { slug: 'karst', name: 'Karst', rootPath: '/w/karst' });

      expect(countUnassignedTickets(store)).toBe(2);
      expect(adoptUnassignedTickets(store, p.id)).toBe(2);
      expect(countUnassignedTickets(store)).toBe(0);
    });

    it('never steals a ticket already owned by another project', () => {
      const mine = upsertProject(store, { slug: 'mine', name: 'Mine', rootPath: '/w/mine' });
      const theirs = upsertProject(store, { slug: 'theirs', name: 'Theirs', rootPath: '/w/t' });
      const owned = createTicket(store, { key: 'T-1', title: 'owned', projectId: theirs.id });

      expect(adoptUnassignedTickets(store, mine.id)).toBe(0);
      const row = store.db
        .prepare('SELECT project_id FROM tickets WHERE id = ?')
        .get(owned.id) as { project_id: number };
      expect(row.project_id).toBe(theirs.id);
    });

    it('is a no-op when there is nothing to adopt', () => {
      const p = upsertProject(store, { slug: 'karst', name: 'Karst', rootPath: '/w/karst' });
      expect(adoptUnassignedTickets(store, p.id)).toBe(0);
    });
  });
});
