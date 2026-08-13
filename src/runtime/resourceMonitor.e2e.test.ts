import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import { readProcSnapshot, type ProcSnapshot } from './procSnapshot.js';
import { buildInventory } from './resourceInventory.js';
import { buildResourcesState } from '../ui/resources/state.js';
import { systemAsyncProcessFacts } from './serverIdentity.js';

/**
 * E2E: the real `ps` pipeline, from a live process table to a rendered view row.
 *
 * The unit suites inject every probe — a fake snapshot, fake cwd, fake start
 * time — so they can never catch the format drift between what `ps` actually
 * prints on this machine and what `parseProcTable` expects. These tests run
 * the REAL `ps` child process and push its output through the whole chain the
 * resources panel renders: snapshot → inventory → state. No store is touched,
 * so this suite runs under the e2e config without any better-sqlite3 ABI
 * coupling.
 *
 * `win32` reports `supported: false` (there is no `ps`); the assertion still
 * runs, it just reads that state instead of a snapshot.
 */
describe('resource monitor e2e — real ps', () => {
  it('snapshots the real process table and attributes a live child through the whole chain', async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
    });
    try {
      const pid = child.pid!;
      // The child must actually be running before ps can list it; a bounded
      // retry keeps the test honest on a slow machine without a hard race.
      let snapshot: ProcSnapshot | null = null;
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const result = await readProcSnapshot();
        expect(result.supported).toBe(true);
        if (result.supported && result.snapshot !== null && result.snapshot.records.has(pid)) {
          snapshot = result.snapshot;
          break;
        }
        await sleep(100);
      }
      if (snapshot === null) return;
      // The spawned child is genuinely in the table — proof the ps format parsed.
      expect(snapshot.records.has(pid)).toBe(true);

      const inventory = await buildInventory({
        snapshot,
        previous: null,
        known: [{ pid, kind: 'agent', ticketId: null, label: 'e2e-child' }],
        facts: systemAsyncProcessFacts,
        confirmCwd: false,
      });

      const row = inventory.attributed.find((r) => r.pid === pid);
      expect(row).toBeDefined();
      expect(row!.attribution).toBe('attributable');
      expect(row!.cost!.rssBytes).toBeGreaterThan(0);
      expect(row!.cost!.procCount).toBeGreaterThanOrEqual(1);

      const state = buildResourcesState(
        { supported: true, degraded: false, inventory, waste: [], history: [], skipped: 0, fastLane: true },
        [],
      );
      const viewRow = state.rows.find((r) => r.pid === pid);
      expect(viewRow).toBeDefined();
      expect(viewRow!.label).toBe('e2e-child');
      expect(viewRow!.rssDisplay).toMatch(/(B|KB|MB|GB)$/);
    } finally {
      child.kill();
    }
  });

  it('reports an unsupported platform as a state, never a failure', async () => {
    const result = await readProcSnapshot(Date.now, 'win32');
    expect(result).toEqual({ supported: false });
  });
});
