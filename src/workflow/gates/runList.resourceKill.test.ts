import { describe, expect, it } from 'vitest';
import { runGateList } from './runList.js';
import type { GateProcessRunner } from './run.js';
import type { ResolvedGate } from './resolve.js';

const gate = (extra: Partial<ResolvedGate> = {}): ResolvedGate => ({
  name: 'unit', command: 'npm', args: ['test'], script: 'test', required: true, ...extra,
});
const done = (exitCode: number, output = ''): ReturnType<GateProcessRunner> =>
  Promise.resolve({ kind: 'completed', exitCode, output, stdout: output, durationMs: 1, timedOut: false } as never);

interface Call { command: string; args: readonly string[] }
function scripted(...exits: Array<[number, string?]>): { runner: GateProcessRunner; calls: Call[] } {
  const calls: Call[] = [];
  const runner: GateProcessRunner = (command, args) => {
    calls.push({ command, args });
    const [code, out] = exits[Math.min(calls.length - 1, exits.length - 1)]!;
    return done(code, out);
  };
  return { runner, calls };
}

describe('runGateList — resource kill', () => {
  it('retries once with one worker and records the retry verdict, no resourceKilled', async () => {
    const { runner, calls } = scripted([137, ' ✓ a.test.ts'], [0, 'ok']);
    const out = await runGateList([gate()], '/w', { runProcess: runner, sandboxed: true });
    if (out.kind !== 'ran') throw new Error('ran');
    expect(calls).toHaveLength(2);
    expect(calls[1]).toEqual({ command: 'env', args: ['KARST_GATE_MAX_WORKERS=1', 'npm', 'test'] });
    expect(out.results[0]).toMatchObject({ exitCode: 0 });
    expect(out.results[0]!.resourceKilled).toBeUndefined();
  });

  it('marks resourceKilled when the lighter retry is killed again', async () => {
    const { runner, calls } = scripted([137, 'x'], [137, 'y']);
    const out = await runGateList([gate()], '/w', { runProcess: runner, sandboxed: true });
    if (out.kind !== 'ran') throw new Error('ran');
    expect(calls).toHaveLength(2);
    expect(out.results[0]!.resourceKilled).toMatch(/"unit".*137.*sandbox/);
  });

  it('a real failing test plus 137 is an ordinary failure with no retry', async () => {
    const { runner, calls } = scripted([137, ' FAIL  a.test.ts > x']);
    const out = await runGateList([gate()], '/w', { runProcess: runner });
    if (out.kind !== 'ran') throw new Error('ran');
    expect(calls).toHaveLength(1);
    expect(out.results[0]!.resourceKilled).toBeUndefined();
  });

  it('park: no retry, parks at once', async () => {
    const { runner, calls } = scripted([137, '']);
    const out = await runGateList([gate({ onResourceKill: 'park' })], '/w', { runProcess: runner });
    if (out.kind !== 'ran') throw new Error('ran');
    expect(calls).toHaveLength(1);
    expect(out.results[0]!.resourceKilled).toMatch(/host/);
  });

  it('host: reruns on the host process when one exists', async () => {
    const sandbox = scripted([137, '']);
    const host = scripted([0, 'ok']);
    const out = await runGateList([gate({ onResourceKill: 'host' })], '/w', {
      runProcess: sandbox.runner, hostProcess: host.runner, sandboxed: true,
    });
    if (out.kind !== 'ran') throw new Error('ran');
    expect(sandbox.calls).toHaveLength(1);
    expect(host.calls).toHaveLength(1);
    expect(out.results[0]).toMatchObject({ exitCode: 0 });
  });

  it('host without a host process falls back to retry-then-park', async () => {
    const { runner, calls } = scripted([137, ''], [137, '']);
    const out = await runGateList([gate({ onResourceKill: 'host' })], '/w', { runProcess: runner });
    if (out.kind !== 'ran') throw new Error('ran');
    expect(calls).toHaveLength(2);
    expect(out.results[0]!.resourceKilled).toBeDefined();
  });
});
