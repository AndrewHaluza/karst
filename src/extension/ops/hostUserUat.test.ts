import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openStore, type Store } from '../../store/db.js';
import type { GateProcessRunner } from '../../workflow/gates/run.js';
import { HOST_RESET_TIMEOUT_MS, hasRunningHostPlacedServices, hasRunningHostServices, resetHostServices } from './hostUserUat.js';

let store: Store;
beforeEach(() => { store = openStore(':memory:'); });
afterEach(() => store.close());

function insert(ticket: number, repo: string, status: string, cwd: string | null, sandbox: string | null = null): void {
  store.db
    .prepare('INSERT INTO servers (ticket_id, repo, host, port, status, cwd, sandbox) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(ticket, repo, '127.0.0.1', 4000 + Math.floor(Math.random() * 1000), status, cwd, sandbox);
}

describe('hasRunningHostServices', () => {
  it('is false without rows', () => {
    expect(hasRunningHostServices(store, 7)).toBe(false);
  });
  it('is true for a running host row of that ticket only', () => {
    insert(7, 'api', 'running', '/wt');
    expect(hasRunningHostServices(store, 7)).toBe(true);
    expect(hasRunningHostServices(store, 8)).toBe(false);
  });
  it('ignores a stopped host row', () => {
    insert(7, 'api', 'stopped', '/wt');
    expect(hasRunningHostServices(store, 7)).toBe(false);
  });
  it('ignores a sandboxed row', () => {
    insert(7, 'api', 'running', '/wt', 'sbx:x:1');
    expect(hasRunningHostServices(store, 7)).toBe(false);
  });
  it('ignores a row whose kind is not service', () => {
    insert(7, 'api', 'running', '/wt');
    store.db.prepare("UPDATE servers SET kind = 'other'").run();
    expect(hasRunningHostServices(store, 7)).toBe(false);
  });
});

describe('hasRunningHostPlacedServices', () => {
  const placed = (key: string): boolean => key === 'api';
  it('is true for a running host row whose key the predicate accepts', () => {
    insert(7, 'api', 'running', '/wt');
    expect(hasRunningHostPlacedServices(store, 7, placed)).toBe(true);
  });
  it('is false for a sandbox row, a stopped row, a rejected key and another ticket', () => {
    insert(7, 'api', 'running', '/wt', 'sbx:x:1');
    expect(hasRunningHostPlacedServices(store, 7, placed)).toBe(false);
    store.db.prepare('DELETE FROM servers').run();
    insert(7, 'api', 'stopped', '/wt');
    expect(hasRunningHostPlacedServices(store, 7, placed)).toBe(false);
    store.db.prepare('DELETE FROM servers').run();
    insert(7, 'web', 'running', '/wt');
    expect(hasRunningHostPlacedServices(store, 7, placed)).toBe(false);
    store.db.prepare('DELETE FROM servers').run();
    insert(7, 'api', 'running', '/wt');
    expect(hasRunningHostPlacedServices(store, 8, placed)).toBe(false);
  });
});

describe('resetHostServices', () => {
  const ok = { kind: 'completed', exitCode: 0, output: '' } as const;
  const resetOf = (key: string) => (key === 'api' || key === 'web' ? { reset: `reset ${key}` } : undefined);

  it("runs sh -c <reset> in the row's own cwd, without joining def.cwd again", async () => {
    insert(7, 'api', 'running', '/wt/apps/api');
    const run = vi.fn<GateProcessRunner>().mockResolvedValue(ok);
    const of = () => ({ reset: 'npm run db:reset', cwd: 'apps/api' });
    await expect(resetHostServices(store, 7, of, run)).resolves.toEqual([]);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith('sh', ['-c', 'npm run db:reset'], '/wt/apps/api', { timeoutMs: HOST_RESET_TIMEOUT_MS });
  });
  it('uses a 30 second budget', () => {
    expect(HOST_RESET_TIMEOUT_MS).toBe(30_000);
  });
  it('skips a service with no reset and an unknown unit', async () => {
    insert(7, 'api', 'running', '/wt');
    insert(7, 'ghost', 'running', '/wt');
    const run = vi.fn<GateProcessRunner>().mockResolvedValue(ok);
    await expect(resetHostServices(store, 7, (k) => (k === 'api' ? {} : undefined), run)).resolves.toEqual([]);
    expect(run).not.toHaveBeenCalled();
  });
  it('reports a nonzero exit', async () => {
    insert(7, 'api', 'running', '/wt');
    const run = vi.fn<GateProcessRunner>().mockResolvedValue({ kind: 'completed', exitCode: 3, output: 'boom\n' });
    await expect(resetHostServices(store, 7, resetOf, run)).resolves.toEqual(['api: reset failed (exit 3: boom)']);
  });
  it('reports a timed out reset', async () => {
    insert(7, 'api', 'running', '/wt');
    const run = vi.fn<GateProcessRunner>().mockResolvedValue({ kind: 'timedOut', output: 'slow' });
    await expect(resetHostServices(store, 7, resetOf, run)).resolves.toEqual(['api: reset failed (timedOut: slow)']);
  });
  it('skips a row with no recorded directory', async () => {
    insert(7, 'api', 'running', null);
    const run = vi.fn<GateProcessRunner>().mockResolvedValue(ok);
    await expect(resetHostServices(store, 7, resetOf, run)).resolves.toEqual(['api: reset skipped (no recorded directory)']);
    expect(run).not.toHaveBeenCalled();
  });
  it('ignores stopped rows, sandboxed rows and rows of another ticket', async () => {
    insert(7, 'api', 'stopped', '/wt');
    insert(7, 'web', 'running', '/wt', 'sbx:x:1');
    insert(8, 'api', 'running', '/wt');
    const run = vi.fn<GateProcessRunner>().mockResolvedValue(ok);
    await expect(resetHostServices(store, 7, resetOf, run)).resolves.toEqual([]);
    expect(run).not.toHaveBeenCalled();
  });
  it('turns a throwing runner into a warning and still runs the next row', async () => {
    insert(7, 'api', 'running', '/wt/a');
    insert(7, 'web', 'running', '/wt/w');
    const run = vi.fn<GateProcessRunner>().mockRejectedValueOnce(new Error('spawn x')).mockResolvedValueOnce(ok);
    await expect(resetHostServices(store, 7, resetOf, run)).resolves.toEqual(['api: reset failed (spawn x)']);
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[1]![2]).toBe('/wt/w');
  });
  it('reports a non-Error throw as text, and spawnFailed by kind', async () => {
    insert(7, 'api', 'running', '/wt/a');
    insert(7, 'web', 'running', '/wt/w');
    const run = vi.fn<GateProcessRunner>().mockRejectedValueOnce('plain').mockResolvedValueOnce({ kind: 'spawnFailed', message: 'm', output: ' o ' });
    await expect(resetHostServices(store, 7, resetOf, run)).resolves.toEqual([
      'api: reset failed (plain)',
      'web: reset failed (spawnFailed: o)',
    ]);
  });
});
