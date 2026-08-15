/**
 * Graph byte-subtree retention (Slice 2 Task 8): the sweep removes subtrees
 * whose graph run is `closed` or whose ticket no longer exists, keeps live
 * tickets, and `removeTicketGraphSubtree` removes one ticket's bytes.
 */

import { describe, it, expect } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../../store/db.js';
import { createGraphRun, allGraphRunsClosed } from '../../store/graph/graphRuns.js';
import { reapClosedGraphSubtrees, removeTicketGraphSubtree, describeGraphReap } from './retention.js';

function harness(): {
  store: ReturnType<typeof openStore>;
  graphRoot: string;
  seed: (ticketId: number, projectSlug?: string) => string;
} {
  const store = openStore(':memory:');
  const graphRoot = mkdtempSync(join(tmpdir(), 'karst-graph-retention-'));
  return {
    store,
    graphRoot,
    seed: (ticketId: number, projectSlug = 'project') => {
      const dir = join(graphRoot, projectSlug, String(ticketId));
      mkdirSync(join(dir, 'artifacts'), { recursive: true });
      writeFileSync(join(dir, 'artifacts', 'evidence.md'), '# evidence');
      return dir;
    },
  };
}

function createTicketWithRun(
  store: ReturnType<typeof openStore>,
  key: string,
  status: string,
): number {
  const ticketId = Number(
    store.db.prepare('INSERT INTO tickets (key) VALUES (?)').run(key).lastInsertRowid,
  );
  const graphRunId = createGraphRun(store.db, {
    ticketId,
    stageAttempt: 0,
    approachId: 'karst-graph-engineering',
    now: '2026-08-11T00:00:00.000Z',
  });
  store.db
    .prepare('UPDATE approach_graph_runs SET status = ? WHERE id = ?')
    .run(status, graphRunId);
  return ticketId;
}

describe('reapClosedGraphSubtrees', () => {
  it('removes a subtree whose graph run is closed', () => {
    const { store, graphRoot, seed } = harness();
    const ticketId = createTicketWithRun(store, 'C-1', 'closed');
    const dir = seed(ticketId);
    const result = reapClosedGraphSubtrees(graphRoot, {
      ticketExists: () => true,
      allGraphRunsClosed: (id) => allGraphRunsClosed(store.db, id),
    });
    expect(result.removed).toEqual([{ projectSlug: 'project', ticketId }]);
    expect(existsSync(dir)).toBe(false);
  });

  it('removes a subtree whose ticket no longer exists', () => {
    const { store, graphRoot, seed } = harness();
    const ticketId = createTicketWithRun(store, 'GONE-1', 'running');
    const dir = seed(ticketId);
    store.db.prepare('DELETE FROM approach_graph_runs WHERE ticket_id = ?').run(ticketId);
    store.db.prepare('DELETE FROM tickets WHERE id = ?').run(ticketId);
    const result = reapClosedGraphSubtrees(graphRoot, {
      ticketExists: () => false,
      allGraphRunsClosed: () => false,
    });
    expect(result.removed).toEqual([{ projectSlug: 'project', ticketId }]);
    expect(existsSync(dir)).toBe(false);
  });

  it('keeps a subtree whose graph run is still running', () => {
    const { store, graphRoot, seed } = harness();
    const ticketId = createTicketWithRun(store, 'R-1', 'running');
    const dir = seed(ticketId);
    const result = reapClosedGraphSubtrees(graphRoot, {
      ticketExists: () => true,
      allGraphRunsClosed: (id) => allGraphRunsClosed(store.db, id),
    });
    expect(result.removed).toEqual([]);
    expect(existsSync(dir)).toBe(true);
  });

  it('keeps a cancelled run — no per-ticket pruning of live history in V1', () => {
    const { store, graphRoot, seed } = harness();
    const ticketId = createTicketWithRun(store, 'X-1', 'cancelled');
    const dir = seed(ticketId);
    const result = reapClosedGraphSubtrees(graphRoot, {
      ticketExists: () => true,
      allGraphRunsClosed: (id) => allGraphRunsClosed(store.db, id),
    });
    expect(result.removed).toEqual([]);
    expect(existsSync(dir)).toBe(true);
  });

  it('ignores non-numeric ticket directories', () => {
    const { graphRoot } = harness();
    const junk = join(graphRoot, 'project', 'not-a-ticket');
    mkdirSync(junk, { recursive: true });
    writeFileSync(join(junk, 'x'), 'y');
    const result = reapClosedGraphSubtrees(graphRoot, {
      ticketExists: () => false,
      allGraphRunsClosed: () => false,
    });
    expect(result.removed).toEqual([]);
    expect(existsSync(junk)).toBe(true);
  });
});

describe('removeTicketGraphSubtree', () => {
  it('removes one ticket’s byte subtree', () => {
    const { graphRoot, seed } = harness();
    const dir = seed(7);
    removeTicketGraphSubtree(join(graphRoot, 'project'), 7);
    expect(existsSync(dir)).toBe(false);
  });
});

describe('describeGraphReap', () => {
  it('names the project, ticket, and why in one line', () => {
    expect(describeGraphReap({ projectSlug: 'acme', ticketId: 9 })).toMatch(
      /acme.*9|9.*acme/,
    );
  });
});
