import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CORPUS_VIEWS, GENERATED_DIR, buildCorpus, corpusFiles, exportCorpusFromDb } from './export.js';
import { seedCorpusDatabase, SEED_DASHBOARD_TICKET_KEY, type SeededCorpus } from './seedSpec.js';
import { FIXTURE_NOW_MS, FIXTURE_TICKET_ID_MIN, assertNoLeaks } from './sanitize.js';
import { rebaseDatabase, type RebaseDb } from './rebase.js';
import { openReadonlyStore } from '../../../src/cli/readonlyStore.js';
import { openStore } from '../../../src/store/db.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const COMMITTED_DIR = resolve(REPO_ROOT, GENERATED_DIR);
const DAY_MS = 86_400_000;

let tempDir: string;
let seeded: SeededCorpus;

beforeAll(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'karst-corpus-test-'));
  seeded = seedCorpusDatabase(join(tempDir, 'karst.db'));
});

afterAll(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe('the seeded corpus', () => {
  it('seeds a project, five tickets and a token ledger', () => {
    expect(seeded.projectId).toBeGreaterThan(0);
    expect(seeded.ticketIds.size).toBe(5);
    expect(seeded.dashboardTicketId).toBe(seeded.ticketIds.get(SEED_DASHBOARD_TICKET_KEY));
  });
});

describe('exportCorpusFromDb', () => {
  it('builds dashboard, sidebar and usage through the production state builders, sanitized', () => {
    const outDir = join(tempDir, 'out-a');
    const { corpus } = exportCorpusFromDb(seeded.dbPath, {
      outDir,
      projectId: seeded.projectId,
      ticketId: seeded.dashboardTicketId,
    });

    // Dashboard: the review-stage ticket with its worktree, PR, gates and findings.
    expect(corpus.dashboard.title).toBe('Add the server inventory tab');
    expect(corpus.dashboard.ticketId).toBeGreaterThanOrEqual(FIXTURE_TICKET_ID_MIN);
    expect(corpus.dashboard.stepper.map((cell) => cell.stageKey)).toEqual([
      'scope',
      'impl',
      'uat',
      'review',
      'fix',
      'ship',
      'done',
    ]);
    expect(corpus.dashboard.worktrees.length).toBeGreaterThan(0);
    expect(corpus.dashboard.prs.length).toBeGreaterThan(0);
    expect(corpus.dashboard.prs[0]!.url).toMatch(/^fixture:url\//);
    expect(corpus.dashboard.insideViews.review).toBeDefined();
    // Sub-tasks: the panel the compaction ladder (`tests/visual/subtasks.visual.ts`)
    // renders must carry a landed row with a merged PR, a blocking row mid-impl
    // with a captured session and an open PR, and a queued row.
    expect(corpus.dashboard.subtaskProgress).toEqual({ done: 1, total: 3 });
    const [landed, blocking, queued] = corpus.dashboard.subtasks;
    expect(landed!.done).toBe(true);
    expect(landed!.pr?.state).toBe('merged');
    expect(blocking!.stage).toBe('impl');
    expect(blocking!.blocking).toBe(true);
    expect(blocking!.pr?.state).toBe('open');
    expect(blocking!.agent?.modelShort).toBe('Opus 5');
    expect(queued!.autostart).toBe('queued');
    expect(queued!.queuePos).toBe(1);

    // Sidebar: the board sections the sweep renders.
    expect(corpus.sidebar.sections.current.length).toBeGreaterThan(0);
    expect(corpus.sidebar.sections.awaitingReview.length).toBeGreaterThan(0);
    expect(corpus.sidebar.sections.recentlyDone.length).toBeGreaterThan(0);
    expect(corpus.sidebar.counts).toBeDefined();
    // The sweep's SB-5 step reads the first Current row's stage pill, so the
    // seed pins which stage sorts first (CREATED_HOURS_AGO, `seedSpec.ts`).
    expect(corpus.sidebar.sections.current[0]!.stageCurrent).toBe('impl');
    expect(corpus.sidebar.sections.current[0]!.label).toContain('FIX-104');

    // Usage: formatted rows over a real ledger.
    expect(corpus.usage.empty).toBe(false);
    expect(corpus.usage.tickets.length).toBeGreaterThan(1);
    expect(corpus.usage.byProvider.length).toBeGreaterThan(1);
    expect(corpus.usage.quota.rows.length).toBeGreaterThan(0);

    for (const view of CORPUS_VIEWS) assertNoLeaks(corpus[view], view);
  });

  it('is deterministic: two exports of the same database are byte-identical', () => {
    const first = exportCorpusFromDb(seeded.dbPath, {
      outDir: join(tempDir, 'out-b'),
      projectId: seeded.projectId,
      ticketId: seeded.dashboardTicketId,
    });
    const second = exportCorpusFromDb(seeded.dbPath, {
      outDir: join(tempDir, 'out-c'),
      projectId: seeded.projectId,
      ticketId: seeded.dashboardTicketId,
    });

    for (const view of CORPUS_VIEWS) {
      const a = readFileSync(join(tempDir, 'out-b', `${view}.json`), 'utf8');
      const b = readFileSync(join(tempDir, 'out-c', `${view}.json`), 'utf8');
      expect(a).toBe(b);
      expect(a.endsWith('\n')).toBe(true);
    }
    expect(first.files.map((f) => f.split('/').pop()).sort()).toEqual([
      'dashboard.json',
      'sidebar.json',
      'usage.json',
    ]);
    expect(corpusFiles(second.corpus)).toEqual(corpusFiles(first.corpus));
  });

  it('re-seeds to the same corpus: the seed carries no wall clock', () => {
    const other = seedCorpusDatabase(join(tempDir, 'karst-again.db'));
    const first = exportCorpusFromDb(seeded.dbPath, {
      outDir: join(tempDir, 'out-seed-a'),
      projectId: seeded.projectId,
      ticketId: seeded.dashboardTicketId,
    });
    const second = exportCorpusFromDb(other.dbPath, {
      outDir: join(tempDir, 'out-seed-b'),
      projectId: other.projectId,
      ticketId: other.dashboardTicketId,
    });
    expect(corpusFiles(second.corpus)).toEqual(corpusFiles(first.corpus));
  });

  it('replaces provider ticket ids (ClickUp) in keys, labels and descriptions', () => {
    const extra = seedCorpusDatabase(join(tempDir, 'karst-provider.db'));
    const ref = '869e494q2';
    const quoted = '869e48tv6';
    const writable = openStore(extra.dbPath);
    try {
      writable.db
        .prepare('UPDATE tickets SET key = ?, source_ref = ?, source_ref_internal = ?, description = ? WHERE id = ?')
        .run(ref, ref, quoted, `see ${quoted} ↗ clickup: ${quoted}`, extra.dashboardTicketId);
    } finally {
      writable.close();
    }

    const { corpus } = exportCorpusFromDb(extra.dbPath, {
      outDir: join(tempDir, 'out-provider'),
      projectId: extra.projectId,
      ticketId: extra.dashboardTicketId,
    });
    const text = JSON.stringify(corpus);
    expect(text).toContain('fixture:ref/');
    expect(text).not.toContain(ref);
    expect(text).not.toContain(quoted);
  });

  it('replaces PR author logins and keeps no raw store id on a sub-task row', () => {
    const extra = seedCorpusDatabase(join(tempDir, 'karst-hostile.db'));
    const writable = openStore(extra.dbPath);
    try {
      writable.db.prepare("UPDATE prs SET author = 'alice-gh'").run();
    } finally {
      writable.close();
    }

    const { corpus } = exportCorpusFromDb(extra.dbPath, {
      outDir: join(tempDir, 'out-hostile'),
      projectId: extra.projectId,
      ticketId: extra.dashboardTicketId,
    });
    expect(JSON.stringify(corpus)).not.toContain('alice-gh');
    for (const row of corpus.dashboard.subtasks ?? []) {
      expect(row.id).toBeGreaterThanOrEqual(FIXTURE_TICKET_ID_MIN);
      expect(row.idLabel).toBe(`T${row.id}`);
    }
  });

  it('rebases the database rows, not the stubs: a database moved in time exports the same corpus', () => {
    const moved = seedCorpusDatabase(join(tempDir, 'karst-moved.db'));
    const writable = openStore(moved.dbPath);
    try {
      // A real database is "today", not the fixture day: move every row 30 days ahead.
      rebaseDatabase(writable.db as unknown as RebaseDb, 30 * DAY_MS);
    } finally {
      writable.close();
    }
    const opts = { projectId: seeded.projectId, ticketId: seeded.dashboardTicketId };
    const base = exportCorpusFromDb(seeded.dbPath, { ...opts, outDir: join(tempDir, 'out-base') });
    const shifted = exportCorpusFromDb(moved.dbPath, { ...opts, outDir: join(tempDir, 'out-moved') });
    expect(corpusFiles(shifted.corpus)).toEqual(corpusFiles(base.corpus));
  });

  it('keeps the stubbed quota on the fixture clock and no activity after it', () => {
    const { corpus } = exportCorpusFromDb(seeded.dbPath, {
      outDir: join(tempDir, 'out-quota'),
      projectId: seeded.projectId,
      ticketId: seeded.dashboardTicketId,
    });
    expect(JSON.stringify(corpus.usage)).toContain(new Date(FIXTURE_NOW_MS + 2 * 3_600_000).toISOString());
    const dashboard = JSON.stringify(corpus.dashboard);
    const instants = [...dashboard.matchAll(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z/g)].map((m) => Date.parse(m[0]));
    expect(instants.length).toBeGreaterThan(0);
    expect(Math.max(...instants)).toBeLessThanOrEqual(FIXTURE_NOW_MS);
  });

  it('matches the checked-in fixtures, so a stale corpus fails here', () => {
    const store = openReadonlyStore(seeded.dbPath);
    try {
      const fresh = corpusFiles(
        buildCorpus(store, {
          projectId: seeded.projectId,
          ticketId: seeded.dashboardTicketId,
        }),
      );
      for (const view of CORPUS_VIEWS) {
        const committed = readFileSync(resolve(COMMITTED_DIR, `${view}.json`), 'utf8');
        expect(committed, `${view}.json is stale — run npm run -s visual:corpus:export -- --seed`).toBe(
          fresh[`${view}.json`]!,
        );
      }
    } finally {
      store.close();
    }
  });
});
