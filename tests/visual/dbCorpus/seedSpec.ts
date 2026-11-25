/**
 * A rich, deterministic seed for the visual corpus database (T1365).
 *
 * The showcase corpus must be regenerable inside a ticket worktree and in CI,
 * where no live Karst database exists. This module builds one: it applies a
 * `FixtureSpec` through the SAME writers the UAT host fixture uses
 * (`openStore` + `seedStore`, `@arch` store rules) and then records a token
 * ledger, so the three exported views have something real to render:
 *
 * - several tickets spread across stages (impl running, UAT blocked, review
 *   running, ship awaiting merge, done recent, done archived), each with its
 *   stepper, worktree, PRs, gate runs, merge checks and review findings;
 * - a token ledger across three agent cores, four activity sites and six
 *   tickets, newest row exactly at `FIXTURE_NOW_MS`.
 *
 * Every instant is an offset from `FIXTURE_NOW_MS`, never `Date.now()`, so two
 * runs produce the same database and therefore byte-identical fixtures.
 *
 * `src/uatHost/*` is deliberately NOT modified: this is a consumer of its
 * seed writer, not a second one.
 */
import { openStore } from '../../../src/store/db.js';
import { recordShippedPr } from '../../../src/store/prs.js';
import { upsertProject } from '../../../src/store/projects.js';
import { setStage } from '../../../src/store/stages.js';
import {
  createTicket,
  setSessionId,
  setStageCurrent,
  updateTicketFields,
} from '../../../src/store/tickets.js';
import { recordTokenUsage } from '../../../src/store/tokenUsage.js';
import { seedStore } from '../../../src/uatHost/seed.js';
import type { FixtureSpec, TicketSeed } from '../../../src/uatHost/fixtures.js';
import type { StageKey } from '../../../src/model/types.js';
import { withPinnedClock } from './export.js';
import { FIXTURE_NOW_MS } from './sanitize.js';

/** The slug the seeded project registers under; it is also the stub manifest's `id` (`CORPUS_PROJECT_SLUG`). */
export const SEED_PROJECT_SLUG = 'fixture';
/** The project's display name, recorded on the project row. */
export const SEED_PROJECT_NAME = 'Fixture workspace';
/** The workspace root the project records (advisory only). */
export const SEED_PROJECT_ROOT = '/fixture/workspace';
/** The ticket the dashboard showcases: the richest one, so the page pins its panels. */
export const SEED_DASHBOARD_TICKET_KEY = 'FIX-101';

/** The two stub repositories the exporter's manifest declares, as PATHS (the runtime keys rows by path). */
const API = '/fixture/workspace/api';
const WEB = '/fixture/workspace/web';

/** The worktree binding for a ticket checked out in `repoPath`. */
function binding(repoPath: string): { repoPath: string; baseRef: string; worktreePath: string } {
  return { repoPath, baseRef: 'develop', worktreePath: '' };
}

/** An instant `hours` before the pinned fixture clock. */
function hoursAgo(hours: number): string {
  return new Date(FIXTURE_NOW_MS - hours * 3_600_000).toISOString();
}

/** Every stage a finished ticket passed through, ended at `endedAt`. */
function passedStages(stages: readonly StageKey[], endedAt: string): TicketSeed['stages'] {
  return stages.map((stageKey) => ({ stageKey, patch: { status: 'passed' as const, endedAt } }));
}

/** The tickets every corpus needs. Ids are assigned by insert order, so this order is stable. */
export function corpusTickets(): TicketSeed[] {
  return [
    {
      key: SEED_DASHBOARD_TICKET_KEY,
      title: 'Add the server inventory tab',
      description:
        'Show every registered service with its port, health and last error, and let the operator restart one from the tab.',
      stageCurrent: 'review',
      selectedRepos: ['api'],
      repo: binding(API),
      worktree: true,
      placement: 'host',
      stages: [
        ...passedStages(['scope', 'impl', 'uat'], hoursAgo(30)),
        { stageKey: 'review', patch: { status: 'running', startedAt: hoursAgo(5) } },
      ],
      rows: {
        stageRuns: [{ stageKey: 'review', attempt: 1, status: 'running' }],
        processRuns: [{ stageKey: 'review', processId: 'review', attempt: 1, status: 'running' }],
        gateRuns: [
          { stageKey: 'uat', attempt: 1, gateName: 'test', exitCode: 0 },
          { stageKey: 'uat', attempt: 1, gateName: 'typecheck', exitCode: 0 },
          { stageKey: 'review', attempt: 1, gateName: 'test', exitCode: 0 },
        ],
        prs: [
          {
            repo: API,
            number: 128,
            url: 'https://github.com/fixture-org/api/pull/128',
            status: 'open',
            headRef: 'karst/fix-101-server-inventory',
            baseRef: 'develop',
          },
        ],
        mergeChecks: [
          {
            repo: API,
            state: 'clean',
            files: [],
            reason: null,
            headSha: '0000000000000000000000000000000000000101',
            baseSha: '0000000000000000000000000000000000000100',
            baseRef: 'develop',
          },
        ],
        reviewFindings: [
          {
            attempt: 1,
            severity: 'medium',
            repo: API,
            file: 'src/serverInventory.ts',
            line: 84,
            title: 'Restart action ignores a failed health probe',
            detail: 'A restart that fails health still reports the old status until the next poll.',
            source: 'agent',
          },
        ],
      },
    },
    {
      key: 'FIX-102',
      title: 'Persist the sidebar filter across reloads',
      stageCurrent: 'ship',
      selectedRepos: ['web'],
      repo: binding(WEB),
      worktree: true,
      placement: 'host',
      stages: [
        ...passedStages(['scope', 'impl', 'uat', 'review', 'fix'], hoursAgo(52)),
        { stageKey: 'ship', patch: { status: 'running', startedAt: hoursAgo(2) } },
      ],
      rows: {
        prs: [
          {
            repo: WEB,
            number: 129,
            url: 'https://github.com/fixture-org/web/pull/129',
            status: 'open',
            headRef: 'karst/fix-102-filter-persistence',
            baseRef: 'develop',
          },
        ],
        mergeChecks: [
          {
            repo: WEB,
            state: 'clean',
            files: [],
            reason: null,
            headSha: '0000000000000000000000000000000000000102',
            baseSha: '0000000000000000000000000000000000000100',
            baseRef: 'develop',
          },
        ],
        gateRuns: [{ stageKey: 'review', attempt: 1, gateName: 'test', exitCode: 0 }],
      },
    },
    {
      key: 'FIX-104',
      title: 'Rate-limit the corpus exporter',
      stageCurrent: 'impl',
      selectedRepos: ['api', 'web'],
      repo: binding(API),
      worktree: true,
      stages: [{ stageKey: 'impl', patch: { status: 'running', startedAt: hoursAgo(7) } }],
      rows: {
        stageRuns: [{ stageKey: 'impl', attempt: 1, status: 'running' }],
        processRuns: [{ stageKey: 'impl', processId: 'session', attempt: 1, status: 'running' }],
      },
    },
    {
      key: 'FIX-106',
      title: 'Retire the legacy queue probe',
      stageCurrent: 'done',
      selectedRepos: ['api'],
      archived: true,
      stages: passedStages(['scope', 'impl', 'uat', 'review', 'ship', 'done'], hoursAgo(20 * 24)),
    },
    {
      key: 'FIX-107',
      title: 'Fix the flaky merge-check probe',
      stageCurrent: 'uat',
      selectedRepos: ['api'],
      repo: binding(API),
      worktree: true,
      stages: [
        ...passedStages(['scope', 'impl'], hoursAgo(48)),
        {
          stageKey: 'uat',
          patch: {
            status: 'failed',
            startedAt: hoursAgo(20),
            endedAt: hoursAgo(18),
            verdict: 'test (api) exited 1 after the probe flaked twice',
          },
        },
      ],
      rows: {
        gateRuns: [{ stageKey: 'uat', attempt: 1, gateName: 'test', exitCode: 1 }],
      },
    },
  ];
}

/** The seed spec the corpus database is built from. */
export function corpusFixtureSpec(): FixtureSpec {
  return { name: 'visual-corpus', tickets: corpusTickets() };
}

/**
 * How old each ticket is, in hours before the fixture clock — the create order
 * the store sorts by (`created_at DESC`), so this is also the order the
 * sidebar's Current section lists them in.
 *
 * The newest is `FIX-104`, the one in impl: the populated sidebar page has to
 * show a ticket mid-impl first, because that page is also what the sweep's
 * SB-5 step reads (`the stage pill reads the short key at 300 px and the full
 * word at 460 px`). Any other order would make that step read whichever stage
 * happened to sort first, which is data, not a contract.
 */
const CREATED_HOURS_AGO: Readonly<Record<string, number>> = {
  'FIX-104': 10,
  'FIX-107': 12,
  'FIX-102': 20,
  'FIX-101': 26,
  'FIX-106': 20 * 24,
};

/**
 * One token-ledger row: enough variety that every breakdown has a real hierarchy.
 *
 * The model id becomes the usage view's breakdown `key`, and gitleaks'
 * `generic-api-key` rule reads a high-entropy value beside a `key` field as a
 * secret. These ids are the vetted shapes (a new one can trip the secrets gate
 * on the next regeneration — check with `npm run -s gate:secrets`).
 */
interface UsageSeed {
  ticket: string | null;
  callSite: string;
  provider: string;
  model: string;
  input: number;
  output: number;
  /** Hours before the pinned clock; 0 is the newest row. */
  hoursAgo: number;
  estimated?: boolean;
}

const USAGE: readonly UsageSeed[] = [
  { ticket: 'FIX-101', callSite: 'review-findings', provider: 'claude', model: 'claude-opus-5', input: 48_000, output: 12_400, hoursAgo: 1 },
  { ticket: 'FIX-101', callSite: 'implementation', provider: 'claude', model: 'claude-opus-5', input: 210_000, output: 38_000, hoursAgo: 6 },
  { ticket: 'FIX-101', callSite: 'uat-tester', provider: 'codex', model: 'gpt-5.6-sol', input: 96_000, output: 21_000, hoursAgo: 9 },
  { ticket: 'FIX-102', callSite: 'pr-description', provider: 'opencode', model: 'opencode-go/kimi-k2', input: 12_000, output: 2_400, hoursAgo: 2 },
  { ticket: 'FIX-102', callSite: 'implementation', provider: 'claude', model: 'claude-opus-5', input: 180_000, output: 44_000, hoursAgo: 30 },
  { ticket: 'FIX-107', callSite: 'uat-tester', provider: 'codex', model: 'gpt-5.6-sol', input: 64_000, output: 9_800, hoursAgo: 3 },
  { ticket: 'FIX-104', callSite: 'implementation', provider: 'opencode', model: 'opencode-go/deepseek-v4-flash', input: 320_000, output: 58_000, hoursAgo: 7, estimated: true },
  { ticket: 'FIX-104', callSite: 'fix-resume', provider: 'opencode', model: 'opencode-go/deepseek-v4-flash', input: 41_000, output: 7_200, hoursAgo: 5 },
  { ticket: 'FIX-102', callSite: 'implementation', provider: 'claude', model: 'claude-sonnet-5', input: 88_000, output: 19_000, hoursAgo: 28 },
  { ticket: 'FIX-104', callSite: 'ticket-analysis', provider: 'claude', model: 'claude-sonnet-5', input: 8_400, output: 1_100, hoursAgo: 40 },
  { ticket: 'FIX-106', callSite: 'implementation', provider: 'codex', model: 'gpt-5.6-sol', input: 52_000, output: 11_000, hoursAgo: 480 },
  { ticket: null, callSite: 'ticket-improve', provider: 'claude', model: 'claude-haiku-4', input: 3_200, output: 640, hoursAgo: 0 },
];

/**
 * Move the evidence `seedStore` stamps at its own fixed instant
 * (`2026-01-01T00:00:00.000Z`) onto the fixture clock.
 *
 * The seed writer freezes every stage/process/gate/merge-check/finding stamp at
 * that one constant. Rendered against the pinned clock that reads as `299d ago`
 * beside a ticket that started a day ago — a fixture that contradicts itself,
 * and text a baseline would bake in. `seedStore` is not ours to change (a UAT
 * fixture has no pinned clock), so the corpus re-stamps its own rows: ticket `i`
 * gets its evidence `2 + 3i` hours before `FIXTURE_NOW_MS`, after its own start
 * and before the newest ledger row.
 */
function pinEvidenceTimestamps(store: ReturnType<typeof openStore>, ids: readonly number[]): void {
  const stageRun = store.db.prepare(
    `UPDATE stage_runs
       SET run_at = ?, started_at = ?,
           ended_at = CASE WHEN ended_at IS NULL THEN NULL ELSE ? END
     WHERE ticket_id = ?`,
  );
  const processRun = store.db.prepare(
    `UPDATE process_runs
       SET started_at = ?, ended_at = CASE WHEN ended_at IS NULL THEN NULL ELSE ? END
     WHERE ticket_id = ?`,
  );
  const gateRun = store.db.prepare(
    `UPDATE gate_runs
       SET run_at = ?,
           started_at = CASE WHEN started_at IS NULL THEN NULL ELSE ? END,
           ended_at = CASE WHEN ended_at IS NULL THEN NULL ELSE ? END
     WHERE ticket_id = ?`,
  );
  const mergeCheck = store.db.prepare('UPDATE merge_checks SET checked_at = ? WHERE ticket_id = ?');
  const finding = store.db.prepare('UPDATE review_findings SET run_at = ?, created_at = ? WHERE ticket_id = ?');

  ids.forEach((id, index) => {
    const at = hoursAgo(2 + index * 3);
    stageRun.run(at, at, at, id);
    processRun.run(at, at, id);
    gateRun.run(at, at, at, id);
    mergeCheck.run(at, id);
    finding.run(at, at, id);
  });
}

/**
 * One sub-task of the dashboard ticket. The populated page must render the
 * Sub-tasks panel with the cells the ladder keeps (dot, PR chip, blocker lock,
 * agent icon, stage pill), so the seed carries one of each: a landed row with
 * a merged PR, a blocking row mid-impl with a captured session and an open PR,
 * and a queued row.
 */
interface SubtaskSeed {
  readonly title: string;
  readonly stage: StageKey;
  /** Hours before the fixture clock; the row's `Xh ago` / `in impl for Xh` text. */
  readonly startedHoursAgo: number;
  readonly blocking?: boolean;
  readonly autostart?: boolean;
  readonly pr?: { readonly number: number; readonly state: 'open' | 'merged' };
  /** A captured agent session, so the row paints its core icon, name and model. */
  readonly model?: string;
}

const SUBTASKS: readonly SubtaskSeed[] = [
  {
    title: 'Extract the inventory probe',
    stage: 'done',
    startedHoursAgo: 30,
    pr: { number: 131, state: 'merged' },
  },
  {
    title: 'Add the restart action to the tab',
    stage: 'impl',
    startedHoursAgo: 6,
    blocking: true,
    pr: { number: 132, state: 'open' },
    model: 'claude-opus-5',
  },
  {
    title: 'Queue the health-poll backoff',
    stage: 'scope',
    startedHoursAgo: 2,
    autostart: true,
  },
];

/**
 * Seed the dashboard ticket's sub-tasks through the same writers the workflow's
 * `createSubtask` uses (`createTicket`, `setStage`, `updateTicketFields`,
 * `setSessionId`, `recordShippedPr`), so the panel renders rows the product
 * could really have written rather than a shape invented for a screenshot.
 *
 * Runs under the pinned clock: `setStage` posts a sub-task event, and that
 * writer stamps it with `nowIso()`.
 */
function seedSubtasks(
  store: ReturnType<typeof openStore>,
  parentId: number,
  projectId: number,
  parentKey: string,
): readonly number[] {
  const pin = store.db.prepare('UPDATE tickets SET created_at = ?, updated_at = ? WHERE id = ?');
  const merge = store.db.prepare(
    "UPDATE prs SET status = 'merged', merged_at = ? WHERE ticket_id = ? AND number = ?",
  );
  return SUBTASKS.map((sub, index) => {
    const child = createTicket(store, {
      key: `${parentKey}-s${index + 1}`,
      title: sub.title,
      source: 'karst',
      projectId,
      subtaskParentId: parentId,
      blocksParent: sub.blocking ?? false,
      autostartPending: sub.autostart ?? false,
    });
    setStageCurrent(store, child.id, sub.stage);
    if (sub.stage === 'done') {
      setStage(store, child.id, 'done', {
        status: 'passed',
        startedAt: hoursAgo(sub.startedHoursAgo),
        endedAt: hoursAgo(sub.startedHoursAgo - 1),
      });
    } else if (sub.stage !== 'scope') {
      setStage(store, child.id, sub.stage, { status: 'running', startedAt: hoursAgo(sub.startedHoursAgo) });
    }
    if (sub.model !== undefined) {
      updateTicketFields(store, child.id, { model: sub.model, agentProvider: 'claude', selectedRepos: ['api'] });
      setSessionId(store, child.id, `fixture-session-${child.id}`, 'claude');
    }
    if (sub.pr !== undefined) {
      recordShippedPr(store, {
        ticketId: child.id,
        repo: API,
        number: sub.pr.number,
        url: `https://github.com/fixture-org/api/pull/${sub.pr.number}`,
      });
      if (sub.pr.state === 'merged') merge.run(hoursAgo(sub.startedHoursAgo - 1), child.id, sub.pr.number);
    }
    // `created_at` defaults to the machine clock; pin the create order too, so
    // a sub-task never outranks its parent in a sidebar read.
    pin.run(hoursAgo(sub.startedHoursAgo), hoursAgo(sub.startedHoursAgo - 1), child.id);
    return child.id;
  });
}

/** What a seeded corpus knows about itself. */
export interface SeededCorpus {
  dbPath: string;
  projectId: number;
  /** Key → sqlite id, in insert order. */
  ticketIds: ReadonlyMap<string, number>;
  /** The ticket `SEED_DASHBOARD_TICKET_KEY` resolved to. */
  dashboardTicketId: number;
}

/**
 * Create (or replace) a corpus database at `dbPath` and return what was seeded.
 *
 * The caller owns the path: a test passes a `mkdtemp` path, the CLI a temp file
 * it deletes. Nothing here is time-dependent, so re-seeding the same path after
 * removing it reproduces the same database.
 */
export function seedCorpusDatabase(dbPath: string): SeededCorpus {
  const store = openStore(dbPath);
  try {
    // One project, id 1 in a fresh database. The slug is what the extension
    // resolves a window by, so a fixture project keeps the real shape.
    const project = upsertProject(store, {
      slug: SEED_PROJECT_SLUG,
      name: SEED_PROJECT_NAME,
      rootPath: SEED_PROJECT_ROOT,
    });

    const spec = corpusFixtureSpec();
    const ids = seedStore(store, spec);
    // `seedStore` creates the tickets through `createTicket`, which takes a
    // `projectId` no fixture spec carries (a UAT fixture has one window). Scope
    // them here, in one statement, so the views read them the way the extension
    // does. Deliberately a store write, not a second seeding path.
    //
    // `tickets.created_at` and `worktrees.created_at` default to
    // `datetime('now')`, which would put the machine clock into the corpus and
    // make the sidebar's recency ordering depend on when it was generated. Pin
    // both from the fixture clock, in the order `CREATED_HOURS_AGO` states.
    const assign = store.db.prepare(
      'UPDATE tickets SET project_id = ?, created_at = ?, updated_at = ? WHERE id = ?',
    );
    const pinWorktree = store.db.prepare('UPDATE worktrees SET created_at = ? WHERE ticket_id = ?');
    ids.forEach((id, index) => {
      const key = spec.tickets[index]!.key;
      const hours = CREATED_HOURS_AGO[key];
      if (hours === undefined) throw new Error(`seed: no create order for ${key}`);
      const createdAt = hoursAgo(hours);
      assign.run(project.id, createdAt, createdAt, id);
      pinWorktree.run(createdAt, id);
    });

    const byKey = new Map(spec.tickets.map((t, i) => [t.key, ids[i]!] as const));
    const dashboardTicketId = byKey.get(SEED_DASHBOARD_TICKET_KEY);
    if (dashboardTicketId === undefined) {
      throw new Error(`seed: the spec has no ticket ${SEED_DASHBOARD_TICKET_KEY}`);
    }
    withPinnedClock(FIXTURE_NOW_MS, () =>
      seedSubtasks(store, dashboardTicketId, project.id, SEED_DASHBOARD_TICKET_KEY),
    );
    pinEvidenceTimestamps(store, ids);
    for (const row of USAGE) {
      const ticketId = row.ticket === null ? null : (byKey.get(row.ticket) ?? null);
      recordTokenUsage(store, {
        projectId: project.id,
        ticketId,
        callSite: row.callSite,
        provider: row.provider,
        outcome: 'ok',
        recordedAt: hoursAgo(row.hoursAgo),
        usage: {
          inputTokens: row.input,
          outputTokens: row.output,
          reasoningTokens: 0,
          cacheReadTokens: Math.round(row.input / 4),
          cacheWriteTokens: Math.round(row.input / 8),
          totalTokens: row.input + row.output,
          model: row.model,
          estimated: row.estimated ?? false,
        },
      });
    }

    return { dbPath, projectId: project.id, ticketIds: byKey, dashboardTicketId };
  } finally {
    store.close();
  }
}
