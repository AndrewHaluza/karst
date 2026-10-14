import { appendFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dispatchHook, type NotifyTicket } from '../../hooks/dispatch.js';
import { openStore, type Store } from '../../store/db.js';
import { createTicket, getTicket, setStageCurrent } from '../../store/tickets.js';
import type { StageKey } from '../../model/types.js';
import { bridgePaths, ensureBridgeDir, type BridgePaths } from './bridgeDir.js';
import { createBridgeAttachment, type BridgeAttachment, type MarkerRunner } from './bridgeSink.js';

/**
 * Headless end-to-end of the sandbox evidence bridge (arch:AC-34): "the
 * sandbox" is a helper appending lines to the bridge dir; the host side is the
 * real poller, verifier and `dispatchHook` over an in-memory store.
 */
const WT = '/repo/.karst/worktrees/t';
let store: Store;
let root: string;
let paths: BridgePaths;
let ticketId: number;
let notify: ReturnType<typeof vi.fn<NotifyTicket>>;
let runMarker: ReturnType<typeof vi.fn<MarkerRunner>>;

function seedWorktree(id: number, path: string): void {
  store.db
    .prepare(
      `INSERT INTO worktrees (ticket_id, repo, path, branch, base_ref, deps_mode)
       VALUES (?, 'app', ?, 'karst/x', 'main', 'inherited')`,
    )
    .run(id, path);
}

/** Plays the sandboxed agent: appends one NDJSON line to its bridge file. */
const sandboxWrites = (line: Record<string, unknown>) => appendFile(paths.eventsFile, `${JSON.stringify(line)}\n`);

function attach(): BridgeAttachment {
  return createBridgeAttachment({
    paths,
    expect: {
      ticketId,
      worktreePath: WT,
      launchId: undefined,
      stage: () => getTicket(store, ticketId).stageCurrent as StageKey | null,
      sessionId: () => undefined,
    },
    dispatch: (p) => dispatchHook(store, p, notify),
    runMarker,
    intervalMs: 5,
  });
}

beforeEach(async () => {
  store = openStore(':memory:');
  root = await mkdtemp(join(tmpdir(), 'bridge-e2e-'));
  const t = createTicket(store, { key: 'A', title: 'a' });
  ticketId = t.id;
  seedWorktree(ticketId, WT);
  setStageCurrent(store, ticketId, 'impl');
  paths = bridgePaths(root, ticketId);
  await ensureBridgeDir(paths);
  notify = vi.fn<NotifyTicket>();
  runMarker = vi.fn<MarkerRunner>(async () => ({ code: 0, stderr: '' }));
});
afterEach(async () => {
  store.close();
  await rm(root, { recursive: true, force: true });
});

const hook = (payload: Record<string, unknown>) => ({ v: 1, kind: 'hook', ticket: ticketId, payload });

describe('sandbox evidence bridge e2e', () => {
  it('a needs-you written inside the "sandbox" dir reaches the amber signal', async () => {
    await sandboxWrites(hook({ hook_event_name: 'Notification', session_id: 's1', notification_type: 'permission_prompt', message: 'needs Bash' }));
    await attach().pollOnce();
    expect(notify).toHaveBeenCalledWith(ticketId, expect.objectContaining({ hook_event_name: 'Notification' }));
    expect(getTicket(store, ticketId).agentState).toBe('waiting');
  });

  it('a forged marker for another ticket is dropped and the stage does not move', async () => {
    await sandboxWrites({ v: 1, kind: 'marker', ticket: ticketId + 1, stage: 'impl' });
    await attach().pollOnce();
    expect(runMarker).not.toHaveBeenCalled();
    expect(getTicket(store, ticketId).stageCurrent).toBe('impl');
  });

  it('the own-stage marker invokes the marker runner exactly once even if the file is re-polled', async () => {
    await sandboxWrites({ v: 1, kind: 'marker', ticket: ticketId, stage: 'impl' });
    await attach().pollOnce();
    // A fresh attachment (host restart) resumes from the persisted offset.
    await attach().pollOnce();
    expect(runMarker).toHaveBeenCalledTimes(1);
    expect(runMarker).toHaveBeenCalledWith('impl');
  });

  it('a hook line carrying a foreign cwd still lands on the OWNING ticket (cwd is rebuilt)', async () => {
    const other = createTicket(store, { key: 'B', title: 'b' });
    seedWorktree(other.id, '/repo/.karst/worktrees/other');
    await sandboxWrites(hook({ hook_event_name: 'SessionStart', session_id: 's1', cwd: '/repo/.karst/worktrees/other' }));
    await attach().pollOnce();
    expect(getTicket(store, ticketId).agentState).toBe('running');
    expect(getTicket(store, other.id).agentState).not.toBe('running');
  });
});
