import { describe, expect, it, vi } from 'vitest';
import { seedOpencode2Credentials } from './dockerCredentials.js';
import { OPENCODE_IMAGE } from './dockerImage.js';
import { dockerNames } from './dockerNames.js';
import { fakeDockerProcess } from './fakeDockerProcess.js';

const names = dockerNames({ projectRoot: '/p', ticketId: 7, core: 'opencode2' });
const HOST_ENV = { XDG_DATA_HOME: '/karst/oc2/data' };
const SECRET = 'sk-live-SECRET';
const EMPTY = { 'docker run --rm --network none': { stdout: 'No authenticated integrations\n' } };

describe('seedOpencode2Credentials', () => {
  it('skips when the sandbox store already lists a credential', async () => {
    const proc = fakeDockerProcess({ 'docker run --rm --network none': { stdout: 'opencode-go  Go  stored\n' } });
    await expect(seedOpencode2Credentials({ proc, names, user: undefined, hostCommand: 'opencode2', hostEnv: HOST_ENV })).resolves.toEqual({ ok: true });
    expect(proc.pipes).toHaveLength(0);
    expect(proc.calls[0]!.args.slice(-5)).toEqual([OPENCODE_IMAGE, 'opencode2', 'auth', 'list', '--standalone']);
  });

  it('pipes the host export into an offline import with the volume XDG store', async () => {
    const proc = fakeDockerProcess(EMPTY);
    await expect(seedOpencode2Credentials({ proc, names, user: { uid: 1001, gid: 1002 }, hostCommand: '/abs/opencode2', hostEnv: HOST_ENV })).resolves.toEqual({ ok: true });
    expect(proc.pipes).toHaveLength(1);
    const { from, to } = proc.pipes[0]!;
    expect(from).toEqual({ command: '/abs/opencode2', args: ['auth', 'export', '--standalone'], env: HOST_ENV });
    expect(to.command).toBe('docker');
    expect(to.args.slice(0, 5)).toEqual(['run', '--rm', '--interactive', '--network', 'none']);
    expect(to.args).toContain('--user');
    expect(to.args).toContain('XDG_DATA_HOME=/home/node/.local/share/opencode/xdg/data');
    expect(to.args.slice(-4)).toEqual(['opencode2', 'auth', 'import', '--standalone']);
  });

  it('never runs the export through run (which would capture its stdout) and never logs output', async () => {
    const debug = vi.fn();
    const proc = fakeDockerProcess({ ...EMPTY, '/abs/opencode2': { stdout: SECRET } });
    await seedOpencode2Credentials({ proc, names, user: undefined, hostCommand: '/abs/opencode2', hostEnv: HOST_ENV, debug });
    expect(proc.calls.some((c) => c.args.includes('export'))).toBe(false);
    const logged = debug.mock.calls.map((call) => String(call[0])).join('\n');
    expect(logged).not.toContain(SECRET);
    expect(logged).toBe('[docker] opencode2 credential seed: export exit 0, import exit 0');
  });

  it('seeds when the list probe itself fails', async () => {
    const proc = fakeDockerProcess({ 'docker run': { code: 1 } });
    await seedOpencode2Credentials({ proc, names, user: undefined, hostCommand: 'opencode2', hostEnv: {} });
    expect(proc.pipes).toHaveLength(1);
  });

  it('reports a failed export (host not signed in)', async () => {
    const proc = fakeDockerProcess(EMPTY, { fromCode: 1, toCode: 0 });
    await expect(seedOpencode2Credentials({ proc, names, user: undefined, hostCommand: 'opencode2', hostEnv: {} })).resolves.toEqual({
      ok: false, reason: 'opencode2 auth export failed (exit 1); sign in on the host first',
    });
  });

  it('reports a failed import', async () => {
    const proc = fakeDockerProcess(EMPTY, { fromCode: 0, toCode: 2 });
    await expect(seedOpencode2Credentials({ proc, names, user: undefined, hostCommand: 'opencode2', hostEnv: {} })).resolves.toEqual({
      ok: false, reason: 'opencode2 auth import in the sandbox failed (exit 2)',
    });
  });

  it('logs the skip through debug', async () => {
    const debug = vi.fn();
    const proc = fakeDockerProcess({ 'docker run': { stdout: 'x  y  stored' } });
    await seedOpencode2Credentials({ proc, names, user: undefined, hostCommand: 'opencode2', hostEnv: {}, debug });
    expect(debug).toHaveBeenCalledWith('[docker] opencode2 store already has credentials');
  });
});
