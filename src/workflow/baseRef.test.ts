import { describe, expect, it } from 'vitest';
import { openStore } from '../store/db.js';
import { createTicket, updateTicketFields } from '../store/tickets.js';
import { manifest, stack } from '../manifest/fixtures.js';
import {
  assertSharedRepoBaseOverrides,
  resolvePlannedBaseRef,
  resolveTicketBaseRef,
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
