import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { openStore, type Store } from '../store/db.js';
import { createTicket, updateTicketFields } from '../store/tickets.js';
import { insertAttachment } from '../store/attachments.js';
import { setStage } from '../store/stages.js';
import { recordGateRun } from '../store/gateRuns.js';
import { recordFindings } from '../store/reviewFindings.js';
import { openStageRun, closeStageRun } from '../store/stageRuns.js';
import { buildTicketContext, renderTicketContext } from './ticketContext.js';
import type { Manifest, RepositoryDef, ServiceDef } from '../manifest/types.js';
import {
  manifest as buildManifest,
  repo as buildRepo,
  runnableRepo,
  slot,
} from '../manifest/fixtures.js';

/** A runnable repository — the default most of these cases want. */
function svc(over: Partial<ServiceDef> = {}): RepositoryDef {
  return runnableRepo({ ports: [slot('port', 'PORT', 3000)], ...over }, {
    repoPath: '/repos/frontend',
  });
}

/** A repository with no service — never runnable, no port. */
function nonRunnable(repoPath = '/repos/docs'): RepositoryDef {
  return buildRepo({ repoPath });
}

function manifest(repos: Record<string, RepositoryDef>): Manifest {
  return buildManifest(repos, { portRange: [3000, 3999], baselineBranch: 'main' });
}

describe('buildTicketContext', () => {
  let store: Store;
  beforeEach(() => (store = openStore(':memory:')));
  afterEach(() => store.close());

  function seed(): number {
    const t = createTicket(store, { key: 'PROJ-9', title: 'Do research' });
    updateTicketFields(store, t.id, {
      description: 'Audit the app',
      brief: 'A short brief',
      approach: 'rpi',
      selectedRepos: ['frontend'],
    });
    store.db
      .prepare(
        "INSERT INTO worktrees (ticket_id, repo, path, branch, base_ref, deps_mode) VALUES (?, 'frontend', '/wt/frontend', 'feat/x', 'main', 'inherited')",
      )
      .run(t.id);
    store.db
      .prepare(
        "INSERT INTO servers (ticket_id, repo, host, port, status) VALUES (?, 'frontend', '127.0.0.1', 3001, 'running')",
      )
      .run(t.id);
    store.db
      .prepare(
        "INSERT INTO prs (ticket_id, repo, number, url, status) VALUES (?, 'frontend', 42, 'https://x/pr/42', 'open')",
      )
      .run(t.id);
    return t.id;
  }

  it('aggregates ticket, worktrees, servers, prs, and named repositories', () => {
    const id = seed();
    const ctx = buildTicketContext(store, manifest({ frontend: svc(), backend: svc() }), id);

    expect(ctx.key).toBe('PROJ-9');
    expect(ctx.prompt).toBe('Audit the app');
    expect(ctx.brief).toBe('A short brief');
    expect(ctx.selectedRepos).toEqual(['frontend']);
    expect(ctx.worktrees).toEqual([
      { repo: 'frontend', path: '/wt/frontend', branch: 'feat/x', baseRef: 'main', depsMode: 'inherited' },
    ]);
    expect(ctx.servers).toEqual([
      { service: 'frontend', host: '127.0.0.1', port: 3001, status: 'running' },
    ]);
    expect(ctx.prs).toEqual([
      { repo: 'frontend', number: 42, url: 'https://x/pr/42', status: 'open' },
    ]);
    // Only repositories named in selectedRepos are included (not `backend`).
    expect(ctx.repos.map((r) => r.name)).toEqual(['frontend']);
    expect(ctx.repos[0]!.start).toBe('npm run dev');
  });

  it('marks every selected repo unknown when there is no manifest', () => {
    const id = seed();
    const ctx = buildTicketContext(store, undefined, id);
    expect(ctx.repos).toEqual([{ name: 'frontend', runnable: false, unknown: true }]);
  });

  it('includes a parent section when the ticket links to a completed parent', () => {
    const parent = createTicket(store, { key: 'PROJ-1', title: 'Root work' });
    updateTicketFields(store, parent.id, { brief: 'Built the thing.' });
    store.db.prepare("UPDATE tickets SET stage_current = 'done' WHERE id = ?").run(parent.id);
    store.db
      .prepare(
        "INSERT INTO prs (ticket_id, repo, number, url, status) VALUES (?, 'frontend', 7, 'https://x/pr/7', 'merged')",
      )
      .run(parent.id);

    const child = createTicket(store, {
      key: 'PROJ-1-fu1',
      title: 'Follow-up: Root work',
      parentTicketId: parent.id,
    });

    const ctx = buildTicketContext(store, undefined, child.id);
    expect(ctx.parent).toEqual({
      key: 'PROJ-1',
      title: 'Root work',
      brief: 'Built the thing.',
      prs: [{ repo: 'frontend', number: 7, url: 'https://x/pr/7' }],
    });

    const md = renderTicketContext(ctx);
    expect(md).toContain('## Continuing from PROJ-1: Root work');
    expect(md).toContain('Built the thing.');
    expect(md).toContain('https://x/pr/7');
  });

  it('omits the parent section for an ordinary (non-follow-up) ticket', () => {
    const t = createTicket(store, { key: 'PROJ-9', title: 'root' });
    const ctx = buildTicketContext(store, undefined, t.id);
    expect(ctx.parent).toBeNull();
    expect(renderTicketContext(ctx)).not.toContain('## Continuing from');
  });

  it('degrades gracefully when the linked parent has been hard-deleted', () => {
    const parent = createTicket(store, { key: 'PROJ-1', title: 'Root work' });
    const child = createTicket(store, {
      key: 'PROJ-1-fu1',
      title: 'Follow-up',
      parentTicketId: parent.id,
    });
    store.db.prepare('DELETE FROM tickets WHERE id = ?').run(parent.id);

    const ctx = buildTicketContext(store, undefined, child.id);
    expect(ctx.parent).toBeNull();
    expect(renderTicketContext(ctx)).not.toContain('## Continuing from');
  });

  describe('attachments', () => {
    it('omits the section when the ticket has none', () => {
      const ticketId = seed();
      const ctx = buildTicketContext(store, undefined, ticketId, '/storage');

      expect(ctx.attachments).toEqual([]);
      expect(renderTicketContext(ctx)).not.toContain('## Attachments');
    });

    it('renders each attachment with its kind, absolute path, and original name', () => {
      const ticketId = seed();
      insertAttachment(store, {
        ticketId,
        kind: 'image',
        storedName: 'a3f9e1b2c3d4e5f6.png',
        originalName: 'login-error.png',
        byteSize: 10,
      });

      const ctx = buildTicketContext(store, undefined, ticketId, '/storage');
      expect(ctx.attachments).toEqual([
        {
          kind: 'image',
          path: join('/storage', 'attachments', String(ticketId), 'a3f9e1b2c3d4e5f6.png'),
          name: 'login-error.png',
        },
      ]);
      const md = renderTicketContext(ctx);
      expect(md).toContain('## Attachments');
      expect(md).toContain(
        `- image: ${join('/storage', 'attachments', String(ticketId), 'a3f9e1b2c3d4e5f6.png')} — "login-error.png"`,
      );
    });

    it('marks a video as not agent-readable', () => {
      const ticketId = seed();
      insertAttachment(store, {
        ticketId,
        kind: 'video',
        storedName: 'b1c4d2e3f4a5b6c7.mp4',
        originalName: 'repro.mov',
        byteSize: 20,
      });

      const md = renderTicketContext(buildTicketContext(store, undefined, ticketId, '/storage'));
      expect(md).toContain('- video: ');
      expect(md).toContain('— "repro.mov" (not agent-readable)');
    });

    it('does not mark an image as not agent-readable', () => {
      const ticketId = seed();
      insertAttachment(store, {
        ticketId,
        kind: 'image',
        storedName: 'aaaa.png',
        originalName: 'a.png',
        byteSize: 1,
      });

      const md = renderTicketContext(buildTicketContext(store, undefined, ticketId, '/storage'));
      expect(md).not.toContain('not agent-readable');
    });

    it('renders a file attachment as agent-readable, unlike video', () => {
      const ticketId = seed();
      insertAttachment(store, {
        ticketId,
        kind: 'file',
        storedName: 'c2d3e4f5a6b7c8d9.txt',
        originalName: 'notes.txt',
        byteSize: 30,
      });

      const md = renderTicketContext(buildTicketContext(store, undefined, ticketId, '/storage'));
      expect(md).toContain('- file: ');
      expect(md).toContain('— "notes.txt"');
      expect(md).not.toContain('not agent-readable');
    });

    it('omits attachments entirely when no storage dir is supplied', () => {
      const ticketId = seed();
      insertAttachment(store, {
        ticketId,
        kind: 'image',
        storedName: 'aaaa.png',
        originalName: 'a.png',
        byteSize: 1,
      });

      const ctx = buildTicketContext(store, undefined, ticketId);
      expect(ctx.attachments).toEqual([]);
      expect(renderTicketContext(ctx)).not.toContain('## Attachments');
    });
  });
});

describe('ticket context — stage/gate/finding state (closes G15)', () => {
  let store: Store;
  beforeEach(() => (store = openStore(':memory:')));
  afterEach(() => store.close());

  it('carries the current stage, its latest gates and its findings when at review', () => {
    const t = createTicket(store, { key: 'PROJ-1', title: 't' });
    store.db.prepare('UPDATE tickets SET stage_current = ? WHERE id = ?').run('review', t.id);
    setStage(store, t.id, 'review', { status: 'running' });
    recordGateRun(store, {
      ticketId: t.id,
      stageKey: 'review',
      attempt: 0,
      runAt: '2026-08-01T10:00:00.000Z',
      gates: [{ gateName: 'lint (web)', exitCode: 1 }],
    });
    recordFindings(store, {
      ticketId: t.id,
      attempt: 0,
      runAt: '2026-08-01T10:00:00.000Z',
      findings: [
        { severity: 'critical', repo: '/web', file: 'src/db.ts', line: 42, title: 'SQL injection', detail: 'd', source: 'agent' },
      ],
    });

    const ctx = buildTicketContext(store, undefined, t.id);
    expect(ctx.stage).toEqual({
      stageKey: 'review',
      status: 'running',
      verdict: null,
      blocked: null,
      gates: [{ name: 'lint (web)', exitCode: 1, skipped: false }],
      findings: [
        { severity: 'critical', repo: '/web', file: 'src/db.ts', line: 42, title: 'SQL injection', detail: 'd' },
      ],
      artifactPath: null,
      // No `stage_runs` row was opened here — these gates were handcrafted, not
      // produced by `runReview`. Null is the truthful answer, and it is a
      // DIFFERENT fact from a run that opened and died (`stale`).
      run: null,
      agentCanAdvance: false,
    });
    const md = renderTicketContext(ctx);
    expect(md).toContain('## Current stage');
    expect(md).toContain('- lint (web): exit 1');
    expect(md).toContain('- [critical] SQL injection (src/db.ts:42)');
  });

  it('falls back to the failed gate stage when parked at fix, since fix records no evidence of its own', () => {
    const t = createTicket(store, { key: 'PROJ-2', title: 't' });
    setStage(store, t.id, 'review', {
      status: 'failed',
      verdict: 'review findings: 1 critical',
    });
    recordFindings(store, {
      ticketId: t.id,
      attempt: 0,
      runAt: '2026-08-01T10:00:00.000Z',
      findings: [
        { severity: 'critical', repo: '/web', file: null, line: null, title: 'boom', detail: '', source: 'agent' },
      ],
    });
    setStage(store, t.id, 'fix', { status: 'running' });
    store.db.prepare('UPDATE tickets SET stage_current = ? WHERE id = ?').run('fix', t.id);

    const ctx = buildTicketContext(store, undefined, t.id);
    expect(ctx.stage?.stageKey).toBe('review');
    expect(ctx.stage?.verdict).toBe('review findings: 1 critical');
    expect(ctx.stage?.findings).toHaveLength(1);
    // The marker is a property of the TICKET's stage, not the evidence row: a
    // fix session fires `stage fix pass` even though the section above shows
    // the failed review evidence.
    expect(ctx.stageCurrent).toBe('fix');
    expect(ctx.stage?.agentCanAdvance).toBe(true);
    const md = renderTicketContext(ctx);
    // The advisory must not contradict the fix session's own marker — it would
    // tell the agent "nothing you run advances this stage" while its seed
    // instructs firing `stage fix pass`.
    expect(md).not.toContain('is not an agent-advanced stage');
  });

  it('carries no findings for a non-review stage, even with a recorded batch elsewhere', () => {
    const t = createTicket(store, { key: 'PROJ-3', title: 't' });
    store.db.prepare('UPDATE tickets SET stage_current = ? WHERE id = ?').run('uat', t.id);
    setStage(store, t.id, 'uat', { status: 'running' });
    recordGateRun(store, {
      ticketId: t.id,
      stageKey: 'uat',
      attempt: 0,
      runAt: '2026-08-01T10:00:00.000Z',
      gates: [{ gateName: 'test (web)', exitCode: 0 }],
    });

    const ctx = buildTicketContext(store, undefined, t.id);
    expect(ctx.stage?.stageKey).toBe('uat');
    expect(ctx.stage?.gates).toEqual([{ name: 'test (web)', exitCode: 0, skipped: false }]);
    expect(ctx.stage?.findings).toEqual([]);
  });

  it('names a skipped gate as disabled rather than as an absent script', () => {
    const t = createTicket(store, { key: 'PROJ-4A', title: 't' });
    store.db.prepare('UPDATE tickets SET stage_current = ? WHERE id = ?').run('uat', t.id);
    setStage(store, t.id, 'uat', { status: 'running' });
    recordGateRun(store, {
      ticketId: t.id,
      stageKey: 'uat',
      attempt: 0,
      runAt: '2026-08-04T10:00:00.000Z',
      gates: [
        { gateName: 'test', exitCode: 0 },
        { gateName: 'e2e', exitCode: null, skipped: true },
      ],
    });

    const ctx = buildTicketContext(store, undefined, t.id);
    expect(ctx.stage?.gates).toEqual([
      { name: 'test', exitCode: 0, skipped: false },
      { name: 'e2e', exitCode: null, skipped: true },
    ]);
    const md = renderTicketContext(ctx);
    expect(md).toContain('disabled for this ticket');
  });

  it('names a block, when the current stage is parked', () => {
    const t = createTicket(store, { key: 'PROJ-4', title: 't' });
    store.db.prepare('UPDATE tickets SET stage_current = ? WHERE id = ?').run('review', t.id);
    setStage(store, t.id, 'review', {
      status: 'running',
      blockedKind: 'capability-missing',
      blockedReason: 'no agent core available',
      blockedAt: '2026-08-01T10:00:00.000Z',
    });

    const ctx = buildTicketContext(store, undefined, t.id);
    expect(ctx.stage?.blocked).toEqual({
      kind: 'capability-missing',
      reason: 'no agent core available',
    });
    expect(renderTicketContext(ctx)).toContain('- blocked: capability-missing — no agent core available');
  });
});

describe('ticket context — stage run state (v25, closes 869edna84)', () => {
  let store: Store;
  beforeEach(() => (store = openStore(':memory:')));
  afterEach(() => store.close());

  function seedAt(stageKey: string): number {
    const t = createTicket(store, { key: 'PROJ-R', title: 't' });
    store.db.prepare('UPDATE tickets SET stage_current = ? WHERE id = ?').run(stageKey, t.id);
    return t.id;
  }

  it("carries the latest run's status/attempt/startedAt/endedAt/outcome", () => {
    const id = seedAt('review');
    setStage(store, id, 'review', { status: 'passed' });
    const runId = openStageRun(store, {
      ticketId: id,
      stageKey: 'review',
      attempt: 1,
      runAt: '2026-08-01T10:00:00.000Z',
      startedAt: '2026-08-01T10:00:00.000Z',
    });
    closeStageRun(store, runId, 'advanced', '2026-08-01T10:05:00.000Z');

    const ctx = buildTicketContext(store, undefined, id);
    expect(ctx.stage?.run).toEqual({
      status: 'finished',
      outcome: 'advanced',
      attempt: 1,
      startedAt: '2026-08-01T10:00:00.000Z',
      endedAt: '2026-08-01T10:05:00.000Z',
      gateSetChanged: false,
    });
  });

  // The run's OWN clock, never `stages.started_at` — that column is written
  // when the stage is ENTERED and not again, so a stage re-run by a later sweep
  // used to report an age belonging to when it first arrived, not to the run
  // actually in flight. Seeding a much older `started_at` on the stage row is
  // what makes a regression that reads the wrong field fail here rather than
  // pass by coincidence.
  it("renders the RUN's own started timestamp, not the stage's", () => {
    const id = seedAt('review');
    setStage(store, id, 'review', { status: 'running', startedAt: '2020-01-01T00:00:00.000Z' });
    openStageRun(store, {
      ticketId: id,
      stageKey: 'review',
      attempt: 0,
      runAt: '2026-08-01T10:00:00.000Z',
      startedAt: '2026-08-01T10:00:00.000Z',
    });

    const md = renderTicketContext(buildTicketContext(store, undefined, id));
    expect(md).toContain('- gate run: running (attempt 0, started 2026-08-01T10:00:00.000Z)');
    expect(md).not.toContain('2020-01-01');
  });

  it('renders the destroyed-run note for a stale run', () => {
    const id = seedAt('review');
    setStage(store, id, 'review', { status: 'running' });
    const runId = openStageRun(store, {
      ticketId: id,
      stageKey: 'review',
      attempt: 0,
      runAt: '2026-08-01T10:00:00.000Z',
      startedAt: '2026-08-01T10:00:00.000Z',
      pid: 999999,
    });
    // What the activation sweep (`reconcileStageRuns`) would have done, had it
    // run — asserted directly rather than through `isAlive`, since this test is
    // about the RENDERING, not the sweep itself (covered in stageRuns.test.ts).
    store.db.prepare("UPDATE stage_runs SET status = 'stale' WHERE id = ?").run(runId);

    const md = renderTicketContext(buildTicketContext(store, undefined, id));
    expect(md).toContain('the previous run of this stage was destroyed');
  });

  // The acceptance criterion end to end at the render surface: a stale run
  // shows as destroyed AND its partial gate rows stay readable, side by side.
  it('renders a stale run with its partial gate rows still readable', () => {
    const id = seedAt('review');
    setStage(store, id, 'review', { status: 'running' });
    const runId = openStageRun(store, {
      ticketId: id,
      stageKey: 'review',
      attempt: 0,
      runAt: '2026-08-01T10:00:00.000Z',
      startedAt: '2026-08-01T10:00:00.000Z',
      pid: 999999,
    });
    recordGateRun(store, {
      ticketId: id,
      stageKey: 'review',
      attempt: 0,
      runAt: '2026-08-01T10:00:00.000Z',
      gates: [{ gateName: 'lint (web)', exitCode: 1 }],
      stageRunId: runId,
    });
    store.db.prepare("UPDATE stage_runs SET status = 'stale' WHERE id = ?").run(runId);

    const md = renderTicketContext(buildTicketContext(store, undefined, id));
    expect(md).toContain('- gate run: stale (attempt 0, started 2026-08-01T10:00:00.000Z)');
    expect(md).toContain('the previous run of this stage was destroyed before it finished');
    expect(md).toContain('Its gate rows below are partial; the stage will run again.');
    expect(md).toContain('- lint (web): exit 1');
  });

  it('marks gateSetChanged only when both runs recorded a hash and the hashes differ', () => {
    const id = seedAt('review');
    setStage(store, id, 'review', { status: 'running' });
    openStageRun(store, {
      ticketId: id,
      stageKey: 'review',
      attempt: 0,
      runAt: '2026-08-01T09:00:00.000Z',
      startedAt: '2026-08-01T09:00:00.000Z',
      manifestHash: 'hash-a',
    });
    openStageRun(store, {
      ticketId: id,
      stageKey: 'review',
      attempt: 1,
      runAt: '2026-08-01T10:00:00.000Z',
      startedAt: '2026-08-01T10:00:00.000Z',
      manifestHash: 'hash-b',
    });

    const ctx = buildTicketContext(store, undefined, id);
    expect(ctx.stage?.run?.gateSetChanged).toBe(true);
  });

  // A gate deleted from `karst.yml` must never read as a gate that was fixed —
  // a missing hash on either side is "unknown", not "changed".
  it('leaves gateSetChanged false when either run recorded no hash', () => {
    const id = seedAt('review');
    setStage(store, id, 'review', { status: 'running' });
    openStageRun(store, {
      ticketId: id,
      stageKey: 'review',
      attempt: 0,
      runAt: '2026-08-01T09:00:00.000Z',
      startedAt: '2026-08-01T09:00:00.000Z',
      manifestHash: null,
    });
    openStageRun(store, {
      ticketId: id,
      stageKey: 'review',
      attempt: 1,
      runAt: '2026-08-01T10:00:00.000Z',
      startedAt: '2026-08-01T10:00:00.000Z',
      manifestHash: 'hash-b',
    });

    const ctx = buildTicketContext(store, undefined, id);
    expect(ctx.stage?.run?.gateSetChanged).toBe(false);
  });

  it('leaves gateSetChanged false when the run has no predecessor', () => {
    const id = seedAt('review');
    setStage(store, id, 'review', { status: 'running' });
    openStageRun(store, {
      ticketId: id,
      stageKey: 'review',
      attempt: 0,
      runAt: '2026-08-01T10:00:00.000Z',
      startedAt: '2026-08-01T10:00:00.000Z',
      manifestHash: 'hash-a',
    });

    const ctx = buildTicketContext(store, undefined, id);
    expect(ctx.stage?.run?.gateSetChanged).toBe(false);
  });

  it.each(['review', 'ship'])(
    'renders the non-marker note at %s, since karst — not the agent — advances it',
    (stageKey) => {
      const id = seedAt(stageKey);
      const md = renderTicketContext(buildTicketContext(store, undefined, id));
      expect(md).toContain('is not an agent-advanced stage');
    },
  );

  // `scope`/`done` carry no session to warn (no agent runs at the first, nothing
  // follows the last) and `impl`/`fix` ARE agent-advanced — the note must be
  // silent at all four.
  it.each(['scope', 'done', 'impl', 'fix'])('does not render the non-marker note at %s', (stageKey) => {
    const id = seedAt(stageKey);
    const md = renderTicketContext(buildTicketContext(store, undefined, id));
    expect(md).not.toContain('is not an agent-advanced stage');
  });

  it("renders the stage's artifact path as a log line", () => {
    const id = seedAt('review');
    setStage(store, id, 'review', { status: 'running', artifactPath: '/tmp/review-ticket-1.log' });
    const md = renderTicketContext(buildTicketContext(store, undefined, id));
    expect(md).toContain('- log: /tmp/review-ticket-1.log');
  });
});

describe('renderTicketContext', () => {
  let store: Store;
  beforeEach(() => (store = openStore(':memory:')));
  afterEach(() => store.close());

  it('renders every populated section as markdown', () => {
    const t = createTicket(store, { key: 'PROJ-9', title: 'Do research' });
    updateTicketFields(store, t.id, {
      description: 'Audit the app',
      brief: 'A short brief',
      selectedRepos: ['frontend'],
    });
    store.db
      .prepare(
        "INSERT INTO worktrees (ticket_id, repo, path, branch, base_ref, deps_mode) VALUES (?, 'frontend', '/wt/frontend', 'feat/x', 'main', 'inherited')",
      )
      .run(t.id);
    const md = renderTicketContext(
      buildTicketContext(store, manifest({ frontend: svc() }), t.id),
    );
    expect(md).toContain('# Ticket: PROJ-9 — Do research');
    expect(md).toContain('## Prompt\nAudit the app');
    expect(md).toContain('## Context brief\nA short brief');
    expect(md).toContain('## Worktrees & branches');
    expect(md).toContain('feat/x');
    expect(md).toContain('## Repositories in scope');
  });

  describe('merge checks', () => {
    function seedPr(id: number): void {
      store.db
        .prepare(
          "INSERT INTO prs (ticket_id, repo, number, url, status) VALUES (?, 'frontend', 42, 'https://x/pr/42', 'open')",
        )
        .run(id);
    }

    function record(id: number, state: string, files: string[], reason: string | null): void {
      store.db
        .prepare(
          `INSERT INTO merge_checks (ticket_id, repo, state, files, reason, head_sha, base_sha, base_ref, checked_at)
           VALUES (?, 'frontend', ?, ?, ?, 'aaa', 'bbb', 'main', '2026-07-21T10:00:00.000Z')`,
        )
        .run(id, state, JSON.stringify(files), reason);
    }

    // A ticket shipped before merge checks existed must render byte-identically,
    // and its JSON must carry no new key — the CLI's consumers are agents.
    it('omits the merge suffix entirely when nothing was ever checked', () => {
      const t = createTicket(store, { key: 'PROJ-9', title: 'x' });
      seedPr(t.id);
      const ctx = buildTicketContext(store, undefined, t.id);

      expect(ctx.prs[0]).not.toHaveProperty('mergeCheck');
      expect(renderTicketContext(ctx)).toContain('- frontend #42 [open] — https://x/pr/42');
      expect(renderTicketContext(ctx)).not.toContain('merge:');
    });

    it('renders a clean check on the PR line', () => {
      const t = createTicket(store, { key: 'PROJ-9', title: 'x' });
      seedPr(t.id);
      record(t.id, 'clean', [], null);

      const md = renderTicketContext(buildTicketContext(store, undefined, t.id));

      expect(md).toContain('· merge: clean');
    });

    it('renders a conflict with the conflicting files', () => {
      const t = createTicket(store, { key: 'PROJ-9', title: 'x' });
      seedPr(t.id);
      record(t.id, 'conflicted', ['src/a.ts', 'src/b.ts'], null);

      const md = renderTicketContext(buildTicketContext(store, undefined, t.id));

      expect(md).toContain('merge: conflicted (2 files: src/a.ts, src/b.ts)');
    });

    // An agent reading this must be able to tell "checked, fine" from "we do not
    // know", and must get git's own words to act on.
    it('renders an unknown check with git’s reason, never as clean', () => {
      const t = createTicket(store, { key: 'PROJ-9', title: 'x' });
      seedPr(t.id);
      record(t.id, 'unknown', [], "fatal: couldn't find remote ref main");

      const md = renderTicketContext(buildTicketContext(store, undefined, t.id));

      expect(md).toContain("merge: unknown (fatal: couldn't find remote ref main)");
      expect(md).not.toContain('merge: clean');
    });
  });

  // A non-runnable repo used to render `start: undefined` into the agent's brief.
  it('renders a repository with no service without inventing a start command', () => {
    const t = createTicket(store, { key: 'P-1', title: 'x' });
    updateTicketFields(store, t.id, { selectedRepos: ['docs'] });
    const md = renderTicketContext(
      buildTicketContext(store, manifest({ docs: nonRunnable() }), t.id),
    );

    expect(md).toContain('- docs: /repos/docs (no service — not runnable)');
    expect(md).not.toContain('undefined');
    expect(md).not.toContain('start:');
  });

  // Previously `if (!def) continue` dropped it, telling the agent the repo did
  // not exist rather than that karst could not find it.
  it('says so when a selected repo is missing from the manifest, never dropping it', () => {
    const t = createTicket(store, { key: 'P-2', title: 'x' });
    updateTicketFields(store, t.id, { selectedRepos: ['ghost'] });
    const md = renderTicketContext(
      buildTicketContext(store, manifest({ docs: nonRunnable() }), t.id),
    );

    expect(md).toContain('- ghost: (not in karst.yml)');
  });

  it('renders runnable and non-runnable repos in one section, not two', () => {
    const t = createTicket(store, { key: 'P-3', title: 'x' });
    updateTicketFields(store, t.id, { selectedRepos: ['frontend', 'docs'] });
    const md = renderTicketContext(
      buildTicketContext(store, manifest({ frontend: svc(), docs: nonRunnable() }), t.id),
    );

    expect(md.match(/## Repositories in scope/g)).toHaveLength(1);
    expect(md).not.toContain('## Services');
    expect(md).toContain('- frontend: /repos/frontend (start: `npm run dev`)');
    expect(md).toContain('- docs: /repos/docs (no service — not runnable)');
  });

  it('omits empty sections and falls back to the heading for an empty ticket', () => {
    const t = createTicket(store, { key: '', title: '' });
    const ctx = buildTicketContext(store, undefined, t.id);
    const md = renderTicketContext(ctx);
    // A freshly created ticket seeds a `stages` row (§11) — a bare "where is
    // this ticket" line is not the kind of empty section this test is about.
    expect(md).toBe('# Ticket: Untitled ticket\n\n## Current stage\n- stage: scope (pending)');
    expect(md).not.toContain('## Prompt');
    expect(md).not.toContain('## Worktrees');
  });
});
