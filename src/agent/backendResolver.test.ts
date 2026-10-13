import { describe, expect, it, vi } from 'vitest';
import { resolveBackend } from './backendResolver.js';
import { fakeSbxProcess } from './sbx/fakeSbxProcess.js';
import { HOST_SESSION_RUNNER } from './sessionRunner.js';

const base = { core: 'claude', projectRoot: '/p', ticketId: 7, proc: fakeSbxProcess() };
const ok = vi.fn().mockResolvedValue({ ok: true, existing: [] });

describe('resolveBackend', () => {
  it('defaults to host without running preflight', async () => {
    const preflight = vi.fn();
    const out = await resolveBackend({ ...base, backend: undefined, preflight });
    expect(out).toEqual({ runner: HOST_SESSION_RUNNER, line: 'host (agentBackend: host)' });
    expect(preflight).not.toHaveBeenCalled();
    expect((await resolveBackend({ ...base, backend: 'host', preflight })).runner).toBe(HOST_SESSION_RUNNER);
  });

  it.each(['claude', 'codex'])('picks sbx for %s when preflight passes', async (core) => {
    const out = await resolveBackend({ ...base, core, backend: 'sbx', preflight: ok });
    expect(out.runner.kind).toBe('sbx');
    expect(out.runner.enforcesSandbox).toBe(true);
    expect(out.line).toMatch(new RegExp(`^sbx \\(karst-[0-9a-f]{8}-7-${core}\\)$`));
  });

  it('keeps an unsupported core on host with a reason', async () => {
    const preflight = vi.fn();
    const out = await resolveBackend({ ...base, core: 'opencode', backend: 'sbx', preflight });
    expect(out).toEqual({ runner: HOST_SESSION_RUNNER, line: 'host (opencode: sbx backend unsupported)' });
    expect(preflight).not.toHaveBeenCalled();
  });

  it('falls back to host with the preflight reason', async () => {
    const preflight = vi.fn().mockResolvedValue({ ok: false, reason: 'sbx not signed in (run `sbx login`)' });
    const out = await resolveBackend({ ...base, backend: 'sbx', preflight });
    expect(out).toEqual({ runner: HOST_SESSION_RUNNER, line: 'host (sbx not signed in (run `sbx login`))' });
  });

  it('resolves docker to host until it is implemented', async () => {
    const out = await resolveBackend({ ...base, backend: 'docker', preflight: ok });
    expect(out).toEqual({ runner: HOST_SESSION_RUNNER, line: 'host (docker backend not implemented)' });
  });

  it('falls back to host when no valid name can be built', async () => {
    const out = await resolveBackend({ ...base, ticketId: 0, backend: 'sbx', preflight: ok });
    expect(out.runner).toBe(HOST_SESSION_RUNNER);
    expect(out.line).toMatch(/^host \(sbx name: invalid ticket id 0\)$/);
  });

  it('uses an injected host runner', async () => {
    const host = { ...HOST_SESSION_RUNNER };
    expect((await resolveBackend({ ...base, backend: undefined, host })).runner).toBe(host);
  });
});
