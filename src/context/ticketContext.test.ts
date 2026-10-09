import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { openStore, type Store } from '../store/db.js';
import { createTicket, pauseTicket, setStageCurrent, updateTicketFields } from '../store/tickets.js';
import { addRelation } from '../store/ticketRelations.js';
import { listInbox, markRead, postMessage } from '../store/ticketMessages.js';
import { insertAttachment } from '../store/attachments.js';
import { postAgentNote } from '../store/bulletinNotes.js';
import { recordGateRun } from '../store/gateRuns.js';
import { recordFindings } from '../store/reviewFindings.js';
import { setStage } from '../store/stages.js';
import { openStageRun, closeStageRun } from '../store/stageRuns.js';
import { buildTicketContext, renderTicketContext } from './ticketContext.js';
import { truncateToBudget, SEED_BUDGETS } from '../agent/seedBudget.js';
import type { Manifest, RepositoryDef, ServiceDef } from '../manifest/types.js';
import {
  manifest as buildManifest,
  repo as buildRepo,
  runnableRepo,
  slot,
  svc as buildService,
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
      id: parent.id,
      key: 'PROJ-1',
      title: 'Root work',
      brief: 'Built the thing.',
      prs: [{ repo: 'frontend', number: 7, url: 'https://x/pr/7' }],
    });

    const md = renderTicketContext(ctx);
    expect(md).toContain(`## Continuing from T${parent.id} · PROJ-1: Root work`);
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

  describe('sub-tasks (design NDL-70 §7)', () => {
    it("gives a sub-task its parent's ask, brief and branch — and not its PRs", () => {
      const parent = createTicket(store, { key: 'PROJ-1', title: 'Root work' });
      updateTicketFields(store, parent.id, {
        description: 'Build the whole thing',
        brief: 'Half done.',
      });
      store.db
        .prepare(
          "INSERT INTO worktrees (ticket_id, repo, path, branch, base_ref, deps_mode) VALUES (?, 'frontend', '/wt/parent', 'feat/root', 'main', 'inherited')",
        )
        .run(parent.id);
      store.db
        .prepare(
          "INSERT INTO prs (ticket_id, repo, number, url, status) VALUES (?, 'frontend', 7, 'https://x/pr/7', 'open')",
        )
        .run(parent.id);

      const child = createTicket(store, {
        key: 'PROJ-1-s1',
        title: 'Carved out piece',
        subtaskParentId: parent.id,
        blocksParent: true,
      });

      const ctx = buildTicketContext(store, undefined, child.id);
      expect(ctx.subtaskParent).toEqual({
        id: parent.id,
        key: 'PROJ-1',
        title: 'Root work',
        prompt: 'Build the whole thing',
        brief: 'Half done.',
        branches: [{ repo: 'frontend', branch: 'feat/root' }],
        blocksParent: true,
      });
      // A sub-task must not inherit the follow-up's shipped-PR view.
      expect(ctx.parent).toBeNull();

      const md = renderTicketContext(ctx);
      expect(md).toContain('## Parent task');
      expect(md).toContain(`T${parent.id} · PROJ-1: Root work [blocking]`);
      expect(md).toMatch(/blocks its parent/);
      expect(md).toContain('Build the whole thing');
      expect(md).toContain('- frontend: `feat/root`');
      expect(md).toMatch(/lands into the parent's branch, not into main/);
      expect(md).not.toContain('https://x/pr/7');
    });

    it('reports a non-blocking sub-task without the blocking tag (NDL-96)', () => {
      const parent = createTicket(store, { key: 'PROJ-1', title: 'Root work' });
      const child = createTicket(store, {
        key: 'PROJ-1-s2',
        title: 'Docs polish',
        subtaskParentId: parent.id,
        blocksParent: false,
      });

      const ctx = buildTicketContext(store, undefined, child.id);
      expect(ctx.subtaskParent).toEqual({
        id: parent.id,
        key: 'PROJ-1',
        title: 'Root work',
        prompt: null,
        brief: null,
        branches: [],
        blocksParent: false,
      });

      const md = renderTicketContext(ctx);
      expect(md).toContain('## Parent task');
      expect(md).toContain('PROJ-1: Root work —');
      expect(md).not.toContain('[blocking]');
      expect(md).not.toMatch(/blocks its parent/);
    });

    it('renders no parent task section for an ordinary ticket', () => {
      const t = createTicket(store, { key: 'PROJ-9', title: 'root' });
      const ctx = buildTicketContext(store, undefined, t.id);
      expect(ctx.subtaskParent).toBeNull();
      expect(renderTicketContext(ctx)).not.toContain('## Parent task');
    });

    it("lists a parent ticket's direct sub-tasks with stage and blocking flag", () => {
      const parent = createTicket(store, { key: 'PROJ-1', title: 'Root work' });
      const blocker = createTicket(store, {
        key: 'PROJ-1-s1',
        title: 'Schema first',
        subtaskParentId: parent.id,
        blocksParent: true,
      });
      const extra = createTicket(store, {
        key: 'PROJ-1-s2',
        title: 'Docs polish',
        subtaskParentId: parent.id,
      });
      store.db.prepare("UPDATE tickets SET stage_current = 'review' WHERE id = ?").run(blocker.id);
      store.db.prepare("UPDATE tickets SET stage_current = 'impl' WHERE id = ?").run(extra.id);

      const ctx = buildTicketContext(store, undefined, parent.id);
      expect(ctx.subtasks).toEqual([
        { id: blocker.id, key: 'PROJ-1-s1', title: 'Schema first', stageCurrent: 'review', blocksParent: true, pausedAt: null, autostartPending: false, queued: false },
        { id: extra.id, key: 'PROJ-1-s2', title: 'Docs polish', stageCurrent: 'impl', blocksParent: false, pausedAt: null, autostartPending: false, queued: false },
      ]);

      const md = renderTicketContext(ctx);
      expect(md).toContain('## Sub-tasks (2: 1 review, 1 impl)');
      expect(md).toMatch(/- T\d+ · PROJ-1-s1: Schema first \(stage: review\) \[blocking\]/);
      expect(md).toMatch(/- T\d+ · PROJ-1-s2: Docs polish \(stage: impl\)/);
    });

    it('renders paused sub-task with paused since and includes paused count in heading', () => {
      const parent = createTicket(store, { key: 'PROJ-1', title: 'Root work' });
      const child1 = createTicket(store, {
        key: 'PROJ-1-s1',
        title: 'Child 1',
        subtaskParentId: parent.id,
      });
      const child2 = createTicket(store, {
        key: 'PROJ-1-s2',
        title: 'Child 2',
        subtaskParentId: parent.id,
      });
      store.db.prepare("UPDATE tickets SET stage_current = 'scope' WHERE id = ?").run(child1.id);
      store.db.prepare("UPDATE tickets SET stage_current = 'impl' WHERE id = ?").run(child2.id);

      pauseTicket(store, child1.id);
      store.db.prepare("UPDATE tickets SET paused_at = '2026-10-07 13:21' WHERE id = ?").run(child1.id);

      const ctx = buildTicketContext(store, undefined, parent.id);
      expect(ctx.subtasks[0]!.pausedAt).toBe('2026-10-07 13:21');
      expect(ctx.subtasks[1]!.pausedAt).toBeNull();

      const md = renderTicketContext(ctx);
      expect(md).toContain('## Sub-tasks (2: 1 impl, 1 paused)');
      expect(md).toMatch(/- T\d+ · PROJ-1-s1: Child 1 \(stage: scope, paused since 2026-10-07 13:21\)/);
      expect(md).toMatch(/- T\d+ · PROJ-1-s2: Child 2 \(stage: impl\)/);
    });

    it('marks a sub-task queued only while autostart is pending at scope', () => {
      const parent = createTicket(store, { key: 'PROJ-1', title: 'Root work' });
      createTicket(store, {
        key: 'PROJ-1-s1',
        title: 'Waiting',
        subtaskParentId: parent.id,
        autostartPending: true,
      });
      const started = createTicket(store, {
        key: 'PROJ-1-s2',
        title: 'Running',
        subtaskParentId: parent.id,
        autostartPending: true,
      });
      store.db.prepare("UPDATE tickets SET stage_current = 'impl' WHERE id = ?").run(started.id);

      const ctx = buildTicketContext(store, undefined, parent.id);
      expect(ctx.subtasks.map((s) => [s.key, s.autostartPending, s.queued])).toEqual([
        ['PROJ-1-s1', true, true],
        ['PROJ-1-s2', true, false],
      ]);
      const md = renderTicketContext(ctx);
      expect(md).toMatch(/- T\d+ · PROJ-1-s1: Waiting \(stage: scope, queued\)/);
      expect(md).toMatch(/- T\d+ · PROJ-1-s2: Running \(stage: impl\)/);
    });

    it('omits the sub-tasks section when there are none, and ignores archived ones', () => {
      const parent = createTicket(store, { key: 'PROJ-1', title: 'Root work' });
      let ctx = buildTicketContext(store, undefined, parent.id);
      expect(ctx.subtasks).toEqual([]);
      expect(renderTicketContext(ctx)).not.toContain('## Sub-tasks');

      const child = createTicket(store, {
        key: 'PROJ-1-s1',
        title: 'Abandoned',
        subtaskParentId: parent.id,
      });
      store.db
        .prepare("UPDATE tickets SET archived_at = datetime('now') WHERE id = ?")
        .run(child.id);

      ctx = buildTicketContext(store, undefined, parent.id);
      expect(ctx.subtasks).toEqual([]);
      expect(renderTicketContext(ctx)).not.toContain('## Sub-tasks');
    });

    it('degrades gracefully when the sub-task parent has been hard-deleted', () => {
      const parent = createTicket(store, { key: 'PROJ-1', title: 'Root work' });
      const child = createTicket(store, {
        key: 'PROJ-1-s1',
        title: 'Carved out piece',
        subtaskParentId: parent.id,
      });
      store.db.prepare('DELETE FROM tickets WHERE id = ?').run(parent.id);

      const ctx = buildTicketContext(store, undefined, child.id);
      expect(ctx.subtaskParent).toBeNull();
      expect(renderTicketContext(ctx)).not.toContain('## Parent task');
    });
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
      gates: [{ name: 'lint (web)', exitCode: 1, skipped: false, summary: null }],
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
    expect(ctx.stage?.gates).toEqual([{ name: 'test (web)', exitCode: 0, skipped: false, summary: null }]);
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
      { name: 'test', exitCode: 0, skipped: false, summary: null },
      { name: 'e2e', exitCode: null, skipped: true, summary: null },
    ]);
    const md = renderTicketContext(ctx);
    expect(md).toContain('disabled for this ticket');
  });

  it('surfaces a failing gate output excerpt in the context, not just the exit code', () => {
    const t = createTicket(store, { key: 'PROJ-5', title: 't' });
    store.db.prepare('UPDATE tickets SET stage_current = ? WHERE id = ?').run('review', t.id);
    setStage(store, t.id, 'review', { status: 'failed', verdict: 'gates failed: lint (web)' });
    recordGateRun(store, {
      ticketId: t.id,
      stageKey: 'review',
      attempt: 0,
      runAt: '2026-08-01T10:00:00.000Z',
      gates: [
        {
          gateName: 'lint (web)',
          exitCode: 1,
          summary: 'src/pages/index.vue:23:9 Replace `x` with `y`',
        },
      ],
    });

    const ctx = buildTicketContext(store, undefined, t.id);
    expect(ctx.stage?.gates).toEqual([
      { name: 'lint (web)', exitCode: 1, skipped: false, summary: 'src/pages/index.vue:23:9 Replace `x` with `y`' },
    ]);
    const md = renderTicketContext(ctx);
    // The verdict names the gate; the summary says what to fix — both reach the
    // agent so it never has to open the artifact log to learn the failure.
    expect(md).toContain('- verdict: gates failed: lint (web)');
    expect(md).toContain('- lint (web): exit 1');
    expect(md).toContain('src/pages/index.vue:23:9 Replace `x` with `y`');
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

  it('renders paused since and resume hint under Current stage when ticket is paused', () => {
    const t = createTicket(store, { key: 'PROJ-P', title: 'Paused ticket' });
    pauseTicket(store, t.id);
    store.db.prepare("UPDATE tickets SET paused_at = '2026-10-07 13:21' WHERE id = ?").run(t.id);

    const ctx = buildTicketContext(store, undefined, t.id);
    expect(ctx.paused).toBe(true);
    expect(ctx.pausedAt).toBe('2026-10-07 13:21');

    const md = renderTicketContext(ctx);
    expect(md).toContain('- paused since 2026-10-07 13:21 — gates do not run; resume: karst unpause PROJ-P');
  });

  it('surfaces block reason when block is recorded on another stage row', () => {
    const t = createTicket(store, { key: 'PARENT-B', title: 'Parent' });
    store.db.prepare("UPDATE tickets SET stage_current = 'impl' WHERE id = ?").run(t.id);
    // Block recorded on ship stage row (e.g. from sub-task integration or ship park)
    setStage(store, t.id, 'ship', {
      blockedKind: 'awaiting-subtask',
      blockedReason: 'sub-task integration failed: git fetch failed integrating S-1',
    });

    const ctx = buildTicketContext(store, undefined, t.id);
    expect(ctx.stage?.blocked).toEqual({
      kind: 'awaiting-subtask',
      reason: 'sub-task integration failed: git fetch failed integrating S-1',
    });

    const md = renderTicketContext(ctx);
    expect(md).toContain('- blocked: awaiting-subtask — sub-task integration failed: git fetch failed integrating S-1');
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
    expect(md).toContain(`# Ticket: T${t.id} · PROJ-9 — Do research`);
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

  it('lists each service of a multi-service repository with its cwd when set', () => {
    const t = createTicket(store, { key: 'P-4', title: 'x' });
    updateTicketFields(store, t.id, { selectedRepos: ['mono'] });
    const mono = buildRepo({
      repoPath: '/repos/mono',
      services: {
        web: buildService({ start: 'npm run dev', cwd: 'apps/web' }),
        api: buildService({ start: 'go run .' }),
      },
    });
    const md = renderTicketContext(buildTicketContext(store, manifest({ mono }), t.id));

    expect(md).toContain('- mono/web: /repos/mono (start: `npm run dev`, cwd: apps/web)');
    expect(md).toContain('- mono/api: /repos/mono (start: `go run .`)');
    expect(md).not.toContain('- mono:');
  });

  it('omits empty sections and falls back to the heading for an empty ticket', () => {
    const t = createTicket(store, { key: '', title: '' });
    const ctx = buildTicketContext(store, undefined, t.id);
    const md = renderTicketContext(ctx);
    // A freshly created ticket seeds a `stages` row (§11) — a bare "where is
    // this ticket" line is not the kind of empty section this test is about.
    expect(md).toBe(`# Ticket: T${t.id}\n\n## Current stage\n- stage: scope (pending)`);
    expect(md).not.toContain('## Prompt');
    expect(md).not.toContain('## Worktrees');
  });

  describe('sections mode', () => {
    function populate(): number {
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
      store.db.prepare('UPDATE tickets SET stage_current = ? WHERE id = ?').run('review', t.id);
      setStage(store, t.id, 'review', { status: 'running' });
      recordGateRun(store, {
        ticketId: t.id,
        stageKey: 'review',
        attempt: 0,
        runAt: '2026-08-01T10:00:00.000Z',
        gates: [{ gateName: 'lint', exitCode: 1 }],
      });
      return t.id;
    }

    it('omits all five operational headings for a fully populated fixture', () => {
      const id = populate();
      const ctx = buildTicketContext(store, manifest({ frontend: svc() }), id);
      const md = renderTicketContext(ctx, undefined, { sections: 'narrative' });
      expect(md).not.toContain('## Current stage');
      expect(md).not.toContain('## Repositories in scope');
      expect(md).not.toContain('## Worktrees & branches');
      expect(md).not.toContain('## Running servers');
      expect(md).not.toContain('## Pull requests');
    });

    it('keeps Prompt, Context brief, Attachments, and Continuing from in narrative mode', () => {
      const parent = createTicket(store, { key: 'PROJ-1', title: 'Parent' });
      updateTicketFields(store, parent.id, { brief: 'Built the thing.' });
      store.db.prepare("UPDATE tickets SET stage_current = 'done' WHERE id = ?").run(parent.id);

      const t = createTicket(store, { key: 'PROJ-2', title: 'Child', parentTicketId: parent.id });
      updateTicketFields(store, t.id, { description: 'Do the work', brief: 'Some brief' });
      insertAttachment(store, {
        ticketId: t.id,
        kind: 'image',
        storedName: 'a.png',
        originalName: 'img.png',
        byteSize: 1,
      });

      const ctx = buildTicketContext(store, undefined, t.id, '/storage');
      const md = renderTicketContext(ctx, undefined, { sections: 'narrative' });
      expect(md).toContain('## Prompt');
      expect(md).toContain('## Context brief');
      expect(md).toContain('## Attachments');
      expect(md).toContain('## Continuing from');
    });

    it('omitting sections produces output identical to sections: all', () => {
      const id = populate();
      const ctx = buildTicketContext(store, manifest({ frontend: svc() }), id);
      const withoutOpt = renderTicketContext(ctx);
      const withAll = renderTicketContext(ctx, undefined, { sections: 'all' });
      expect(withoutOpt).toBe(withAll);
    });

    it('keeps the five operational headings and no authored text in facts mode', () => {
      const id = populate();
      const ctx = buildTicketContext(store, manifest({ frontend: svc() }), id);
      const md = renderTicketContext(ctx, undefined, { sections: 'facts' });
      expect(md).toContain('## Current stage');
      expect(md).toContain('## Repositories in scope');
      expect(md).toContain('## Worktrees & branches');
      expect(md).toContain('## Running servers');
      expect(md).toContain('## Pull requests');
      // Authored text belongs to the other half.
      expect(md).not.toContain('# Ticket:');
      expect(md).not.toContain('## Prompt');
      expect(md).not.toContain('## Context brief');
      expect(md).not.toContain('## Attachments');
    });

    it('keeps parent/sub-task summaries and the inbox pointer out of facts mode', () => {
      const parent = createTicket(store, { key: 'PROJ-1', title: 'Parent' });
      updateTicketFields(store, parent.id, { brief: 'Built the thing.' });
      const t = createTicket(store, { key: 'PROJ-2', title: 'Child', parentTicketId: parent.id });
      updateTicketFields(store, t.id, { description: 'Do the work', brief: 'Some brief' });
      const ctx = buildTicketContext(store, undefined, t.id, '/storage');
      const md = renderTicketContext(ctx, undefined, { sections: 'facts' });
      expect(md).not.toContain('## Continuing from');
      expect(md).not.toContain('## Prompt');
      expect(md).not.toContain('## Inbox');
    });
  });

  describe('seed budget truncation', () => {
    it('truncates an oversized prompt with the stated pointer, and reports it via debug', () => {
      const t = createTicket(store, { key: 'PROJ-9', title: 'Big' });
      // 'q' is absent from the truncation pointer text itself (which contains a
      // literal "x" in "context"), so counting it isolates the truncated content.
      updateTicketFields(store, t.id, { description: 'q'.repeat(10_000) });
      const ctx = buildTicketContext(store, undefined, t.id);
      const seen: string[] = [];
      const md = renderTicketContext(ctx, (m) => seen.push(m));
      expect(md).toContain('truncated -- run `karst context PROJ-9` for the full state.');
      expect(md.match(/q/g)!.length).toBe(4000);
      expect(seen.some((m) => m.includes('prompt'))).toBe(true);
    });

    it('truncates an oversized brief with the stated pointer', () => {
      const t = createTicket(store, { key: 'PROJ-9', title: 'Big' });
      updateTicketFields(store, t.id, { brief: 'y'.repeat(10_000) });
      const ctx = buildTicketContext(store, undefined, t.id);
      const md = renderTicketContext(ctx);
      expect(md).toContain('truncated -- run `karst context PROJ-9` for the full state.');
      expect(md.match(/y/g)!.length).toBe(3000);
    });

    it('does not truncate a prompt under budget', () => {
      const t = createTicket(store, { key: 'PROJ-1', title: 'Small' });
      updateTicketFields(store, t.id, { description: 'short prompt' });
      const ctx = buildTicketContext(store, undefined, t.id);
      const md = renderTicketContext(ctx);
      expect(md).not.toContain('truncated --');
      expect(md).toContain('short prompt');
    });

    it('truncates an oversized gate summary excerpt with the stated pointer, and reports it via debug', () => {
      const t = createTicket(store, { key: 'PROJ-9', title: 'Big' });
      const summaryRaw = 'z'.repeat(5_000);
      store.db.prepare('UPDATE tickets SET stage_current = ? WHERE id = ?').run('review', t.id);
      setStage(store, t.id, 'review', { status: 'running' });
      recordGateRun(store, {
        ticketId: t.id,
        stageKey: 'review',
        attempt: 0,
        runAt: '2026-08-01T10:00:00.000Z',
        gates: [{ gateName: 'lint (web)', exitCode: 1, summary: summaryRaw }],
      });

      const ctx = buildTicketContext(store, undefined, t.id);
      const seen: string[] = [];
      const md = renderTicketContext(ctx, (m) => seen.push(m));
      const { text: expected } = truncateToBudget(summaryRaw, SEED_BUDGETS.gateSummary, 'PROJ-9');
      expect(md).toContain('truncated -- run `karst context PROJ-9` for the full state.');
      expect(md).toContain(expected);
      expect(md.match(/z/g)!.length).toBe(SEED_BUDGETS.gateSummary);
      expect(seen.some((m) => m.includes('gate summary'))).toBe(true);
    });

    it('truncates an oversized findings list with the stated pointer, and reports it via debug', () => {
      const t = createTicket(store, { key: 'PROJ-9', title: 'Big' });
      store.db.prepare('UPDATE tickets SET stage_current = ? WHERE id = ?').run('review', t.id);
      setStage(store, t.id, 'review', { status: 'running' });
      recordFindings(store, {
        ticketId: t.id,
        attempt: 0,
        runAt: '2026-08-01T10:00:00.000Z',
        findings: [
          {
            severity: 'info',
            repo: '/web',
            file: null,
            line: null,
            title: 'w'.repeat(3_000),
            detail: 'd',
            source: 'agent',
          },
        ],
      });

      const ctx = buildTicketContext(store, undefined, t.id);
      const seen: string[] = [];
      const md = renderTicketContext(ctx, (m) => seen.push(m));
      const findingsBlock = `  - [info] ${'w'.repeat(3_000)}`;
      const { text: expected } = truncateToBudget(findingsBlock, SEED_BUDGETS.findings, 'PROJ-9');
      expect(md).toContain('truncated -- run `karst context PROJ-9` for the full state.');
      expect(md).toContain(expected);
      expect(seen.some((m) => m.includes('findings'))).toBe(true);
    });

    it('truncates an oversized attachments block with the stated pointer, and reports it via debug', () => {
      const t = createTicket(store, { key: 'PROJ-9', title: 'Big' });
      for (let i = 0; i < 20; i++) {
        insertAttachment(store, {
          ticketId: t.id,
          kind: 'file',
          storedName: `f${i}.txt`,
          originalName: 'v'.repeat(200),
          byteSize: 1,
        });
      }

      const ctx = buildTicketContext(store, undefined, t.id, '/storage');
      const rowsBlock = ctx.attachments
        .map((a) => {
          const note = a.kind === 'video' ? ' (not agent-readable)' : '';
          return `- ${a.kind}: ${a.path} — "${a.name}"${note}`;
        })
        .join('\n');
      const seen: string[] = [];
      const md = renderTicketContext(ctx, (m) => seen.push(m));
      const { text: expected, truncated } = truncateToBudget(rowsBlock, SEED_BUDGETS.attachments, 'PROJ-9');
      expect(truncated).toBe(true);
      expect(md).toContain('truncated -- run `karst context PROJ-9` for the full state.');
      expect(md).toContain(expected);
      expect(seen.some((m) => m.includes('attachments'))).toBe(true);
    });

    it('does not call debug when nothing needs truncating', () => {
      const t = createTicket(store, { key: 'PROJ-1', title: 'Small' });
      updateTicketFields(store, t.id, { description: 'short prompt', brief: 'short brief' });
      store.db.prepare('UPDATE tickets SET stage_current = ? WHERE id = ?').run('review', t.id);
      setStage(store, t.id, 'review', { status: 'running' });
      recordGateRun(store, {
        ticketId: t.id,
        stageKey: 'review',
        attempt: 0,
        runAt: '2026-08-01T10:00:00.000Z',
        gates: [{ gateName: 'lint (web)', exitCode: 0, summary: 'short summary' }],
      });
      recordFindings(store, {
        ticketId: t.id,
        attempt: 0,
        runAt: '2026-08-01T10:00:00.000Z',
        findings: [
          { severity: 'low', repo: '/web', file: null, line: null, title: 'minor nit', detail: 'd', source: 'agent' },
        ],
      });
      insertAttachment(store, {
        ticketId: t.id,
        kind: 'file',
        storedName: 'a.txt',
        originalName: 'notes.txt',
        byteSize: 1,
      });

      const ctx = buildTicketContext(store, undefined, t.id, '/storage');
      const seen: string[] = [];
      const md = renderTicketContext(ctx, (m) => seen.push(m));
      expect(md).not.toContain('truncated --');
      expect(seen).toEqual([]);
    });

    // Empty-string key is a real case (`key: ''`, § the "omits empty sections"
    // test above): `??` does not catch it, and the old fallback used the
    // ticket TITLE, which can contain spaces/punctuation and produce an
    // unrunnable shell command. A literal placeholder like 'this ticket' is
    // shell-safe but still not runnable — it resolves nothing. `id` is always
    // present and `karst context <id>` accepts a bare numeric id (§
    // resolveTicketByKey), so it is the fallback that actually works.
    it('falls back to a runnable pointer for a keyless ticket, never the title', () => {
      const t = createTicket(store, { key: '', title: 'My Ticket With Spaces' });
      updateTicketFields(store, t.id, { description: 'q'.repeat(10_000) });
      const ctx = buildTicketContext(store, undefined, t.id);
      const md = renderTicketContext(ctx);
      expect(md).toContain(`truncated -- run \`karst context ${t.id}\` for the full state.`);
      expect(md).not.toContain('My Ticket With Spaces` for the full state');
    });

    // The CLI's `--md` path (`src/cli/context.ts`) is meant to be the full-state
    // escape hatch the truncation pointer sends the agent to. Before this, it
    // rendered the SAME bounded text — a dead end. `bounded: false` skips every
    // truncation call and renders the raw text, with no truncation pointer.
    it('renders unbounded, with no truncation pointer, when bounded is false', () => {
      const t = createTicket(store, { key: 'PROJ-9', title: 'Big' });
      const hugePrompt = 'q'.repeat(10_000);
      updateTicketFields(store, t.id, { description: hugePrompt });
      const ctx = buildTicketContext(store, undefined, t.id);
      const seen: string[] = [];
      const md = renderTicketContext(ctx, (m) => seen.push(m), { bounded: false });
      expect(md).toContain(hugePrompt);
      expect(md.match(/q/g)!.length).toBe(10_000);
      expect(md).not.toContain('truncated --');
      expect(seen).toEqual([]);
    });
  });

  describe('project notes index', () => {
    /** A ticket with a worktree in `repo`, so its note scope matches that repo. */
    function ticketIn(key: string, repo: string): number {
      const t = createTicket(store, { key, title: key });
      store.db
        .prepare(
          "INSERT INTO worktrees (ticket_id, repo, path, branch, base_ref, deps_mode) VALUES (?, ?, ?, 'feat/x', 'main', 'inherited')",
        )
        .run(t.id, repo, `/wt/${key}`);
      return t.id;
    }
    function postNote(fromTicketId: number, title: string, body = 'body'): void {
      postAgentNote(store, { projectId: null, fromTicketId, title, body });
    }

    it('lists matching note titles and never a body', () => {
      const reader = ticketIn('PROJ-R1', 'frontend');
      const poster = ticketIn('PROJ-P1', 'frontend');
      postNote(poster, 'Auth tokens rotate', 'DISTINCTIVE-SECRET-BODY-XYZ');
      const ctx = buildTicketContext(store, undefined, reader);
      expect(ctx.notes).toEqual({ unread: 1, titles: ['Auth tokens rotate'] });
      const md = renderTicketContext(ctx);
      expect(md).toContain('## Project notes');
      expect(md).toContain('1 unread project note');
      expect(md).toContain('karst notes');
      expect(md).toContain('- Auth tokens rotate');
      expect(md).not.toContain('DISTINCTIVE-SECRET-BODY-XYZ');
    });

    it('sanitizes control characters and newlines from a stored title', () => {
      const reader = ticketIn('PROJ-R2', 'frontend');
      const poster = ticketIn('PROJ-P2', 'frontend');
      // postAgentNote refuses such titles, so a row that carries one is written directly.
      store.db
        .prepare(
          `INSERT INTO bulletin_notes (project_id, source, from_ticket_id, merge_sha, title, body, repos, paths)
           VALUES (NULL, 'agent', ?, NULL, ?, 'b', '["frontend"]', NULL)`,
        )
        .run(poster, 'Evil\n## Injected\u0007 title');
      const md = renderTicketContext(buildTicketContext(store, undefined, reader));
      expect(md).toContain('- Evil## Injected title');
      expect(md).not.toContain('\u0007');
      expect(md).not.toContain('\n## Injected');
    });

    it('caps the listed titles at 10 and reports the remainder', () => {
      const reader = ticketIn('PROJ-R3', 'frontend');
      const poster = ticketIn('PROJ-P3', 'frontend');
      for (let i = 1; i <= 12; i++) postNote(poster, `Note ${i}`);
      const ctx = buildTicketContext(store, undefined, reader);
      expect(ctx.notes.unread).toBe(12);
      expect(ctx.notes.titles).toHaveLength(10);
      const md = renderTicketContext(ctx);
      const titleLines = md.split('\n').filter((l) => l.startsWith('- Note '));
      expect(titleLines).toHaveLength(10);
      expect(md).toContain('- … and 2 more');
    });

    it('renders nothing when no unread note matches this ticket', () => {
      const reader = ticketIn('PROJ-R4', 'frontend');
      const elsewhere = ticketIn('PROJ-P4', 'backend');
      postNote(elsewhere, 'Backend only');
      const ctx = buildTicketContext(store, undefined, reader);
      expect(ctx.notes).toEqual({ unread: 0, titles: [] });
      expect(renderTicketContext(ctx)).not.toContain('## Project notes');
    });

    it.each([
      ['scope', true],
      ['impl', true],
      ['uat', false],
      ['review', false],
      ['fix', false],
      ['ship', false],
      ['done', false],
    ] as const)('adds the read-first reminder at %s only: %s', (stage, expected) => {
      const reader = ticketIn(`PROJ-S-${stage}`, 'frontend');
      const poster = ticketIn(`PROJ-SP-${stage}`, 'frontend');
      postNote(poster, 'Relevant learning');
      store.db.prepare('UPDATE tickets SET stage_current = ? WHERE id = ?').run(stage, reader);
      const md = renderTicketContext(buildTicketContext(store, undefined, reader));
      expect(md).toContain('- Relevant learning');
      const reminder = 'Read these before you start: unread notes may change your plan.';
      if (expected) expect(md).toContain(reminder);
      else expect(md).not.toContain(reminder);
    });
  });

  describe('inbox', () => {
    it('reports the unread mailbox count and renders a line only when non-zero', () => {
      const parent = createTicket(store, { key: 'PROJ-1', title: 'Root work' });
      const child = createTicket(store, {
        key: 'PROJ-1-s1',
        title: 'Piece',
        subtaskParentId: parent.id,
      });
      let ctx = buildTicketContext(store, undefined, parent.id);
      expect(ctx.inbox).toEqual({ unread: 0 });
      expect(renderTicketContext(ctx)).not.toContain('## Inbox');

      for (const body of ['a', 'b']) {
        postMessage(store, {
          projectId: null,
          fromTicketId: child.id,
          toTicketId: parent.id,
          kind: 'message',
          body,
        });
      }
      markRead(store, [listInbox(store, parent.id, { unreadOnly: true })[0]!.id]);

      ctx = buildTicketContext(store, undefined, parent.id);
      expect(ctx.inbox).toEqual({ unread: 1 });
      const md = renderTicketContext(ctx);
      expect(md).toContain('## Inbox');
      expect(md).toContain('1 unread message');
      expect(md).toContain('karst inbox');
      // The count is a pointer, never the bodies.
      expect(md).not.toContain('\nb\n');
    });
  });

  describe('blockers', () => {
    it('lists only landed blockers, read-only, in the narrative render and not the facts render', () => {
      const blocker = createTicket(store, { key: 'B-1', title: 'First' });
      const dependent = createTicket(store, { key: 'D-1', title: 'Second' });
      updateTicketFields(store, blocker.id, { brief: 'Ship the widget.' });
      addRelation(store, { ticketId: dependent.id, kind: 'blocked-by', targetTicketId: blocker.id, source: 'user' });

      let ctx = buildTicketContext(store, undefined, dependent.id);
      expect(ctx.blockers).toEqual([]);
      expect(renderTicketContext(ctx)).not.toContain('## Blockers');

      setStageCurrent(store, blocker.id, 'done');
      ctx = buildTicketContext(store, undefined, dependent.id);
      expect(ctx.blockers.map((b) => b.key)).toEqual(['B-1']);
      const md = renderTicketContext(ctx);
      expect(md).toContain('## Blockers');
      expect(md).toContain('B-1 landed: First');
      expect(md).toContain('> Ship the widget.');
      expect(md).toContain('karst context B-1');
      expect(renderTicketContext(ctx, undefined, { sections: 'facts' })).not.toContain('## Blockers');
    });
  });

  describe('prefixed ids', () => {
    it('heading and self line carry the T<n> id', () => {
      const t = createTicket(store, { key: 'ABC-123', title: 'Do it' });
      const ctx = buildTicketContext(store, undefined, t.id);
      const all = renderTicketContext(ctx);
      expect(all).toContain(`# Ticket: T${t.id} · ABC-123 — Do it`);
      expect(all).not.toContain('You are working on');
      const narrative = renderTicketContext(ctx, undefined, { sections: 'narrative' });
      expect(narrative).not.toContain('You are working on');
      expect(narrative).toContain('# Ticket: ABC-123 — Do it');
      expect(narrative).not.toContain(`T${t.id}`);
      const facts = renderTicketContext(ctx, undefined, { sections: 'facts' });
      expect(facts.split('\n')[0]).toBe(`You are working on T${t.id} (ABC-123).`);
    });

    it('narrative + facts state the id exactly once', () => {
      const t = createTicket(store, { key: 'ABC-9', title: 'Once' });
      const ctx = buildTicketContext(store, undefined, t.id);
      const both =
        renderTicketContext(ctx, undefined, { sections: 'narrative' }) +
        renderTicketContext(ctx, undefined, { sections: 'facts' });
      expect(both.split(`T${t.id}`).length - 1).toBe(1);
    });

    it('heading without key or title is just the id', () => {
      const t = createTicket(store, { key: '', title: '' });
      const md = renderTicketContext(buildTicketContext(store, undefined, t.id));
      expect(md.startsWith(`# Ticket: T${t.id}\n`)).toBe(true);
      const facts = renderTicketContext(buildTicketContext(store, undefined, t.id), undefined, { sections: 'facts' });
      expect(facts.split('\n')[0]).toBe(`You are working on T${t.id}.`);
    });

    it('sub-task names its parent in the self line, Parent task and rows', () => {
      const parent = createTicket(store, { key: 'PK-1', title: 'Parent' });
      const child = createTicket(store, { key: '', title: 'Kid', subtaskParentId: parent.id });
      const ctx = buildTicketContext(store, undefined, child.id);
      const first = renderTicketContext(ctx, undefined, { sections: 'facts' }).split('\n')[0];
      expect(first).toContain(`This is a sub-task of T${parent.id}.`);
      expect(renderTicketContext(ctx)).toContain(`sub-task of T${parent.id} · PK-1: Parent`);
      const rows = renderTicketContext(buildTicketContext(store, undefined, parent.id));
      expect(rows).toContain(`- T${child.id}: Kid (stage:`);
      expect(rows).not.toContain(`#${child.id}`);
    });

    it('follow-up names its parent with the prefixed ref', () => {
      const parent = createTicket(store, { key: 'PK-2', title: 'Shipped' });
      const child = createTicket(store, { key: 'PK-2-fu', title: 'fu', parentTicketId: parent.id });
      const md = renderTicketContext(buildTicketContext(store, undefined, child.id));
      expect(md).toContain(`## Continuing from T${parent.id} · PK-2: Shipped`);
    });
  });
});
