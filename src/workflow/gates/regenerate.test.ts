import { describe, expect, it } from 'vitest';
import { runGateList } from './runList.js';
import { capabilityGap } from './capabilityGap.js';
import type { GateProcessRunner } from './run.js';
import type { ResolvedGate } from './resolve.js';

const gate = { name: 'docs-graph', command: 'npm', args: ['run', 'x'], script: null, required: true } as unknown as ResolvedGate;

function fake(script: (cmd: string) => { exitCode: number; output?: string; stdout?: string }) {
  const calls: string[] = [];
  const runner: GateProcessRunner = async (command, args) => {
    const line = [command, ...args].join(' ');
    calls.push(line);
    const r = script(line);
    return { kind: 'completed', exitCode: r.exitCode, output: r.output ?? '', stdout: r.stdout ?? r.output ?? '' };
  };
  return { runner, calls };
}
const spec = { repo: 'extention', commands: ['gen-a', 'gen-b'] };

describe('regenerate before gates', () => {
  it('runs generators in order, commits only on change, then the gates', async () => {
    let statuses = 0;
    const f = fake((l) =>
      l === 'git status --porcelain -z'
        ? { exitCode: 0, stdout: statuses++ === 0 ? ' M agent.ts\0' : ' M agent.ts\0 M docs/x.md\0' }
        : { exitCode: 0 });
    const r = await runGateList([gate], '/w', { runProcess: f.runner, regenerate: { ...spec, exclude: ['gen/**'] } });
    expect(f.calls).toEqual([
      'git status --porcelain -z', 'sh -c gen-a', 'sh -c gen-b', 'git status --porcelain -z',
      'git add -A -- docs/x.md :(exclude)gen/**',
      'git commit -m chore: regenerate generated files --only -- docs/x.md', 'npm run x',
    ]);
    expect(r.results.map((x) => x.name)).toEqual(['docs-graph']);
  });

  it('makes no commit when nothing changed', async () => {
    const f = fake(() => ({ exitCode: 0 }));
    await runGateList([gate], '/w', { runProcess: f.runner, regenerate: spec });
    expect(f.calls.some((c) => c.startsWith('git commit'))).toBe(false);
  });

  it('a failing generator is the result and no gate runs', async () => {
    const f = fake((l) => (l === 'sh -c gen-a' ? { exitCode: 2, output: 'boom' } : { exitCode: 0 }));
    const r = await runGateList([gate], '/w', { runProcess: f.runner, regenerate: spec });
    expect(f.calls.filter((c) => !c.startsWith('git'))).toEqual(['sh -c gen-a']);
    expect(r).toMatchObject({ kind: 'ran', regenerateFailed: true });
    expect(r.results).toHaveLength(1);
    expect(r.results[0]).toMatchObject({ name: 'regenerate (extention)', exitCode: 2 });
    expect(r.results[0]!.output).toContain('boom');
  });

  it('exit 127 reports a capability gap naming command and both remedies', async () => {
    const f = fake(() => ({ exitCode: 127, output: 'sh: gen-a: not found' }));
    const r = await runGateList([gate], '/w', { runProcess: f.runner, regenerate: spec });
    const gap = capabilityGap(r.results);
    expect(gap).not.toBeNull();
    expect(gap!.reason).toContain('sandbox.setup');
    expect(gap!.reason).toContain('sandbox: host');
    expect(gap!.reason).toContain('gen-a');
  });

  it('a missing module in the sandbox is also a capability gap', async () => {
    const f = fake(() => ({ exitCode: 1, output: "Error: Cannot find module 'dependency-cruiser'" }));
    const r = await runGateList([gate], '/w', { runProcess: f.runner, sandboxed: true, regenerate: spec });
    expect(r.results[0]!.exitCode).toBe(127);
  });

  it('a host-only entry runs on the host runner', async () => {
    const sb = fake(() => ({ exitCode: 0 }));
    const host = fake(() => ({ exitCode: 0 }));
    await runGateList([], '/w', {
      runProcess: sb.runner, hostProcess: host.runner,
      regenerate: { repo: 'r', commands: ['a', { run: 'b', sandbox: 'host' }] },
    });
    expect(host.calls).toEqual(['sh -c b']);
    expect(sb.calls).toContain('sh -c a');
  });

  it('no regenerate configured → gates only', async () => {
    const f = fake(() => ({ exitCode: 0 }));
    await runGateList([gate], '/w', { runProcess: f.runner });
    expect(f.calls).toEqual(['npm run x']);
  });
});
