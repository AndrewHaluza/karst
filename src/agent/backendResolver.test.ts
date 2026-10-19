import { describe, expect, it, vi } from 'vitest';
import { resolveBackend } from './backendResolver.js';
import { fakeSbxProcess } from './sbx/fakeSbxProcess.js';
import { HOST_SESSION_RUNNER } from './sessionRunner.js';

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const projectRoot = mkdtempSync(join(tmpdir(), 'karst-resolve-'));
const worktree = { hostWorktreePath: join(projectRoot, '.karst', 'worktrees', 't7'), branch: 'karst/t7' };
const base = { core: 'claude', projectRoot: '/p', ticketId: 7, proc: fakeSbxProcess() };
const ok = vi.fn().mockResolvedValue({ ok: true, existing: [] });

describe('resolveBackend', () => {
  it('defaults to host without running preflight', async () => {
    const preflight = vi.fn();
    const out = await resolveBackend({ ...base, backends: undefined, preflight });
    expect(out).toEqual({ runner: HOST_SESSION_RUNNER, line: 'host (agentBackends.claude: host)' });
    expect(preflight).not.toHaveBeenCalled();
    expect((await resolveBackend({ ...base, backends: { claude: 'host' }, preflight })).runner).toBe(HOST_SESSION_RUNNER);
  });

  it.each(['claude', 'codex'])('picks sbx for %s when preflight passes', async (core) => {
    const out = await resolveBackend({ ...base, projectRoot, core, backends: { [core]: 'sbx' }, preflight: ok, worktree });
    expect(out.runner.kind).toBe('sbx');
    expect(out.runner.enforcesSandbox).toBe(true);
    expect(out.line).toMatch(new RegExp(`^sbx \\(karst-[0-9a-f]{8}-7-${core}\\)$`));
    const args = out.runner.placeInteractive({ ticketId: 7, hostWorktreePath: worktree.hostWorktreePath, command: core, args: [], env: {} }).shellArgs;
    expect(args).not.toContain(worktree.hostWorktreePath);
    expect(args[args.indexOf(core) + 1]).toContain(join(projectRoot, '.karst', 'sbx-clones'));
  });

  it('fails closed to host when there is no worktree branch to clone', async () => {
    const out = await resolveBackend({ ...base, backends: { claude: 'sbx' }, preflight: ok });
    expect(out).toEqual({ runner: HOST_SESSION_RUNNER, line: 'host (sbx: no ticket worktree branch to clone)' });
  });

  it('fails closed to host when origin cannot be dropped', async () => {
    const proc = fakeSbxProcess({ 'git -C': { code: 1, stderr: 'locked' } });
    const out = await resolveBackend({ ...base, projectRoot, proc, backends: { claude: 'sbx' }, preflight: ok, worktree });
    expect(out.line).toBe('host (sandbox clone could not drop origin: locked)');
  });

  it('fails closed to host when the clone fails', async () => {
    const proc = fakeSbxProcess({ 'git clone': { code: 128, stderr: 'boom' } });
    const out = await resolveBackend({ ...base, projectRoot, proc, backends: { claude: 'sbx' }, preflight: ok, worktree });
    expect(out.line).toBe('host (sandbox clone failed: boom)');
  });

  it('keeps an unsupported core on host with a reason', async () => {
    const preflight = vi.fn();
    const out = await resolveBackend({ ...base, core: 'opencode', backends: { opencode: 'sbx' }, preflight });
    expect(out).toEqual({ runner: HOST_SESSION_RUNNER, line: 'host (opencode: sbx backend unsupported)' });
    expect(preflight).not.toHaveBeenCalled();
  });

  it('falls back to host with the preflight reason', async () => {
    const preflight = vi.fn().mockResolvedValue({ ok: false, reason: 'sbx not signed in (run `sbx login`)' });
    const out = await resolveBackend({ ...base, backends: { claude: 'sbx' }, preflight });
    expect(out).toEqual({ runner: HOST_SESSION_RUNNER, line: 'host (sbx not signed in (run `sbx login`))' });
  });

  const dockerDeps = { preflight: vi.fn().mockResolvedValue({ ok: true }), prepare: vi.fn().mockResolvedValue({ ok: true }), hostAuthFile: () => Promise.resolve(undefined) };
  const worktree = { hostWorktreePath: '/w/t7', branch: 'feat/x' };

  it.each(['opencode', 'opencode2'])('picks docker for %s when preflight and prepare pass', async (core) => {
    const out = await resolveBackend({ ...base, core, backends: { [core]: 'docker' }, worktree, docker: dockerDeps });
    expect(out.runner.kind).toBe('docker');
    expect(out.runner.enforcesSandbox).toBe(true);
    expect(out.line).toMatch(new RegExp(`^docker \\(karst-[0-9a-f]{8}-7-${core}\\)$`));
  });

  it.each(['claude', 'codex', 'antigravity'])('keeps %s on host under docker with a reason', async (core) => {
    const out = await resolveBackend({ ...base, core, backends: { [core]: 'docker' }, worktree, docker: dockerDeps });
    expect(out).toEqual({ runner: HOST_SESSION_RUNNER, line: `host (${core}: docker backend unsupported)` });
  });

  it('falls back to host with the docker reason', async () => {
    const docker = { ...dockerDeps, preflight: vi.fn().mockResolvedValue({ ok: false, reason: 'docker not installed (not on PATH)' }) };
    const out = await resolveBackend({ ...base, core: 'opencode', backends: { opencode: 'docker' }, worktree, docker });
    expect(out).toEqual({ runner: HOST_SESSION_RUNNER, line: 'host (docker not installed (not on PATH))' });
  });

  it('keeps docker on host without a worktree branch', async () => {
    const out = await resolveBackend({ ...base, core: 'opencode', backends: { opencode: 'docker' }, docker: dockerDeps });
    expect(out.line).toBe('host (docker: ticket has no worktree branch to clone)');
  });

  it('falls back to host when no valid name can be built', async () => {
    const out = await resolveBackend({ ...base, ticketId: 0, backends: { claude: 'sbx' }, preflight: ok });
    expect(out.runner).toBe(HOST_SESSION_RUNNER);
    expect(out.line).toMatch(/^host \(sbx name: invalid ticket id 0\)$/);
  });

  it('only the session cores entry counts', async () => {
    const preflight = vi.fn();
    const out = await resolveBackend({ ...base, core: 'claude', backends: { opencode: 'docker' }, preflight });
    expect(out.line).toBe('host (agentBackends.claude: host)');
    expect(preflight).not.toHaveBeenCalled();
  });

  it('uses an injected host runner', async () => {
    const host = { ...HOST_SESSION_RUNNER };
    expect((await resolveBackend({ ...base, backends: undefined, host })).runner).toBe(host);
  });
});
