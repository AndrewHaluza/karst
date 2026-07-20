import type { Store } from './db.js';

/**
 * The `projects` registry (§ projects / multi-window). One row per workspace
 * Karst drives; `tickets.project_id` points here so two IDE windows sharing the
 * global DB each see only their own board.
 *
 * Identity is the `slug` (from the manifest's `id:`, else path-derived — see
 * `project/slug.ts`), never the row id and never the path: a project that moves
 * on disk must stay the same project, or its tickets orphan.
 */

export interface Project {
  id: number;
  slug: string;
  name: string | null;
  /** Last-known workspace root. Advisory (display/diagnostics) — never an identity key. */
  rootPath: string | null;
}

interface ProjectRow {
  id: number;
  slug: string;
  name: string | null;
  root_path: string | null;
}

function rowToProject(r: ProjectRow): Project {
  return { id: r.id, slug: r.slug, name: r.name, rootPath: r.root_path };
}

/** Find a project by its slug, or `undefined` when none matches. */
export function getProjectBySlug(store: Store, slug: string): Project | undefined {
  const row = store.db.prepare('SELECT * FROM projects WHERE slug = ?').get(slug) as
    | ProjectRow
    | undefined;
  return row ? rowToProject(row) : undefined;
}

/** Every known project, oldest first. Backs an "all projects" view. */
export function listProjects(store: Store): Project[] {
  const rows = store.db.prepare('SELECT * FROM projects ORDER BY id').all() as ProjectRow[];
  return rows.map(rowToProject);
}

/**
 * Bind this window to its project: create the row on first sight, else refresh
 * the advisory `name`/`root_path` and return the existing one.
 *
 * `ON CONFLICT(slug)` keeps it a single statement, so two windows activating at
 * the same moment can't both insert — the UNIQUE constraint arbitrates and the
 * loser updates instead. Returns the row either way, so the caller always has
 * a project id without a second round trip.
 */
export function upsertProject(
  store: Store,
  input: { slug: string; name?: string | null; rootPath?: string | null },
): Project {
  store.db
    .prepare(
      `INSERT INTO projects (slug, name, root_path) VALUES (?, ?, ?)
       ON CONFLICT(slug) DO UPDATE SET name = excluded.name, root_path = excluded.root_path`,
    )
    .run(input.slug, input.name ?? null, input.rootPath ?? null);

  const project = getProjectBySlug(store, input.slug);
  if (!project) throw new Error(`project "${input.slug}" vanished after upsert`);
  return project;
}

/** How many tickets predate project scoping (or lost their project). */
export function countUnassignedTickets(store: Store): number {
  const row = store.db
    .prepare('SELECT COUNT(*) AS n FROM tickets WHERE project_id IS NULL')
    .get() as { n: number };
  return row.n;
}

/**
 * Claim every project-less ticket for `projectId`; returns how many moved.
 *
 * This is the v6 migration's second half, deliberately deferred out of
 * `migrate()`: the DB has no way to know which project a legacy ticket belongs
 * to, but the first window to bind does — and while upgrading, exactly one
 * project exists, so adopting all of them is right. `WHERE project_id IS NULL`
 * makes it safe to run repeatedly and impossible to steal another project's
 * tickets. The caller gates it to one shot per install anyway.
 */
export function adoptUnassignedTickets(store: Store, projectId: number): number {
  const info = store.db
    .prepare('UPDATE tickets SET project_id = ? WHERE project_id IS NULL')
    .run(projectId);
  return info.changes;
}
