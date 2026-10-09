import { describe, it, expect, beforeEach } from 'vitest';
import { openStore } from '../store/db.js';
import { createTicket, getTicket, updateTicketFields } from '../store/tickets.js';
import { manifest, repo } from '../manifest/fixtures.js';
import { parseBaseArgs, runBaseCommand } from './baseCommand.js';
import type { GitRunner } from '../integrations/git.js';

describe('parseBaseArgs', () => {
  it('parses base set with positional repo and baseRef', () => {
    const res = parseBaseArgs(['base', 'set', 'api', 'develop']);
    expect(res).toEqual({
      action: 'set',
      repo: 'api',
      baseRef: 'develop',
      rebase: false,
      ticket: undefined,
      json: false,
    });
  });

  it('parses --rebase flag', () => {
    const res = parseBaseArgs(['base', 'set', 'api', 'develop', '--rebase']);
    expect(res.rebase).toBe(true);
  });

  it('parses --ticket flag', () => {
    const res = parseBaseArgs(['base', 'set', 'api', 'develop', '--ticket', 'SUB-1']);
    expect(res.ticket).toBe('SUB-1');
  });

  it('parses base reset', () => {
    const res = parseBaseArgs(['base', 'reset', 'api']);
    expect(res).toEqual({
      action: 'reset',
      repo: 'api',
      baseRef: undefined,
      rebase: false,
      ticket: undefined,
      json: false,
    });
  });

  it('throws on missing repo', () => {
    expect(() => parseBaseArgs(['base', 'set'])).toThrow(/missing <repo>/);
    expect(() => parseBaseArgs(['base', 'reset'])).toThrow(/missing <repo>/);
  });

  it('throws on missing baseRef for set', () => {
    expect(() => parseBaseArgs(['base', 'set', 'api'])).toThrow(/missing <baseRef>/);
  });

  it('throws on unknown action', () => {
    expect(() => parseBaseArgs(['base', 'unknown', 'api'])).toThrow(/unknown base action/);
  });

  it('throws on unknown flag', () => {
    expect(() => parseBaseArgs(['base', 'set', 'api', 'develop', '--unknown'])).toThrow(/unknown flag/);
  });
});

describe('runBaseCommand', () => {
  let store: ReturnType<typeof openStore>;
  const fixtureManifest = manifest({
    api: repo({ repoPath: '/repos/api', baselineBranch: 'main' }),
    web: repo({ repoPath: '/repos/web', baselineBranch: 'main' }),
  });

  beforeEach(() => {
    store = openStore(':memory:');
  });

  function addWorktree(
    ticketId: number,
    repoName: string,
    path: string,
    branch: string,
    baseRef: string,
  ) {
    store.db
      .prepare(
        'INSERT INTO worktrees (ticket_id, repo, path, branch, base_ref) VALUES (?, ?, ?, ?, ?)',
      )
      .run(ticketId, repoName, path, branch, baseRef);
  }

  describe('permission checks', () => {
    it('allows a session to change base for its own ticket', async () => {
      const parent = createTicket(store, { key: 'P-1', title: 'Parent', projectId: 1 });
      const out = await runBaseCommand(
        store,
        fixtureManifest,
        ['base', 'set', 'api', 'develop'],
        {
          ticket: 'P-1',
          sessionTicketKey: 'P-1',
        },
      );
      expect(out).toContain('Base branch for api set to develop');
      expect(getTicket(store, parent.id).baseRefs?.api).toBe('develop');
    });

    it('allows a session to change base for its direct sub-task', async () => {
      const parent = createTicket(store, { key: 'P-1', title: 'Parent', projectId: 1 });
      const child = createTicket(store, {
        key: 'C-1',
        title: 'Child',
        subtaskParentId: parent.id,
        projectId: 1,
      });

      const out = await runBaseCommand(
        store,
        fixtureManifest,
        ['base', 'set', 'api', 'feature-x', '--ticket', 'C-1'],
        {
          sessionTicketKey: 'P-1',
        },
      );
      expect(out).toContain('Base branch for api set to feature-x');
      expect(getTicket(store, child.id).baseRefs?.api).toBe('feature-x');
    });

    it('refuses when a session targets an unrelated ticket', async () => {
      createTicket(store, { key: 'P-1', title: 'Parent', projectId: 1 });
      createTicket(store, { key: 'OTHER-1', title: 'Other', projectId: 1 });

      await expect(
        runBaseCommand(
          store,
          fixtureManifest,
          ['base', 'set', 'api', 'develop', '--ticket', 'OTHER-1'],
          {
            sessionTicketKey: 'P-1',
          },
        ),
      ).rejects.toThrow(/Permission denied.*allowed scope: own ticket or direct sub-tasks/);
    });

    it('refuses when a sub-task session tries to change its parent base', async () => {
      const parent = createTicket(store, { key: 'P-1', title: 'Parent', projectId: 1 });
      createTicket(store, {
        key: 'C-1',
        title: 'Child',
        subtaskParentId: parent.id,
        projectId: 1,
      });

      await expect(
        runBaseCommand(
          store,
          fixtureManifest,
          ['base', 'set', 'api', 'develop', '--ticket', 'P-1'],
          {
            sessionTicketKey: 'C-1',
          },
        ),
      ).rejects.toThrow(/Permission denied/);
    });
  });

  describe('pre-spin base set & reset', () => {
    it('sets baseRef in tickets.base_refs pre-spin', async () => {
      const t = createTicket(store, { key: 'T-1', title: 'Ticket', projectId: 1 });
      const out = await runBaseCommand(
        store,
        fixtureManifest,
        ['base', 'set', 'api', 'release/1.0', '--ticket', 'T-1'],
      );
      expect(out).toBe('Base branch for api set to release/1.0.');
      expect(getTicket(store, t.id).baseRefs?.api).toBe('release/1.0');
    });

    it('supports --json pre-spin', async () => {
      const t = createTicket(store, { key: 'T-1', title: 'Ticket', projectId: 1 });
      const out = await runBaseCommand(
        store,
        fixtureManifest,
        ['base', 'set', 'api', 'develop', '--ticket', 'T-1', '--json'],
      );
      const parsed = JSON.parse(out);
      expect(parsed).toEqual({
        ok: true,
        ticketId: t.id,
        repo: 'api',
        baseRef: 'develop',
        preSpin: true,
      });
    });

    it('resets baseRef by deleting from tickets.base_refs pre-spin', async () => {
      const t = createTicket(store, {
        key: 'T-1',
        title: 'Ticket',
        projectId: 1,
      });
      updateTicketFields(store, t.id, { baseRefs: { api: 'develop', web: 'staging' } });
      const out = await runBaseCommand(
        store,
        fixtureManifest,
        ['base', 'reset', 'api', '--ticket', 'T-1'],
      );
      expect(out).toBe('Base branch for api reset to default.');
      expect(getTicket(store, t.id).baseRefs?.api).toBeUndefined();
      expect(getTicket(store, t.id).baseRefs?.web).toBe('staging');
    });
  });

  describe('post-spin base set & reset', () => {
    const fakeGit: GitRunner = async (args) => {
      const joined = args.join(' ');
      if (joined.startsWith('merge-base')) {
        return { stdout: 'sha1', stderr: '', exitCode: 0 };
      }
      if (joined.startsWith('diff')) {
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    };

    it('runs live changeBaseRef post-spin without rebase by default', async () => {
      const t = createTicket(store, { key: 'T-1', title: 'Ticket', projectId: 1 });
      addWorktree(t.id, '/repos/api', '/wt/T-1/api', 'karst/T-1', 'main');

      const out = await runBaseCommand(
        store,
        fixtureManifest,
        ['base', 'set', 'api', 'develop', '--ticket', 'T-1'],
        { git: fakeGit },
      );
      expect(out).toContain('Re-targeted to develop (not rebased)');
      expect(out).toContain('Merge check cleared.');

      const wt = store.db
        .prepare('SELECT base_ref FROM worktrees WHERE ticket_id = ? AND repo = ?')
        .get(t.id, '/repos/api') as { base_ref: string };
      expect(wt.base_ref).toBe('develop');
      expect(getTicket(store, t.id).baseRefs?.api).toBe('develop');
    });

    describe('a refused live change persists nothing', () => {
      const failingGit: GitRunner = async () => ({ stdout: '', stderr: 'boom', exitCode: 1 });

      it('set leaves tickets.base_refs and the worktree base untouched', async () => {
        const t = createTicket(store, { key: 'T-1', title: 'Ticket', projectId: 1 });
        addWorktree(t.id, '/repos/api', '/wt/T-1/api', 'karst/T-1', 'main');

        await expect(
          runBaseCommand(store, fixtureManifest, ['base', 'set', 'api', 'develop', '--rebase', '--ticket', 'T-1'], {
            git: failingGit,
          }),
        ).rejects.toThrow();

        expect(getTicket(store, t.id).baseRefs?.api).toBeUndefined();
        const wt = store.db
          .prepare('SELECT base_ref FROM worktrees WHERE ticket_id = ?')
          .get(t.id) as { base_ref: string };
        expect(wt.base_ref).toBe('main');
      });

      it('reset keeps the existing override', async () => {
        const t = createTicket(store, { key: 'T-1', title: 'Ticket', projectId: 1 });
        addWorktree(t.id, '/repos/api', '/wt/T-1/api', 'karst/T-1', 'develop');
        store.db.prepare('UPDATE tickets SET base_refs = ? WHERE id = ?').run(JSON.stringify({ api: 'develop' }), t.id);

        await expect(
          runBaseCommand(store, fixtureManifest, ['base', 'reset', 'api', '--rebase', '--ticket', 'T-1'], {
            git: failingGit,
          }),
        ).rejects.toThrow();

        expect(getTicket(store, t.id).baseRefs?.api).toBe('develop');
      });
    });

    it('runs live changeBaseRef post-spin with --rebase', async () => {
      const t = createTicket(store, { key: 'T-1', title: 'Ticket', projectId: 1 });
      addWorktree(t.id, '/repos/api', '/wt/T-1/api', 'karst/T-1', 'main');

      const out = await runBaseCommand(
        store,
        fixtureManifest,
        ['base', 'set', 'api', 'develop', '--rebase', '--ticket', 'T-1'],
        { git: fakeGit },
      );
      expect(out).toContain('Rebased onto develop.');

      const wt = store.db
        .prepare('SELECT base_ref, needs_force_push FROM worktrees WHERE ticket_id = ? AND repo = ?')
        .get(t.id, '/repos/api') as { base_ref: string; needs_force_push: number };
      expect(wt.base_ref).toBe('develop');
      expect(wt.needs_force_push).toBe(1);
    });

    it('resets a sub-task back to parent branch post-spin', async () => {
      const parent = createTicket(store, { key: 'P-1', title: 'Parent', projectId: 1 });
      addWorktree(parent.id, '/repos/api', '/wt/P-1/api', 'karst/P-1', 'main');

      const child = createTicket(store, {
        key: 'C-1',
        title: 'Child',
        subtaskParentId: parent.id,
        projectId: 1,
      });
      updateTicketFields(store, child.id, { baseRefs: { api: 'develop' } });
      addWorktree(child.id, '/repos/api', '/wt/C-1/api', 'karst/C-1', 'develop');

      const out = await runBaseCommand(
        store,
        fixtureManifest,
        ['base', 'reset', 'api', '--ticket', 'C-1'],
        { git: fakeGit },
      );
      expect(out).toContain('Re-targeted to karst/P-1');

      const wt = store.db
        .prepare('SELECT base_ref FROM worktrees WHERE ticket_id = ? AND repo = ?')
        .get(child.id, '/repos/api') as { base_ref: string };
      expect(wt.base_ref).toBe('karst/P-1');
      expect(getTicket(store, child.id).baseRefs?.api).toBeUndefined();
    });

    it('resets a regular ticket back to manifest baseline post-spin', async () => {
      const t = createTicket(store, {
        key: 'T-1',
        title: 'Ticket',
        projectId: 1,
      });
      updateTicketFields(store, t.id, { baseRefs: { api: 'feature-y' } });
      addWorktree(t.id, '/repos/api', '/wt/T-1/api', 'karst/T-1', 'feature-y');

      const out = await runBaseCommand(
        store,
        fixtureManifest,
        ['base', 'reset', 'api', '--ticket', 'T-1'],
        { git: fakeGit },
      );
      expect(out).toContain('Re-targeted to main');

      const wt = store.db
        .prepare('SELECT base_ref FROM worktrees WHERE ticket_id = ? AND repo = ?')
        .get(t.id, '/repos/api') as { base_ref: string };
      expect(wt.base_ref).toBe('main');
      expect(getTicket(store, t.id).baseRefs?.api).toBeUndefined();
    });
  });
});
