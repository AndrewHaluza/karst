/**
 * Build the visual sweep's showcase corpus from a Karst SQLite database
 * (T1365).
 *
 * The populated baselines for dashboard, sidebar and usage used to be
 * hand-written state literals (`src/ui/<view>/renderFixtures.ts`). A literal is a
 * second, unverified statement of what `build*State` produces, so the baseline
 * could pin a shape the product can no longer emit. This module removes that
 * drift: it reads a database, calls the SAME production state builders the
 * extension calls, feeds them the host inputs they cannot read themselves
 * (manifest, path context, approach phases, quota), and writes the result as
 * stable JSON after the sanitizer has stripped every private value.
 *
 * Scope is deliberately three views:
 *
 * - `dashboard` — `buildDashboardState`
 * - `sidebar` — `buildSidebarState`
 * - `usage` — `buildUsageState`
 *
 * `diffs` is NOT exported: it inspects git worktrees (`src/ui/diffs/snapshot.ts`)
 * and never reads this database, so there is nothing in SQLite to export.
 *
 * Nothing here imports `better-sqlite3`: the read path is
 * `src/cli/readonlyStore.ts#openReadonlyStore` (`node:sqlite`), per
 * `@arch:CLI-05`. Seeding a corpus database is a separate module
 * (`seedSpec.ts`) exactly so that importing the exporter never drags the
 * Electron-ABI addon in.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Store } from '../../../src/store/db.js';
import { buildDashboardState, type DashboardState } from '../../../src/ui/dashboard/state.js';
import { buildSidebarState, type SidebarState } from '../../../src/ui/sidebar/state.js';
import { buildUsageState, type UsageState } from '../../../src/ui/usage/state.js';
import type { PathContext } from '../../../src/ui/worktreePath.js';
import { manifest, repo } from '../../../src/manifest/fixtures.js';
import type { Manifest } from '../../../src/manifest/types.js';
import type { QuotaSnapshot } from '../../../src/agent/quota/types.js';
import { openReadonlyStore } from '../../../src/cli/readonlyStore.js';
import { installSqliteWarningFilter } from '../../../src/cli/suppressWarning.js';
import { FIXTURE_NOW_MS, CorpusSanitizer, assertNoLeaks } from './sanitize.js';

/** The views this exporter covers, in the order they are always written. */
export const CORPUS_VIEWS = ['dashboard', 'sidebar', 'usage'] as const;
export type CorpusView = (typeof CORPUS_VIEWS)[number];

/** Where the checked-in showcase fixtures live, relative to the repo root. */
export const GENERATED_DIR = 'tests/visual/dbCorpus/generated';

/** The project slug a seeded corpus database registers (`seedSpec.ts`). */
export const CORPUS_PROJECT_SLUG = 'fixture';

/**
 * The workspace the stub manifest describes. Every path is already a fixture
 * path, so the sanitizer has nothing to guess: a path that never names a real
 * machine cannot leak one.
 */
const PROJECT_ROOT = '/fixture/workspace';

/**
 * The stubbed host inputs. The state builders never read the manifest or the
 * filesystem — the host injects those facts — so the exporter supplies a small
 * fixed stack instead of a real workspace.
 */
export const CORPUS_MANIFEST: Manifest = manifest(
  {
    api: repo({ repoPath: '/fixture/workspace/api', hasMigrations: true, signals: ['api', 'server'] }),
    web: repo({ repoPath: '/fixture/workspace/web', signals: ['ui', 'web'] }),
  },
  { id: CORPUS_PROJECT_SLUG, ticketing: { provider: 'manual' } },
);

/** The manifest repository NAME of a recorded repo path, for the host-injected rows. */
function repoNameFor(repoPath: string): string | undefined {
  for (const [name, def] of Object.entries(CORPUS_MANIFEST.repositories)) {
    if (def.repoPath === repoPath) return name;
  }
  return undefined;
}

/** How the sweep renders worktree paths: relative, so no absolute path is needed. */
export const CORPUS_PATH_CONTEXT: PathContext = { display: 'relative', projectRoot: PROJECT_ROOT };

/**
 * A fixed subscription-quota snapshot. The usage view's Quota tab is a host
 * read (the provider answers it, never the ledger), so a fixture pins a shape
 * rather than calling a provider.
 */
export const CORPUS_QUOTA: readonly QuotaSnapshot[] = [
  {
    core: 'claude',
    state: 'ok',
    source: 'Fixture subscription rate limits',
    readAt: new Date(FIXTURE_NOW_MS - 60_000).toISOString(),
    windows: [
      { label: '5-hour', usedPct: 42, resetsAt: new Date(FIXTURE_NOW_MS + 2 * 3_600_000).toISOString() },
      { label: '7-day', usedPct: 68, resetsAt: new Date(FIXTURE_NOW_MS + 4 * 86_400_000).toISOString() },
    ],
  },
  { core: 'codex', state: 'unknown', reason: 'fixture: no readable source' },
];

export interface CorpusOptions {
  /** The ticket the dashboard page shows. Default: the seeded dashboard ticket, else the first id. */
  ticketId?: number;
  /** The project scope. Default: the only project in the database. */
  projectId?: number;
  /** The pinned fixture clock. Default: `FIXTURE_NOW_MS`. */
  nowMs?: number;
}

/** The three built-and-sanitized states, in memory (nothing is written). */
export interface Corpus {
  dashboard: DashboardState;
  sidebar: SidebarState;
  usage: UsageState;
}

/**
 * Replace the global `Date` for the duration of `fn`, so every `nowIso()` and
 * `new Date()` inside a state builder sees the fixture instant.
 *
 * The builders take no clock (their host callers run against the real one), and
 * the relative-age text they compute ("14h ago") is part of what the baseline
 * pins. Without the pin that text is a function of the day the corpus was
 * regenerated, which is exactly the drift T1357 removed from the fixtures.
 */
export function withPinnedClock<T>(nowMs: number, fn: () => T): T {
  const RealDate = Date;
  class PinnedDate extends RealDate {
    constructor(...args: unknown[]) {
      if (args.length === 0) {
        super(nowMs);
      } else {
        // `Date`'s overloads are an implementation detail of the pin: every
        // value form (`Date.parse` output, an ISO string, a Date) must pass
        // through unchanged.
        super(...(args as [number]));
      }
    }

    static override now(): number {
      return nowMs;
    }
  }
  globalThis.Date = PinnedDate as unknown as DateConstructor;
  try {
    return fn();
  } finally {
    globalThis.Date = RealDate;
  }
}

/** The one project in the database, or a clear failure naming what is missing. */
export function resolveProjectId(store: Store, projectId?: number): number {
  if (projectId !== undefined) return projectId;
  const row = store.db.prepare('SELECT id FROM projects ORDER BY id LIMIT 1').get() as
    | { id: number }
    | undefined;
  if (!row) {
    throw new Error(
      'export: the database has no projects row; pass --project or export from a Karst database',
    );
  }
  return row.id;
}

/** The ticket the dashboard page shows: the requested id, else the oldest in the project. */
export function resolveDashboardTicketId(store: Store, projectId: number, ticketId?: number): number {
  if (ticketId !== undefined) return ticketId;
  const row = store.db
    .prepare('SELECT id FROM tickets WHERE project_id = ? ORDER BY id LIMIT 1')
    .get(projectId) as { id: number } | undefined;
  if (!row) {
    throw new Error(`export: project ${projectId} has no tickets to build a dashboard for`);
  }
  return row.id;
}

/**
 * Run `fn` with the process time zone pinned. The dashboard and sidebar render
 * dates through the viewer's zone (they take no `dateOptions`), so a corpus
 * generated on a developer machine and one generated in CI would otherwise
 * disagree on every date label. `buildUsageState` gets the zone explicitly; this
 * covers the other two.
 */
function withPinnedTimeZone<T>(zone: string, fn: () => T): T {
  const previous = process.env.TZ;
  process.env.TZ = zone;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
}

/**
 * Build the three states from an open store and sanitize them as ONE corpus:
 * a repo path seen in the dashboard and again in the sidebar maps to the same
 * fixture path, and every timestamp shifts by the same delta.
 */
export function buildCorpus(store: Store, opts: CorpusOptions = {}): Corpus {
  const nowMs = opts.nowMs ?? FIXTURE_NOW_MS;
  const projectId = resolveProjectId(store, opts.projectId);
  const ticketId = resolveDashboardTicketId(store, projectId, opts.ticketId);

  const raw = withPinnedTimeZone('UTC', () =>
    withPinnedClock(nowMs, () => ({
      dashboard: buildDashboardState(
        store,
        ticketId,
        CORPUS_PATH_CONTEXT,
        { provider: 'manual' },
        // No approach is installed in a fixture stack: the phase list is host data.
        () => [],
        // Both stub repositories are declared runnable.
        (repoPath) => repoNameFor(repoPath) !== undefined,
        undefined,
        {},
        undefined,
        () => [],
        () => null,
        // No action registry: a fixture carries no opaque action ids, and the
        // registry never leaves the host anyway.
        null,
        undefined,
        // Never a real checkout, so no "Launch Dev" affordance is pinned.
        () => false,
        // Recorded repo paths are already fixture paths in the seeded corpus.
        repoNameFor,
      ),
      sidebar: buildSidebarState(
        store,
        {
          facets: ['all'],
          filter: '',
          manifest: CORPUS_MANIFEST,
          projectId,
          activityLimit: 12,
          activeTicketId: ticketId,
        },
        CORPUS_PATH_CONTEXT,
      ),
      usage: buildUsageState(store, {
        projectId,
        quota: CORPUS_QUOTA,
        now: () => new Date(nowMs),
        dateOptions: { locale: 'en-US', timeZone: 'UTC' },
      }),
    })),
  );

  const sanitizer = new CorpusSanitizer({ nowMs });
  sanitizer.registerExternalRefs(externalRefsOf(store));
  sanitizer.collect(raw);
  const cleaned: Corpus = {
    dashboard: sanitizer.apply<DashboardState>(raw.dashboard),
    sidebar: sanitizer.apply<SidebarState>(raw.sidebar),
    usage: sanitizer.apply<UsageState>(raw.usage),
  };
  for (const view of CORPUS_VIEWS) {
    assertNoLeaks(cleaned[view], `export: ${view}`);
    const refs = sanitizer.leftoverRefs(cleaned[view]);
    if (refs.length > 0) {
      throw new Error(`export: ${view}: sanitized output still carries provider ids or logins: ${refs.slice(0, 5).join(', ')}`);
    }
  }
  return cleaned;
}

/**
 * Every provider id the database holds (`source_ref`, `source_ref_internal`),
 * sorted. A provider-sourced ticket's key and its text quote these ids, and
 * they name records on the operator's board, so the sanitizer replaces them.
 */
export function externalRefsOf(store: Store): string[] {
  const rows = store.db
    .prepare(
      `SELECT source_ref AS ref FROM tickets WHERE source_ref IS NOT NULL AND source_ref <> ''
       UNION
       SELECT source_ref_internal AS ref FROM tickets
        WHERE source_ref_internal IS NOT NULL AND source_ref_internal <> ''
       ORDER BY ref`,
    )
    .all() as { ref: unknown }[];
  return rows.map((r) => r.ref).filter((ref): ref is string => typeof ref === 'string');
}

/** Sort object keys recursively so two equal corpora serialize to equal bytes. */
export function stableJson(value: unknown, indent = 2): string {
  const sort = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(sort);
    if (node instanceof Date) return node.toISOString();
    if (typeof node !== 'object' || node === null) return node;
    const record = node as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) out[key] = sort(record[key]);
    return out;
  };
  return `${JSON.stringify(sort(value), null, indent)}\n`;
}

/** The corpus as the files that ship: `{ 'dashboard.json': '<stable JSON>' }`. */
export function corpusFiles(corpus: Corpus): Record<string, string> {
  const files: Record<string, string> = {};
  for (const view of CORPUS_VIEWS) files[`${view}.json`] = stableJson(corpus[view]);
  return files;
}

/** Write the corpus into `outDir` (created when missing); returns the written paths. */
export function writeCorpus(corpus: Corpus, outDir: string): string[] {
  mkdirSync(outDir, { recursive: true });
  const files = corpusFiles(corpus);
  const written: string[] = [];
  for (const view of CORPUS_VIEWS) {
    const path = join(outDir, `${view}.json`);
    writeFileSync(path, files[`${view}.json`]!);
    written.push(path);
  }
  return written;
}

/**
 * The whole read path: open a Karst database read-only with `node:sqlite`,
 * build the corpus, write it, and close the handle.
 */
export function exportCorpusFromDb(
  dbPath: string,
  opts: CorpusOptions & { outDir: string },
): {
  corpus: Corpus;
  files: string[];
} {
  // `node:sqlite` emits one ExperimentalWarning when it is first loaded. The
  // CLI drops exactly that line (`cli/suppressWarning.ts`); the exporter does
  // the same, so a run prints the files it wrote and nothing else.
  installSqliteWarningFilter();
  const store = openReadonlyStore(dbPath);
  try {
    const corpus = buildCorpus(store, opts);
    return { corpus, files: writeCorpus(corpus, opts.outDir) };
  } finally {
    store.close();
  }
}
