import { describe, expect, it, vi } from 'vitest';
import { openStore } from '../../store/db.js';
import { fakeSbxProcess } from '../../agent/sbx/fakeSbxProcess.js';
import { sbxName } from '../../agent/sbx/sbxName.js';
import { startTicketService } from '../../runtime/startOne.js';
import { stopServer } from '../../runtime/supervisor.js';
import { manifest, stack } from '../../manifest/fixtures.js';
import { STOP_SCRIPT } from '../../agent/sandboxServices.js';
import { restartServerRow, startServerRow, stopServerRow, type ServerOpsDeps } from './serverOps.js';

vi.mock('../../runtime/startOne.js', async (orig) => ({
  ...(await orig<typeof import('../../runtime/startOne.js')>()),
  startTicketService: vi.fn(() => Promise.resolve({ record: {}, newPorts: {}, restartedDependents: [] })),
}));
vi.mock('../../runtime/supervisor.js', async (orig) => ({
  ...(await orig<typeof import('../../runtime/supervisor.js')>()),
  stopServer: vi.fn(() => Promise.resolve()),
}));

vi.mock('../../workflow/gates/run.js', async (orig) => ({
  ...(await orig<typeof import('../../workflow/gates/run.js')>()),
  runProcess: vi.fn(() => Promise.resolve({ kind: 'completed', exitCode: 0, output: '' })),
}));

const SBX = sbxName({ projectRoot: '/p', ticketId: 7, core: 'claude' });

function setup(sandboxColumn: string | null, proc = fakeSbxProcess({ 'sbx ls': { stdout: `SANDBOX\n${SBX}\n` } })) {
  const store = openStore(':memory:');
  const id = Number(store.db
    .prepare("INSERT INTO servers (ticket_id, repo, host, port, status, cwd, sandbox) VALUES (7, 'api', '127.0.0.1', 4100, 'running', '/wt', ?)")
    .run(sandboxColumn).lastInsertRowid);
  const deps: ServerOpsDeps = {
    store, notify: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }, afterServerChange: vi.fn(),
    loadManifest: vi.fn().mockResolvedValue(manifest(stack())), openExternal: vi.fn(), copyText: vi.fn(), debug: vi.fn(),
    sandbox: { backend: () => 'sbx', projectRoot: () => '/p', coreOf: () => 'claude', proc },
  };
  return { store, id, deps, proc };
}

describe('serverOps: sandboxed rows (arch:AC-32)', () => {
  it('stops a sandboxed row inside its sandbox and unpublishes its mapping, never via the host pid path', async () => {
    vi.mocked(stopServer).mockClear();
    const { store, id, deps, proc } = setup(`sbx:${SBX}:4100`);
    await stopServerRow(deps, id);
    expect(stopServer).not.toHaveBeenCalled();
    const { runProcess } = await import('../../workflow/gates/run.js');
    expect(vi.mocked(runProcess).mock.calls[0]!.slice(0, 2)).toEqual(['sbx', ['exec', SBX, '--', 'sh', '-c', STOP_SCRIPT, 'karst-svc-stop', 'api']]);
    const lines = proc.calls.map((c) => [c.command, ...c.args].join(' '));
    expect(lines).toContain(`sbx ports ${SBX} --unpublish 127.0.0.1:4100:4100`);
    expect(store.db.prepare('SELECT status FROM servers WHERE id = ?').get(id)).toEqual({ status: 'stopped' });
    expect(deps.afterServerChange).toHaveBeenCalled();
  });

  it('a host row (or no sandbox deps) keeps the host stop path', async () => {
    vi.mocked(stopServer).mockClear();
    const host = setup(null);
    await stopServerRow(host.deps, host.id);
    expect(stopServer).toHaveBeenCalledWith(host.store, host.id);
    const noDeps = setup(`sbx:${SBX}:4100`);
    await stopServerRow({ ...noDeps.deps, sandbox: undefined }, noDeps.id);
    expect(stopServer).toHaveBeenCalledTimes(2);
    const otherCore = setup(`sbx:${SBX}:4100`);
    await stopServerRow({ ...otherCore.deps, sandbox: { ...otherCore.deps.sandbox!, coreOf: () => 'opencode' } }, otherCore.id);
    expect(stopServer).toHaveBeenCalledTimes(3);
  });

  it('start and restart pass the sandbox context only when the sandbox exists', async () => {
    vi.mocked(startTicketService).mockClear();
    const live = setup(`sbx:${SBX}:4100`);
    await restartServerRow(live.deps, live.id);
    expect(vi.mocked(startTicketService).mock.calls[0]![4]).toMatchObject({ sandbox: { sandboxName: SBX } });
    const gone = setup(null, fakeSbxProcess());
    await startServerRow(gone.deps, gone.id);
    expect(vi.mocked(startTicketService).mock.calls[1]![4]).not.toHaveProperty('sandbox');
    await startServerRow({ ...gone.deps, sandbox: undefined }, gone.id);
    expect(vi.mocked(startTicketService).mock.calls[2]![4]).not.toHaveProperty('sandbox');
  });
});
