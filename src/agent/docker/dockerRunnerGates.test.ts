import { describe, expect, it, vi } from 'vitest';
import type { GateProcessRunner } from '../../workflow/gates/run.js';
import type { ProcessOutcome } from '../../workflow/gates/run.js';
import { dockerNames } from './dockerNames.js';
import { createDockerSessionRunner } from './dockerRunner.js';
import { fakeDockerProcess } from './fakeDockerProcess.js';

const names = dockerNames({ projectRoot: '/p', ticketId: 7, core: 'opencode' });
const RUNNING = { 'docker container inspect': { stdout: 'true\n' } };
const base = { core: 'opencode' as const, names, user: undefined, newRunId: () => 'r1' };

describe('docker runner: gates and ports (arch:AC-32)', () => {
  it('runs a gate via docker exec with the evidence dir and rewritten paths; kills it when the run ends', async () => {
    const proc = fakeDockerProcess(RUNNING);
    const outcome: ProcessOutcome = { kind: 'completed', exitCode: 2, output: 'x' };
    const gateProcess = vi.fn<GateProcessRunner>(() => Promise.resolve(outcome));
    const runner = createDockerSessionRunner({ ...base, proc, gateProcess, evidenceDir: '/karst-bridge/7' });
    await expect(runner.runGate!('npm', ['test', '/w/t7/a.ts'], '/w/t7')).resolves.toBe(outcome);
    const argv = gateProcess.mock.calls[0]![1];
    expect(argv.slice(0, 7)).toEqual(['exec', '--interactive', '--env', 'KARST_EVIDENCE_DIR=/karst-bridge/7', '--workdir', '/work/repo', names.container]);
    expect(argv.slice(-3)).toEqual(['npm', 'test', '/work/repo/a.ts']);
    expect(proc.calls.map((c) => c.args.slice(0, 2).join(' '))).toEqual(['container inspect', `exec ${names.container}`]);
  });

  it('an abort kills the in-container gate while it is still running; the event loop stays free', async () => {
    const proc = fakeDockerProcess(RUNNING);
    const ac = new AbortController();
    let release!: (o: ProcessOutcome) => void;
    const gateProcess = vi.fn<GateProcessRunner>(() => new Promise<ProcessOutcome>((r) => { release = r; }));
    const runner = createDockerSessionRunner({ ...base, proc, gateProcess });
    const pending = runner.runGate!('npm', ['test'], '/w/t7', { signal: ac.signal });
    await new Promise<void>((r) => setImmediate(r));
    let ticked = false;
    await new Promise<void>((r) => setImmediate(() => { ticked = true; r(); }));
    expect(ticked).toBe(true);
    expect(gateProcess).toHaveBeenCalled();
    ac.abort();
    expect(proc.calls).toHaveLength(2);
    expect(proc.calls[1]!.args.join(' ')).toContain('karst-kill r1');
    release({ kind: 'aborted', output: '' });
    await expect(pending).resolves.toEqual({ kind: 'aborted', output: '' });
  });

  it('publishes, unpublishes and lists through the relay; dispose removes its relays', async () => {
    const proc = fakeDockerProcess({ 'docker ps --filter': { stdout: '4100:3000\n' } });
    const runner = createDockerSessionRunner({ ...base, proc });
    await expect(runner.publishPort!({ hostPort: 4100, sandboxPort: 3000 })).resolves.toEqual({ ok: true });
    await runner.unpublishPort!({ hostPort: 4100, sandboxPort: 3000 });
    await expect(runner.listPorts!()).resolves.toEqual([{ hostPort: 4100, sandboxPort: 3000 }]);
    await runner.dispose!({ hostWorktreePath: '/w/t7', branch: 'b' });
    expect(proc.calls.map((c) => c.args.join(' '))).toContain(`ps --all --quiet --filter label=karst.relay=${names.container}`);
  });

  it('with the interactive container gone, runs the gate in a one-shot container on the clone, removed by name', async () => {
    const proc = fakeDockerProcess({ 'docker container inspect': { stdout: 'false\n' } });
    const gateProcess = vi.fn<GateProcessRunner>(() => Promise.resolve({ kind: 'completed', exitCode: 0, output: '' }));
    const runner = createDockerSessionRunner({ ...base, proc, gateProcess, evidenceDir: '/karst-bridge/7' });
    const ac = new AbortController();
    await runner.runGate!('npm', ['test'], '/w/t7', { signal: ac.signal });
    const argv = gateProcess.mock.calls[0]![1];
    const gateName = `${names.container}-gate-r1`;
    expect(argv.slice(0, 6)).toEqual(['run', '--rm', '--name', gateName, '--network', names.network]);
    expect(argv).toEqual(expect.arrayContaining(['--cap-drop', 'ALL', 'KARST_EVIDENCE_DIR=/karst-bridge/7', '--workdir', '/work/repo']));
    expect(argv.slice(-2)).toEqual(['npm', 'test']);
    expect(argv.join(' ')).not.toMatch(/--privileged|docker\.sock|--publish/);
    expect(proc.calls.at(-1)!.args).toEqual(['rm', '--force', gateName]);
  });

  it('hasSandbox is the clone volume', async () => {
    const yes = createDockerSessionRunner({ ...base, proc: fakeDockerProcess() });
    await expect(yes.hasSandbox!()).resolves.toBe(true);
    const no = createDockerSessionRunner({ ...base, proc: fakeDockerProcess({ 'docker volume inspect': { code: 1 } }) });
    await expect(no.hasSandbox!()).resolves.toBe(false);
  });
});

describe('docker canHostServices (review fix #109, T-B F15)', () => {
  it('is true while the interactive container runs, without starting a service container', async () => {
    const proc = fakeDockerProcess(RUNNING);
    await expect(createDockerSessionRunner({ ...base, proc }).canHostServices!()).resolves.toBe(true);
    expect(proc.calls.some((c) => c.args[0] === 'run')).toBe(false);
  });

  it('starts a detached hardened service container on the clone volume once the terminal is closed', async () => {
    const proc = fakeDockerProcess({ 'docker container inspect': { stdout: 'false' } });
    await expect(createDockerSessionRunner({ ...base, proc }).canHostServices!()).resolves.toBe(true);
    const run = proc.calls.find((c) => c.args[0] === 'run')!.args;
    expect(run).toEqual(expect.arrayContaining(['-d', '--cap-drop', 'ALL', 'no-new-privileges', '--network-alias', base.names.container]));
    expect(run).not.toContain('--rm');
    expect(run.join(' ')).toContain(base.names.repoVolume);
  });

  it('is false when the service container cannot start', async () => {
    const proc = fakeDockerProcess({ 'docker container inspect': { code: 1 }, 'docker run': { code: 1 } });
    await expect(createDockerSessionRunner({ ...base, proc }).canHostServices!()).resolves.toBe(false);
  });

  it('stopServices removes the service container', async () => {
    const proc = fakeDockerProcess();
    await createDockerSessionRunner({ ...base, proc }).stopServices!();
    expect(proc.calls.at(-1)!.args).toEqual(['rm', '--force', `${base.names.container}-svc`]);
  });
});
