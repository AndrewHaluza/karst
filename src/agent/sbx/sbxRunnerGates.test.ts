import { describe, expect, it, vi } from 'vitest';
import type { GateProcessRunner } from '../../workflow/gates/run.js';
import type { ProcessOutcome } from '../../workflow/gates/run.js';
import { fakeSbxProcess } from './fakeSbxProcess.js';
import { createSbxSessionRunner } from './sbxRunner.js';

const NAME = 'karst-ab12cd34-7-claude';

describe('sbx runner: gates, ports, baseline allow (arch:AC-32)', () => {
  it('runs a gate through sbx exec, passing the exit code and the abort signal through', async () => {
    const outcome: ProcessOutcome = { kind: 'completed', exitCode: 3, output: 'fail' };
    const gateProcess = vi.fn<GateProcessRunner>(() => Promise.resolve(outcome));
    const runner = createSbxSessionRunner({ proc: fakeSbxProcess(), core: 'claude', name: NAME, existing: [], gateProcess, evidenceDir: '/ev/7' });
    const signal = new AbortController().signal;
    await expect(runner.runGate!('npm', ['test'], '/wt', { signal })).resolves.toBe(outcome);
    expect(gateProcess).toHaveBeenCalledWith(
      'sbx', ['exec', '--env', 'KARST_SANDBOX=1', '--env', 'KARST_EVIDENCE_DIR=/ev/7', NAME, '--', 'npm', 'test'], '/wt', { signal },
    );
  });

  it('omits the evidence env when there is no bridge', async () => {
    const gateProcess = vi.fn<GateProcessRunner>(() => Promise.resolve({ kind: 'completed', exitCode: 0, output: '' } as ProcessOutcome));
    const runner = createSbxSessionRunner({ proc: fakeSbxProcess(), core: 'claude', name: NAME, existing: [], gateProcess });
    await runner.runGate!('npm', ['test'], '/wt');
    expect(gateProcess.mock.calls[0]![1]).toEqual(['exec', '--env', 'KARST_SANDBOX=1', NAME, '--', 'npm', 'test']);
  });

  it('publishes on 127.0.0.1 and reports a busy port as portTaken', async () => {
    const ok = fakeSbxProcess();
    const runner = createSbxSessionRunner({ proc: ok, core: 'claude', name: NAME, existing: [] });
    await expect(runner.publishPort!({ hostPort: 4100, sandboxPort: 4100 })).resolves.toEqual({ ok: true });
    expect(ok.calls[0]!.args).toEqual(['ports', NAME, '--publish', '127.0.0.1:4100:4100']);
    const busy = fakeSbxProcess({ 'sbx ports': { code: 1, stderr: 'bind: address already in use' } });
    const r2 = createSbxSessionRunner({ proc: busy, core: 'claude', name: NAME, existing: [] });
    await expect(r2.publishPort!({ hostPort: 4100, sandboxPort: 4100 })).resolves.toMatchObject({ ok: false, portTaken: true });
    const down = fakeSbxProcess({ 'sbx ports': { code: 1, stdout: 'sandbox not running' } });
    const r3 = createSbxSessionRunner({ proc: down, core: 'claude', name: NAME, existing: [] });
    await expect(r3.publishPort!({ hostPort: 4100, sandboxPort: 4100 })).resolves.toEqual({
      ok: false, portTaken: false, reason: 'sbx ports --publish 4100 failed: sandbox not running',
    });
  });

  it('unpublishes exactly the mapping and lists only a running answer', async () => {
    const proc = fakeSbxProcess({ 'sbx ports karst-ab12cd34-7-claude': { stdout: '127.0.0.1   4100   4100   tcp4\n' } });
    const runner = createSbxSessionRunner({ proc, core: 'claude', name: NAME, existing: [] });
    await runner.unpublishPort!({ hostPort: 4100, sandboxPort: 4100 });
    expect(proc.calls[0]!.args).toEqual(['ports', NAME, '--unpublish', '127.0.0.1:4100:4100']);
    await expect(runner.listPorts!()).resolves.toEqual([{ hostPort: 4100, sandboxPort: 4100 }]);
    const failing = createSbxSessionRunner({ proc: fakeSbxProcess({ 'sbx ports': { code: 1 } }), core: 'claude', name: NAME, existing: [] });
    await expect(failing.listPorts!()).resolves.toBeNull();
  });

  it('allows only the declared baseline ports, scoped to this sandbox', async () => {
    const proc = fakeSbxProcess();
    const runner = createSbxSessionRunner({ proc, core: 'claude', name: NAME, existing: [] });
    await expect(runner.allowHostPorts!([])).resolves.toEqual({ ok: true });
    expect(proc.calls).toHaveLength(0);
    await expect(runner.allowHostPorts!([5432])).resolves.toEqual({ ok: true });
    expect(proc.calls[0]!.args).toEqual(['policy', 'allow', 'network', '--sandbox', NAME, 'host.docker.internal:5432']);
    const bad = createSbxSessionRunner({ proc: fakeSbxProcess({ 'sbx policy': { code: 2, stderr: ' denied ' } }), core: 'claude', name: NAME, existing: [] });
    await expect(bad.allowHostPorts!([5432])).resolves.toEqual({ ok: false, reason: 'sbx policy allow failed: denied' });
  });

  it('hasSandbox: only a name sbx ls lists', async () => {
    const proc = fakeSbxProcess({ 'sbx ls': { stdout: `SANDBOX  AGENT\n${NAME}  claude\n` } });
    await expect(createSbxSessionRunner({ proc, core: 'claude', name: NAME, existing: [] }).hasSandbox!()).resolves.toBe(true);
    const other = createSbxSessionRunner({ proc, core: 'claude', name: 'karst-ab12cd34-8-claude', existing: [] });
    await expect(other.hasSandbox!()).resolves.toBe(false);
    const broken = createSbxSessionRunner({ proc: fakeSbxProcess({ 'sbx ls': { code: 1, stdout: NAME } }), core: 'claude', name: NAME, existing: [] });
    await expect(broken.hasSandbox!()).resolves.toBe(false);
  });
});

describe('sbx canHostServices (review fix #109)', () => {
  it('whenever sbx lists the sandbox', async () => {
    const proc = fakeSbxProcess({ 'sbx ls': { stdout: `SANDBOX\n${NAME}\n` } });
    await expect(createSbxSessionRunner({ proc, core: 'claude', name: NAME, existing: [] }).canHostServices!()).resolves.toBe(true);
    const none = createSbxSessionRunner({ proc: fakeSbxProcess({ 'sbx ls': { code: 1, stdout: NAME } }), core: 'claude', name: NAME, existing: [] });
    await expect(none.canHostServices!()).resolves.toBe(false);
  });
});
