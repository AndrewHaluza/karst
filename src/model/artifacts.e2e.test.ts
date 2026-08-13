import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from '../cli/main.js';
import { openWritableStore } from '../cli/writableStore.js';
import { buildTicketArtifacts, type ArtifactSummary } from './artifacts.js';
import { buildDashboardState } from '../ui/dashboard/state.js';

/**
 * E2E: the real agent-facing flow — `karst phase <name>` — produces a Plan
 * artifact that is visible in the artifacts shelf.
 *
 * The unit suites (`artifacts.test.ts`, `state.test.ts`) seed phase marks and
 * stage rows in-process, so they can never catch the drift between what the REAL
 * CLI writes and what the artifact derivation reads. These tests drive the real
 * CLI (`runCli`, the exact argv-parsing seam an agent session invokes) against a
 * REAL temp DB file through `node:sqlite` (`openWritableStore`) and read the
 * artifacts back through the SAME store — the whole chain from an agent's
 * `phase` marker to a plan rendered on the shelf.
 *
 * No better-sqlite3 is touched anywhere: the e2e config runs without the Node-ABI
 * rebuild, so this suite is ABI-agnostic like `resourceMonitor.e2e.test.ts`.
 */

/** A fresh temp DB with a ticket whose impl is running; returns its id. */
function seedImplTicket(): { dir: string; dbPath: string; ticketId: number; key: string } {
  const dir = mkdtempSync(join(tmpdir(), 'karst-plan-e2e-'));
  const dbPath = join(dir, 'karst.db');
  runCli(['test', 'reset', '--db', dbPath]);
  const created = JSON.parse(
    runCli(['test', 'create-ticket', '--db', dbPath, '--key', 'PLAN-E2E', '--title', 'plan e2e']),
  ) as { id: number; key: string };
  runCli(['test', 'set-stage', '--db', dbPath, '--ticket', created.key, '--stage', 'impl', '--status', 'running']);
  return { dir, dbPath, ticketId: created.id, key: created.key };
}

/** Fire a real phase marker through the real CLI. */
function firePhase(dbPath: string, key: string, name: string): void {
  runCli(['phase', name, '--db', dbPath, '--ticket', key]);
}

describe('plan artifact e2e — real CLI phase markers', () => {
  it('fires phase markers through the real CLI and the plan appears in the artifacts', () => {
    const { dir, dbPath, ticketId, key } = seedImplTicket();
    try {
      firePhase(dbPath, key, 'research');
      firePhase(dbPath, key, 'plan');

      const store = openWritableStore(dbPath);
      try {
        const [plan] = buildTicketArtifacts(store, ticketId, ['research', 'plan', 'implement']) as [
          ArtifactSummary,
        ];
        expect(plan).toMatchObject({
          id: 'plan',
          stage: 'impl',
          kind: 'plan',
          title: 'Plan',
          summary: '3 tasks · 1 done · 1 in progress',
          status: 'info',
        });
        expect(plan.tasks).toEqual([
          { id: 'research', label: 'research', kind: 'phase', status: 'done', visits: null },
          { id: 'plan', label: 'plan', kind: 'phase', status: 'doing', visits: null },
          { id: 'implement', label: 'implement', kind: 'phase', status: 'todo', visits: null },
        ]);
      } finally {
        store.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('declares the workflow as tasks even before any phase is reported', () => {
    const { dir, dbPath, ticketId } = seedImplTicket();
    try {
      const store = openWritableStore(dbPath);
      try {
        const [plan] = buildTicketArtifacts(store, ticketId, ['research', 'plan', 'implement']) as [
          ArtifactSummary,
        ];
        expect(plan).toMatchObject({ id: 'plan', summary: '3 tasks · 0 done' });
        expect(plan.tasks).toEqual([
          { id: 'research', label: 'research', kind: 'phase', status: 'todo', visits: null },
          { id: 'plan', label: 'plan', kind: 'phase', status: 'todo', visits: null },
          { id: 'implement', label: 'implement', kind: 'phase', status: 'todo', visits: null },
        ]);
      } finally {
        store.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('derives no plan before any impl evidence exists', () => {
    const dir = mkdtempSync(join(tmpdir(), 'karst-plan-e2e-'));
    const dbPath = join(dir, 'karst.db');
    try {
      runCli(['test', 'reset', '--db', dbPath]);
      const created = JSON.parse(
        runCli(['test', 'create-ticket', '--db', dbPath, '--key', 'PLAN-NONE', '--title', 'none']),
      ) as { id: number };
      // The ticket sits at `scope`; impl never started, nothing reported.
      const store = openWritableStore(dbPath);
      try {
        expect(buildTicketArtifacts(store, created.id, ['research', 'plan', 'implement'])).toEqual([]);
      } finally {
        store.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the plan is FIRST in the dashboard artifacts for an active ticket', () => {
    const dir = mkdtempSync(join(tmpdir(), 'karst-plan-e2e-'));
    const dbPath = join(dir, 'karst.db');
    try {
      runCli(['test', 'reset', '--db', dbPath]);
      const created = JSON.parse(
        runCli([
          'test',
          'create-ticket',
          '--db',
          dbPath,
          '--key',
          'PLAN-DASH',
          '--title',
          'dash',
          '--approach',
          'rpi',
        ]),
      ) as { id: number; key: string };
      runCli(['test', 'set-stage', '--db', dbPath, '--ticket', created.key, '--stage', 'impl', '--status', 'running']);
      firePhase(dbPath, created.key, 'research');
      firePhase(dbPath, created.key, 'plan');

      const store = openWritableStore(dbPath);
      try {
        const dash = buildDashboardState(
          store,
          created.id,
          undefined,
          undefined,
          (approachId) => (approachId === 'rpi' ? ['research', 'plan', 'implement'] : []),
        );
        expect(dash.artifacts[0]).toMatchObject({ id: 'plan' });
        // The reported phases ride the same one-read marks as the plan's tasks.
        expect(dash.approach?.reported).toEqual(['research', 'plan']);
      } finally {
        store.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
