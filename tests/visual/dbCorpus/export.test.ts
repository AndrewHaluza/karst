import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CORPUS_VIEWS, GENERATED_DIR, buildCorpus, corpusFiles, exportCorpusFromDb } from './export.js';
import { seedCorpusDatabase, SEED_DASHBOARD_TICKET_KEY, type SeededCorpus } from './seedSpec.js';
import { FIXTURE_TICKET_ID_MIN, assertNoLeaks } from './sanitize.js';
import { openReadonlyStore } from '../../../src/cli/readonlyStore.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const COMMITTED_DIR = resolve(REPO_ROOT, GENERATED_DIR);

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
  it('seeds a project, seven tickets and a token ledger', () => {
    expect(seeded.projectId).toBeGreaterThan(0);
    expect(seeded.ticketIds.size).toBe(7);
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

    // Sidebar: the board sections the sweep renders.
    expect(corpus.sidebar.sections.current.length).toBeGreaterThan(0);
    expect(corpus.sidebar.sections.awaitingReview.length).toBeGreaterThan(0);
    expect(corpus.sidebar.sections.recentlyDone.length).toBeGreaterThan(0);
    expect(corpus.sidebar.counts).toBeDefined();

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
