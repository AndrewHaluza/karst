import { describe, expect, it } from 'vitest';
import { openStore } from '../store/db.js';
import { createTicket, getTicket, updateTicketFields } from '../store/tickets.js';
import { manifest, stack } from '../manifest/fixtures.js';
import {
  assertSharedRepoBaseOverrides,
  assertSubtaskParentReady,
  resolvePlannedBase,
  resolvePlannedBaseRef,
  resolveTicketBaseRef,
  subtaskParentBranch,
  SubtaskParentNotStartedError,
} from './baseRef.js';

function fixtureManifest() {
  return manifest(stack());
}

describe('resolvePlannedBaseRef', () => {
  it('prefers the ticket override over the manifest default', () => {
    const m = fixtureManifest();
    expect(resolvePlannedBaseRef({ baseRefs: { backend: 'epic/checkout' } }, m, 'backend')).toBe(
      'epic/checkout',
    );
  });

  it('falls back to the manifest when there is no override', () => {
    const m = fixtureManifest();
    expect(resolvePlannedBaseRef({ baseRefs: {} }, m, 'backend')).toBe(
      m.repositories.backend!.baselineBranch ?? m.baselineBranch,
    );
  });

  it('ignores a blank override — an empty string is not a branch', () => {
    const m = fixtureManifest();
    expect(resolvePlannedBaseRef({ baseRefs: { backend: '  ' } }, m, 'backend')).toBe(
      m.repositories.backend!.baselineBranch ?? m.baselineBranch,
    );
  });
});

describe('resolvePlannedBase (sub-task parent rule)', () => {
  it('ranks the override above the parent branch (design §4 order)', () => {
    const m = fixtureManifest();
    const planned = resolvePlannedBase(
      { baseRefs: { backend: 'epic/checkout' }, subtaskParentId: 1 },
      m,
      'backend',
      'karst/feat/parent-1',
    );
    expect(planned).toEqual({ baseRef: 'epic/checkout', source: 'override', skipPull: false });
  });

  it('uses the parent branch between the override and the manifest, and skips the pull', () => {
    const m = fixtureManifest();
    const planned = resolvePlannedBase({ subtaskParentId: 1 }, m, 'backend', 'karst/feat/parent-1');
    expect(planned).toEqual({
      baseRef: 'karst/feat/parent-1',
      source: 'subtask-parent',
      skipPull: true,
    });
  });

  it('ignores a blank/whitespace parent branch and falls through to the manifest', () => {
    const m = fixtureManifest();
    const planned = resolvePlannedBase({ subtaskParentId: 1 }, m, 'backend', '   ');
    expect(planned.source).toBe('manifest');
    expect(planned.baseRef).toBe(m.repositories.backend!.baselineBranch ?? m.baselineBranch);
    expect(planned.skipPull).toBe(false);
  });
});

describe('subtaskParentBranch', () => {
  it('is null for a top-level ticket', () => {
    const store = openStore(':memory:');
    const m = fixtureManifest();
    const t = createTicket(store, { key: 'T-1', title: 't' });
    expect(subtaskParentBranch(store, t, m, 'backend')).toBeNull();
    store.close();
  });

  it('reads the parent worktree branch for the same repoPath', () => {
    const store = openStore(':memory:');
    const m = fixtureManifest();
    const repoPath = m.repositories.backend!.repoPath;
    const parent = createTicket(store, { key: 'P-1', title: 'p' });
    store.db
      .prepare(
        `INSERT INTO worktrees (ticket_id, repo, path, branch, base_ref, deps_mode)
         VALUES (?, ?, ?, ?, ?, 'inherited')`,
      )
      .run(parent.id, repoPath, '/tmp/parent-wt', 'karst/feat/p-1', 'develop');
    const child = createTicket(store, { key: 'P-1-s1', title: 's', subtaskParentId: parent.id });

    expect(subtaskParentBranch(store, child, m, 'backend')).toBe('karst/feat/p-1');
    expect(subtaskParentBranch(store, child, m, 'frontend')).toBeNull();
    store.close();
  });

  it('falls through when the parent is done (merged) — design §4', () => {
    const store = openStore(':memory:');
    const m = fixtureManifest();
    const repoPath = m.repositories.backend!.repoPath;
    const parent = createTicket(store, { key: 'P-2', title: 'p' });
    store.db
      .prepare(
        `INSERT INTO worktrees (ticket_id, repo, path, branch, base_ref, deps_mode)
         VALUES (?, ?, ?, ?, ?, 'inherited')`,
      )
      .run(parent.id, repoPath, '/tmp/parent-wt', 'karst/feat/p-2', 'develop');
    const child = createTicket(store, { key: 'P-2-s1', title: 's', subtaskParentId: parent.id });
    store.db.prepare("UPDATE tickets SET stage_current = 'done' WHERE id = ?").run(parent.id);

    expect(subtaskParentBranch(store, child, m, 'backend')).toBeNull();
    // ...and the resolver falls through to the manifest default.
    expect(resolvePlannedBaseRef(child, m, 'backend', null)).toBe('develop');
    store.close();
  });

  it('is null when the parent row is missing or archived', () => {
    const store = openStore(':memory:');
    const m = fixtureManifest();
    const orphan = createTicket(store, { key: 'P-3-s1', title: 's', subtaskParentId: 9999 });
    expect(subtaskParentBranch(store, orphan, m, 'backend')).toBeNull();

    const parent = createTicket(store, { key: 'P-4', title: 'p' });
    const child = createTicket(store, { key: 'P-4-s1', title: 's', subtaskParentId: parent.id });
    store.db.prepare('UPDATE tickets SET archived_at = ? WHERE id = ?').run('2026-01-01', parent.id);
    expect(subtaskParentBranch(store, child, m, 'backend')).toBeNull();
    store.close();
  });
});

describe('assertSubtaskParentReady (design §4 cut precondition)', () => {
  function setup() {
    const store = openStore(':memory:');
    const m = fixtureManifest();
    const parent = createTicket(store, { key: 'C-1', title: 'p' });
    const child = createTicket(store, { key: 'C-1-s1', title: 's', subtaskParentId: parent.id });
    return { store, m, parent, child };
  }

  it('does not apply to a top-level ticket', () => {
    const { store, m } = setup();
    const t = createTicket(store, { key: 'C-9', title: 't' });
    expect(() => assertSubtaskParentReady(store, t, m, ['backend'])).not.toThrow();
    store.close();
  });

  it('throws naming the parent and the repo when the parent has no worktree there', () => {
    const { store, m, child } = setup();
    try {
      assertSubtaskParentReady(store, child, m, ['backend']);
      throw new Error('expected assertSubtaskParentReady to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(SubtaskParentNotStartedError);
      expect((err as Error).message).toContain('C-1');
      expect((err as Error).message).toContain('backend');
      expect((err as Error).message).toMatch(/start the parent first/);
    }
    store.close();
  });

  it('passes when the parent has a worktree in the requested repo', () => {
    const { store, m, parent, child } = setup();
    const repoPath = m.repositories.backend!.repoPath;
    store.db
      .prepare(
        `INSERT INTO worktrees (ticket_id, repo, path, branch, base_ref, deps_mode)
         VALUES (?, ?, ?, ?, ?, 'inherited')`,
      )
      .run(parent.id, repoPath, '/tmp/parent-wt', 'karst/feat/c-1', 'develop');
    expect(() => assertSubtaskParentReady(store, child, m, ['backend'])).not.toThrow();
    store.close();
  });

  it('falls through when the parent is done — the sub-task is rooted like any ticket', () => {
    const { store, m, child, parent } = setup();
    store.db.prepare("UPDATE tickets SET stage_current = 'done' WHERE id = ?").run(parent.id);
    expect(() => assertSubtaskParentReady(store, child, m, ['backend'])).not.toThrow();
    store.close();
  });

  it('does not require the parent worktree for a repo the sub-task overrides', () => {
    const { store, m, child } = setup();
    updateTicketFields(store, child.id, { baseRefs: { backend: 'epic/checkout' } });
    expect(() => assertSubtaskParentReady(store, getTicket(store, child.id), m, ['backend'])).not.toThrow();
    store.close();
  });

  // Two manifest entries at one repoPath are one checkout; a missing parent
  // worktree there is reported once, not once per entry.
  it('dedupes shared repoPaths in the message', () => {
    const store = openStore(':memory:');
    const m = manifest({
      api: { repoPath: '/repo/shared', hasMigrations: false },
      web: { repoPath: '/repo/shared', hasMigrations: false },
    });
    const parent = createTicket(store, { key: 'D-1', title: 'p' });
    const child = createTicket(store, { key: 'D-1-s1', title: 's', subtaskParentId: parent.id });
    try {
      assertSubtaskParentReady(store, child, m, ['api', 'web']);
      throw new Error('expected throw');
    } catch (err) {
      const msg = (err as Error).message;
      // The missing entry is reported once, not once per manifest entry.
      expect(msg.split("'api'").length - 1).toBe(1);
    }
    store.close();
  });
});

describe('resolveTicketBaseRef', () => {
  it('reads the worktree row first — the branch was already cut from it', () => {
    const store = openStore(':memory:');
    const m = fixtureManifest();
    const repoPath = m.repositories.backend!.repoPath;
    const ticket = createTicket(store, { key: 'K-1', title: 't' });
    store.db
      .prepare(
        `INSERT INTO worktrees (ticket_id, repo, path, branch, base_ref, deps_mode)
         VALUES (?, ?, ?, ?, ?, 'inherited')`,
      )
      .run(ticket.id, repoPath, '/tmp/wt', 'karst/feat/k-1', 'epic/checkout');
    expect(resolveTicketBaseRef(store, ticket.id, repoPath, m)).toBe('epic/checkout');
  });

  it('falls back to the ticket override before the worktree exists', () => {
    const store = openStore(':memory:');
    const m = fixtureManifest();
    const ticket = createTicket(store, { key: 'K-2', title: 't' });
    updateTicketFields(store, ticket.id, { baseRefs: { backend: 'epic/checkout' } });
    expect(
      resolveTicketBaseRef(store, ticket.id, m.repositories.backend!.repoPath, m),
    ).toBe('epic/checkout');
  });

  it('falls back to the manifest when neither exists', () => {
    const store = openStore(':memory:');
    const m = fixtureManifest();
    const ticket = createTicket(store, { key: 'K-3', title: 't' });
    expect(
      resolveTicketBaseRef(store, ticket.id, m.repositories.backend!.repoPath, m),
    ).toBe(m.repositories.backend!.baselineBranch ?? m.baselineBranch);
  });
});

describe('assertSharedRepoBaseOverrides', () => {
  it('rejects two entries at one repoPath resolving to different bases', () => {
    const m = fixtureManifest();
    const [a, b] = Object.keys(m.repositories);
    // Force the two entries to share a repoPath for the purposes of the check.
    const shared = {
      ...m,
      repositories: {
        ...m.repositories,
        [b!]: { ...m.repositories[b!]!, repoPath: m.repositories[a!]!.repoPath },
      },
    };
    expect(() =>
      assertSharedRepoBaseOverrides(shared, { [a!]: 'epic/one', [b!]: 'epic/two' }),
    ).toThrow(/share repoPath/);
  });

  it('accepts two entries at one repoPath resolving to the same base', () => {
    const m = fixtureManifest();
    const [a, b] = Object.keys(m.repositories);
    const shared = {
      ...m,
      repositories: {
        ...m.repositories,
        [b!]: { ...m.repositories[b!]!, repoPath: m.repositories[a!]!.repoPath },
      },
    };
    expect(() =>
      assertSharedRepoBaseOverrides(shared, { [a!]: 'epic/one', [b!]: 'epic/one' }),
    ).not.toThrow();
  });
});
