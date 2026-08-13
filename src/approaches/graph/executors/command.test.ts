/**
 * Command node executor tests (Slice 3 Task 4).
 *
 * Exit-code mapping, per-repository serial execution consuming one slot, the
 * minimal environment (exactly the four names plus the project map, no
 * secret), and the aggregation rule (infrastructure fault wins, else any
 * non-zero exit wins, else passed).
 */

import { describe, it, expect } from 'vitest';
import { buildCommandEnv, runCommandNode, type CommandNodeRunOptions } from './command.js';
import type { ProcessOutcome } from '../../../workflow/gates/run.js';

function processOf(process: ProcessOutcome): ProcessOutcome {
  return process;
}

function outcome(process: ProcessOutcome): ProcessOutcome {
  return processOf(process);
}

function optsWith(
  runs: ProcessOutcome[],
  cwds: Record<string, string> = {},
): { opts: CommandNodeRunOptions; order: string[] } {
  const order: string[] = [];
  let i = 0;
  return {
    order,
    opts: {
      cwdFor: (repo) => cwds[repo] ?? `/wt/${repo}`,
      run: async (_cmd, _args, cwd) => {
        order.push(cwd);
        return runs[Math.min(i++, runs.length - 1)]!;
      },
    },
  };
}

describe('runCommandNode', () => {
  it('maps exit 0 → passed, non-zero → failed, spawn/timeout fault → infrastructure-error', async () => {
    const h = optsWith([
      outcome({ kind: 'completed', exitCode: 0, output: 'ok' }),
      outcome({ kind: 'completed', exitCode: 3, output: 'boom' }),
      outcome({ kind: 'spawnFailed', message: 'ENOENT', output: '' }),
      outcome({ kind: 'timedOut', output: 'slow' }),
    ]);
    const result = await runCommandNode('test', [], ['a', 'b', 'c', 'd'], {}, h.opts);
    expect(result.perRepo.map((r) => r.outcome)).toEqual([
      'passed',
      'failed',
      'infrastructure-error',
      'infrastructure-error',
    ]);
  });

  it('runs repositories serially — one slot at a time, never in parallel', async () => {
    let concurrent = 0;
    let maxConcurrent = 0;
    const runs = ['r1', 'r2', 'r3'].map(
      (name) =>
        async (): Promise<ProcessOutcome> => {
          concurrent += 1;
          maxConcurrent = Math.max(maxConcurrent, concurrent);
          await new Promise((r) => setTimeout(r, 5));
          concurrent -= 1;
          return { kind: 'completed', exitCode: 0, output: name };
        },
    );
    const result = await runCommandNode('test', [], ['r1', 'r2', 'r3'], {}, {
      cwdFor: (repo) => `/wt/${repo}`,
      run: async (_cmd, _args, cwd) => {
        const index = ['/wt/r1', '/wt/r2', '/wt/r3'].indexOf(cwd);
        return runs[index]!();
      },
    });
    expect(maxConcurrent).toBe(1);
    expect(result.outcome).toBe('passed');
    expect(result.perRepo.map((r) => r.repo)).toEqual(['r1', 'r2', 'r3']);
  });

  it('aggregates: any infrastructure fault wins, else any non-zero exit wins, else passed', async () => {
    const infra = await runCommandNode('test', [], ['a', 'b'], {}, optsWith([
      outcome({ kind: 'completed', exitCode: 1, output: 'failed' }),
      outcome({ kind: 'timedOut', output: 'timeout' }),
    ]).opts);
    expect(infra.outcome).toBe('infrastructure-error');

    const failed = await runCommandNode('test', [], ['a', 'b'], {}, optsWith([
      outcome({ kind: 'completed', exitCode: 0, output: 'ok' }),
      outcome({ kind: 'completed', exitCode: 2, output: 'nope' }),
    ]).opts);
    expect(failed.outcome).toBe('failed');

    const passed = await runCommandNode('test', [], ['a', 'b'], {}, optsWith([
      outcome({ kind: 'completed', exitCode: 0, output: 'ok' }),
      outcome({ kind: 'completed', exitCode: 0, output: 'ok2' }),
    ]).opts);
    expect(passed.outcome).toBe('passed');
  });
});

describe('buildCommandEnv', () => {
  it('contains exactly the four names plus the project map — and no secret', () => {
    const env = buildCommandEnv({
      TEST_FLAG: '1',
      APP_DB: 'sqlite://x',
    });
    const keys = Object.keys(env).sort();
    expect(keys).toEqual(['APP_DB', 'HOME', 'LANG', 'PATH', 'TEST_FLAG', 'TMPDIR']);
    for (const secret of [
      'KARST_GRAPH_CAPABILITY',
      'KARST_GRAPH_CALLBACK_URL',
      'KARST_GRAPH_ARTIFACT_ROOT',
      'KARST_LAUNCH_ID',
      'GITHUB_TOKEN',
      'VSCODE_TOKEN',
    ]) {
      expect(secret in env).toBe(false);
    }
  });

  it('the project map wins over the base values', () => {
    const env = buildCommandEnv({ LANG: 'en_US.UTF-8' });
    expect(env.LANG).toBe('en_US.UTF-8');
    expect(env.PATH).toBeDefined();
  });
});
