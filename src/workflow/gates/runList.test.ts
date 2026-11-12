import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { runGateList } from './runList.js';
import { UI_GATE_TIMEOUT_MS } from './run.js';

describe('runGateList', () => {
  const now = () => '2026-07-30T10:00:00.000Z';

  it('runs every gate — no short-circuit on the first failure', async () => {
    const out = await runGateList(
      [
        { name: 'a', command: 'node', args: ['-e', 'process.exit(1)'], script: null, required: true },
        { name: 'b', command: 'node', args: ['-e', 'process.exit(0)'], script: null, required: true },
      ],
      process.cwd(),
      { now },
    );
    expect(out.kind).toBe('ran');
    if (out.kind !== 'ran') return;
    expect(out.results.map((r) => [r.name, r.exitCode])).toEqual([['a', 1], ['b', 0]]);
  });

  it('stamps a duration on a gate that ran and none on one that did not', async () => {
    const out = await runGateList(
      [
        { name: 'a', command: 'node', args: ['-e', ''], script: null, required: true },
        { name: 'missing', command: '', args: [], script: 'nope', required: false },
      ],
      process.cwd(),
      { now },
    );
    if (out.kind !== 'ran') throw new Error('expected ran');
    expect(out.results[0]!.startedAt).toBe(now());
    expect(out.results[1]!.exitCode).toBeNull();
    expect(out.results[1]!.startedAt).toBeUndefined();
  });

  it('reports stopped when the run is aborted, never a failing gate', async () => {
    const controller = new AbortController();
    const started = runGateList(
      [{ name: 'slow', command: 'node', args: ['-e', 'setTimeout(()=>{},60000)'], script: null, required: true }],
      process.cwd(),
      { signal: controller.signal, now },
    );
    setTimeout(() => controller.abort(), 50);
    const out = await started;
    expect(out.kind).toBe('stopped');
    if (out.kind !== 'stopped') return;
    // Aborted before the one gate completed: no evidence to carry.
    expect(out.results).toEqual([]);
  });

  // Standing amendment: "persist partial gate evidence on stopped and blocked
  // outcomes through one transactional outcome writer" / "collect
  // completed-target evidence before parking a multi-repository run." A
  // `stopped` outcome must still carry whatever gates already finished —
  // `gate_runs` is the ONLY place a prior attempt's evidence survives, so
  // discarding it here makes it unrecoverable by any caller.
  it('carries completed gate results on stopped when the abort lands after the first gate finishes', async () => {
    const controller = new AbortController();
    const started = runGateList(
      [
        { name: 'fast', command: 'node', args: ['-e', 'process.exit(0)'], script: null, required: true },
        { name: 'slow', command: 'node', args: ['-e', 'setTimeout(()=>{},60000)'], script: null, required: true },
      ],
      process.cwd(),
      {
        signal: controller.signal,
        now,
        // Abort the instant the first gate's result is recorded — the loop
        // checks the signal before the next gate, so this lands DETERMINISTICALLY
        // between the two. A wall-clock `setTimeout(…, 200)` here raced the first
        // `node` spawn: on the loaded gate machine it occasionally aborted before
        // `fast` finished, and the test then saw no carried results.
        onGateComplete: (name) => {
          if (name === 'fast') controller.abort();
        },
      },
    );
    const out = await started;
    expect(out.kind).toBe('stopped');
    if (out.kind !== 'stopped') return;
    expect(out.results).toEqual([
      expect.objectContaining({ name: 'fast', exitCode: 0 }),
    ]);
  });

  it('fails a configured gate whose script the repo does not define', async () => {
    const out = await runGateList(
      [{ name: 'integration', command: 'npm', args: ['run', 'test:integration'], script: 'test:integration', required: true }],
      process.cwd(),
      { now, scriptsAvailable: () => false },
    );
    if (out.kind !== 'ran') throw new Error('expected ran');
    expect(out.results[0]).toMatchObject({ exitCode: 1 });
    expect(out.results[0]!.output).toContain('does not define');
  });

  // The `=== false` guard, not `!opts.scriptsAvailable?.(...)`: an ABSENT
  // scriptsAvailable callback must mean "karst did not check", not "the
  // script is missing". None of the tests above distinguish this — they
  // either omit scriptsAvailable on a gate that isn't `required`+scripted,
  // or pass a callback that returns `false` (where `!` and `=== false` agree).
  // This is the one case where they disagree: a required, scripted gate with
  // NO scriptsAvailable callback at all must still actually run.
  it('runs a required, scripted gate normally when scriptsAvailable is not provided at all', async () => {
    const out = await runGateList(
      [{ name: 'test', command: 'node', args: ['-e', 'process.exit(0)'], script: 'test', required: true }],
      process.cwd(),
      { now },
    );
    if (out.kind !== 'ran') throw new Error('expected ran');
    expect(out.results[0]).toMatchObject({ exitCode: 0 });
  });

  it('calls onGateComplete after each gate finishes, with the gate name', async () => {
    const completed: string[] = [];
    await runGateList(
      [
        { name: 'lint', command: 'node', args: ['-e', 'process.exit(0)'], script: null, required: true },
        { name: 'test', command: 'node', args: ['-e', 'process.exit(1)'], script: null, required: true },
      ],
      process.cwd(),
      { now, onGateComplete: (name) => completed.push(name) },
    );
    expect(completed).toEqual(['lint', 'test']);
  });

  it('calls onGateComplete for a required gate whose script is missing', async () => {
    const completed: string[] = [];
    await runGateList(
      [{ name: 'integration', command: 'npm', args: ['run', 'test:integration'], script: 'test:integration', required: true }],
      process.cwd(),
      { now, scriptsAvailable: () => false, onGateComplete: (name) => completed.push(name) },
    );
    expect(completed).toEqual(['integration']);
  });

  it('calls onGateComplete for a non-required gate that fails to spawn', async () => {
    const completed: string[] = [];
    await runGateList(
      [{ name: 'e2e', command: 'nonexistent-binary', args: [], script: 'e2e', required: false }],
      process.cwd(),
      { now, onGateComplete: (name) => completed.push(name) },
    );
    expect(completed).toEqual(['e2e']);
  });

  it('does not call onGateComplete for gates that were not reached (abort before start)', async () => {
    const controller = new AbortController();
    controller.abort();
    const completed: string[] = [];
    await runGateList(
      [
        { name: 'a', command: 'node', args: ['-e', ''], script: null, required: true },
        { name: 'b', command: 'node', args: ['-e', ''], script: null, required: true },
      ],
      process.cwd(),
      { signal: controller.signal, now, onGateComplete: (name) => completed.push(name) },
    );
    expect(completed).toEqual([]);
  });
});

describe('onGateStart', () => {
  it('fires before each gate begins, with the gate name', async () => {
    const started: string[] = [];
    await runGateList(
      [
        { name: 'a', command: 'true', args: [], script: 'test', required: true },
        { name: 'b', command: 'true', args: [], script: 'test', required: true },
      ],
      '/wt',
      { onGateStart: (name) => started.push(name) },
    );
    expect(started).toEqual(['a', 'b']);
  });

  it('does not fire for gates that were not reached (abort before start)', async () => {
    const controller = new AbortController();
    controller.abort();
    const started: string[] = [];
    await runGateList(
      [{ name: 'a', command: 'true', args: [], script: 'test', required: true }],
      '/wt',
      { signal: controller.signal, onGateStart: (name) => started.push(name) },
    );
    expect(started).toEqual([]);
  });

  it('pairs with onGateComplete carrying the recorded exit code', async () => {
    const seen: Array<[string, number | null]> = [];
    await runGateList(
      [{ name: 'a', command: 'node', args: ['-e', 'process.exit(0)'], script: 'test', required: true }],
      process.cwd(),
      { onGateComplete: (name, exitCode) => seen.push([name, exitCode]) },
    );
    expect(seen).toEqual([['a', 0]]);
  });

  it('carries the row timing and the gate index, so callers can persist per gate', async () => {
    const seen: Array<[string, number | null, string | null, string | null, number]> = [];
    await runGateList(
      [
        { name: 'a', command: 'node', args: ['-e', 'process.exit(0)'], script: null, required: true },
        { name: 'b', command: 'node', args: ['-e', 'process.exit(1)'], script: null, required: true },
      ],
      process.cwd(),
      {
        now: () => '2026-07-20T12:00:00.000Z',
        onGateComplete: (name, exitCode, startedAt, endedAt, index) =>
          seen.push([name, exitCode, startedAt, endedAt, index]),
      },
    );
    expect(seen).toEqual([
      ['a', 0, '2026-07-20T12:00:00.000Z', '2026-07-20T12:00:00.000Z', 0],
      ['b', 1, '2026-07-20T12:00:00.000Z', '2026-07-20T12:00:00.000Z', 1],
    ]);
  });

  it('reports a gate that never ran with null timing, never invented zeros', async () => {
    const seen: Array<[string, number | null, string | null, string | null]> = [];
    await runGateList(
      [{ name: 'e2e', command: 'nonexistent-binary', args: [], script: 'e2e', required: false }],
      process.cwd(),
      { onGateComplete: (name, exitCode, startedAt, endedAt) => seen.push([name, exitCode, startedAt, endedAt]) },
    );
    expect(seen).toEqual([['e2e', null, null, null]]);
  });

  it('carries the gate output through onGateComplete, so a failure summary can be derived at append time', async () => {
    const seen: Array<[string, number | null, string]> = [];
    await runGateList(
      [
        { name: 'lint', command: 'node', args: ['-e', "process.stderr.write('src/pages/index.vue:23:9 Replace `x`\\n'); process.exit(1)"], script: null, required: true },
      ],
      process.cwd(),
      { onGateComplete: (name, exitCode, _startedAt, _endedAt, _index, output) => seen.push([name, exitCode, output ?? '']) },
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]![0]).toBe('lint');
    expect(seen[0]![1]).toBe(1);
    expect(seen[0]![2]).toContain('src/pages/index.vue:23:9 Replace `x`');
  });

  it('carries the output of a required gate whose script is missing, so its synthesized failure is recorded', async () => {
    const seen: Array<[string, string]> = [];
    await runGateList(
      [{ name: 'integration', command: 'npm', args: ['run', 'test:integration'], script: 'test:integration', required: true }],
      process.cwd(),
      { now: () => '2026-07-30T10:00:00.000Z', scriptsAvailable: () => false, onGateComplete: (name, _exit, _s, _e, _i, output) => seen.push([name, output ?? '']) },
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]![1]).toContain('which package.json does not define');
  });
});

describe('runGateList live output', () => {
  it('forwards each gate\'s live output chunks tagged with the gate name', async () => {
    const seen: { gate: string; text: string }[] = [];
    await runGateList(
      [{ name: 'unit', command: 'node', args: ['-e', 'process.stdout.write("tick")'], script: null, required: true }],
      process.cwd(),
      { now: () => '2026-07-30T10:00:00.000Z', onGateOutput: (gate, chunk) => seen.push({ gate, text: chunk.text }) },
    );
    expect(seen.map((s) => s.gate)).toEqual(['unit']);
    expect(seen.map((s) => s.text).join('')).toContain('tick');
  });
});

describe('runGateList: injected gate process (arch:AC-32 sandbox gates)', () => {
  it('runs each gate through the injected runner and keeps the exit code as the verdict', async () => {
    const calls: string[] = [];
    const out = await runGateList(
      [{ name: 'test', command: 'npm', args: ['test'], script: null, required: true }],
      '/wt',
      {
        runProcess: (command, args, cwd) => {
          calls.push([command, ...args, cwd].join(' '));
          return Promise.resolve({ kind: 'completed', exitCode: 4, output: 'in sandbox' });
        },
      },
    );
    expect(calls).toEqual(['npm test /wt']);
    expect(out.kind).toBe('ran');
    expect(out.results[0]).toMatchObject({ name: 'test', exitCode: 4, output: 'in sandbox' });
  });
});

describe('runGateList: refused host gate (arch:SANDBOX-HOST)', () => {
  it('records a required host gate spawnFailed as exit null + hostRefused, not a failure', async () => {
    const out = await runGateList(
      [{ name: 'visual', command: 'docker', args: [], script: null, required: true, sandbox: 'host' }],
      '/wt',
      { hostProcess: () => Promise.resolve({ kind: 'spawnFailed', message: 'host gates not run: dirty', output: 'host gates not run: dirty' }) },
    );
    expect(out.results[0]).toMatchObject({ name: 'visual', exitCode: null, hostRefused: true, output: 'host gates not run: dirty' });
  });

  it('keeps an inside gate spawnFailed as exit 1', async () => {
    const out = await runGateList(
      [{ name: 'unit', command: 'npm', args: [], script: null, required: true }],
      '/wt',
      { runProcess: () => Promise.resolve({ kind: 'spawnFailed', message: 'x', output: 'x' }) },
    );
    expect(out.results[0]).toMatchObject({ exitCode: 1 });
  });

  const now = (): string => '2026-01-01T00:00:00.000Z';

  it('parks a command gate as stale when the base defines the missing script', async () => {
    const out = await runGateList(
      [{ name: 'docs-graph', command: 'npm', args: ['run', '-s', 'docs:graph'], script: 'docs:graph', derivedScript: true, required: true }],
      process.cwd(),
      { now, scriptsAvailable: () => false, baseRef: 'develop', baseDefinesScript: async () => true },
    );
    if (out.kind !== 'ran') throw new Error('expected ran');
    expect(out.results[0]!.staleBranch).toBe(
      'gate "docs-graph" runs npm script "docs:graph", which develop defines but this branch does not — rebase onto develop ("Rebase on base")',
    );
  });

  it('fails naming the script when neither branch nor base defines it', async () => {
    const out = await runGateList(
      [{ name: 'docs-graph', command: 'npm', args: ['run', 'docs:graph'], script: 'docs:graph', derivedScript: true, required: true }],
      process.cwd(),
      { now, scriptsAvailable: () => false, baseDefinesScript: async () => false },
    );
    if (out.kind !== 'ran') throw new Error('expected ran');
    expect(out.results[0]).toMatchObject({ exitCode: 1 });
    expect(out.results[0]!.staleBranch).toBeUndefined();
    expect(out.results[0]!.output).toContain('"docs:graph"');
  });

  it('passes the derived flag to scriptsAvailable so a caller can skip an unverifiable derived check', async () => {
    const out = await runGateList(
      [{ name: 'g', command: 'node', args: ['-e', 'process.exit(0)'], script: 'x', derivedScript: true, required: true }],
      process.cwd(),
      { now, scriptsAvailable: (_script, derived) => derived },
    );
    if (out.kind !== 'ran') throw new Error('expected ran');
    expect(out.results[0]).toMatchObject({ exitCode: 0 });
  });

  it('never consults the base for a kind: script gate', async () => {
    const out = await runGateList(
      [{ name: 'lint', command: 'npm', args: ['run', 'lint'], script: 'lint', required: true }],
      process.cwd(),
      { now, scriptsAvailable: () => false, baseDefinesScript: async () => true },
    );
    if (out.kind !== 'ran') throw new Error('expected ran');
    expect(out.results[0]!.staleBranch).toBeUndefined();
  });

  it('gives a failing gate with no output a synthetic explanation', async () => {
    const out = await runGateList(
      [{ name: 'quiet', command: 'node', args: ['-e', 'process.exit(3)'], script: null, required: true }],
      process.cwd(),
      { now },
    );
    if (out.kind !== 'ran') throw new Error('expected ran');
    expect(out.results[0]!.output).toBe('exited 3 with no output (command: node -e process.exit(3))');
  });
});

describe('runGateList port slot', () => {
  const now = () => '2026-07-30T10:00:00.000Z';
  it('runs an integration gate under a leased KARST_TEST_PORT_OFFSET', async () => {
    const seen: Array<{ cmd: string; args: readonly string[] }> = [];
    const out = await runGateList(
      [{ name: 'test:integration', command: 'npm', args: ['run', 'test:integration'], script: null, required: true }],
      process.cwd(),
      {
        now,
        runProcess: async (cmd, args) => {
          seen.push({ cmd, args });
          return { kind: 'completed', exitCode: 0, output: '' };
        },
      },
    );
    expect(out.kind).toBe('ran');
    expect(seen[0]!.cmd).toBe('env');
    expect(seen[0]!.args[0]).toMatch(/^KARST_TEST_PORT_OFFSET=\d+$/);
    expect(seen[0]!.args.slice(1)).toEqual(['npm', 'run', 'test:integration']);
  });
  it('leaves a non-integration gate untouched', async () => {
    const seen: string[] = [];
    await runGateList(
      [{ name: 'lint', command: 'npm', args: ['run', 'lint'], script: null, required: true }],
      process.cwd(),
      { now, runProcess: async (cmd) => (seen.push(cmd), { kind: 'completed', exitCode: 0, output: '' }) },
    );
    expect(seen).toEqual(['npm']);
  });
});

describe('runGateList base ref env', () => {
  const now = () => '2026-07-30T10:00:00.000Z';
  const gates = [{ name: 'lint', command: 'npm', args: ['run', 'lint'], script: null, required: true }];
  it('exports KARST_BASE_REF to the gate process', async () => {
    const seen: Array<{ cmd: string; args: readonly string[] }> = [];
    await runGateList(gates, process.cwd(), { now, baseRef: 'develop', runProcess: async (cmd, args) => (seen.push({ cmd, args }), { kind: 'completed', exitCode: 0, output: '' }) });
    expect(seen[0]).toEqual({ cmd: 'env', args: ['KARST_BASE_REF=develop', 'npm', 'run', 'lint'] });
  });
});

describe('runGateList PR_BODY env (docs gate citations)', () => {
  const now = () => '2026-07-30T10:00:00.000Z';
  const gates = [{ name: 'docs:gate', command: 'npm', args: ['run', '-s', 'docs:gate'], script: null, required: true }];
  const run = async (opts: Record<string, unknown>) => {
    const seen: Array<readonly string[]> = [];
    await runGateList(gates, process.cwd(), { now, ...opts, runProcess: async (_c, args) => (seen.push(args), { kind: 'completed', exitCode: 0, output: '' }) });
    return seen[0];
  };
  it('passes the citation text as PR_BODY with the base branch as BASE_REF', async () => {
    expect(await run({ baseRef: 'develop', prBody: '@arch:CLI-02 — holds' })).toEqual([
      'KARST_BASE_REF=develop', 'PR_BODY=@arch:CLI-02 — holds', 'BASE_REF=develop', 'npm', 'run', '-s', 'docs:gate',
    ]);
  });
  it('passes an empty PR_BODY when nothing is cited', async () => {
    expect(await run({ baseRef: 'develop', prBody: '' })).toContain('PR_BODY=');
  });
  it('keeps the text as one argument (never evaluated by a shell)', async () => {
    const args = (await run({ baseRef: 'main', prBody: '$(touch x); a b' })) ?? [];
    expect(args).toContain('PR_BODY=$(touch x); a b');
  });
  it('sets no PR_BODY when the caller gives none', async () => {
    expect((await run({ baseRef: 'develop' }))?.some((a) => a.startsWith('PR_BODY='))).toBe(false);
  });
});

describe('runGateList port slot — review fixes', () => {
  const now = () => '2026-07-30T10:00:00.000Z';
  const gate = { name: 'test:integration', command: 'npm', args: ['run', 'test:integration'], script: null, required: true, onResourceKill: 'host' as const };
  it('keeps the leased offset on the resource-kill host fallback', async () => {
    const calls: Array<{ who: string; args: readonly string[] }> = [];
    const kill = { kind: 'completed' as const, exitCode: 137, output: '' };
    await runGateList([gate], process.cwd(), {
      now,
      runProcess: async (_c, args) => (calls.push({ who: 'run', args }), kill),
      hostProcess: async (_c, args) => (calls.push({ who: 'host', args }), { kind: 'completed' as const, exitCode: 0, output: '' }),
    });
    const host = calls.find((c) => c.who === 'host')!;
    expect(host.args[0]).toMatch(/^KARST_TEST_PORT_OFFSET=\d+$/);
  });

  it('hands each gate its name when registering the spawned pid', async () => {
    const seen: string[] = [];
    let disposed = 0;
    await runGateList(
      [
        { name: 'a', command: 'node', args: ['-e', ''], script: null, required: true },
        { name: 'b', command: 'node', args: ['-e', 'process.exit(1)'], script: null, required: true },
      ],
      process.cwd(),
      {
        now,
        onGateSpawned: (name) => {
          seen.push(name);
          return () => void disposed++;
        },
      },
    );
    expect(seen).toEqual(['a', 'b']);
    expect(disposed).toBe(2);
  });
});

describe('runGateList gate concurrency lease', () => {
  const now = () => '2026-07-30T10:00:00.000Z';
  const limited = { name: 'sast', command: 'semgrep', args: [], script: null, required: true, maxConcurrent: 1 };
  const done = { kind: 'completed' as const, exitCode: 0, output: '' };
  const mkDir = () => mkdtempSync(join(tmpdir(), 'karst-gate-lease-'));

  it('holds the slot during every spawn and frees it after', async () => {
    const dir = mkDir();
    try {
      let heldDuring: string[] = [];
      await runGateList([limited], process.cwd(), {
        now,
        gateSlotsDir: dir,
        runProcess: async () => {
          heldDuring = readdirSync(join(dir, 'sast'));
          return done;
        },
      });
      expect(heldDuring).toEqual(['slot-0']);
      expect(readdirSync(join(dir, 'sast'))).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('frees the slot when the spawn throws', async () => {
    const dir = mkDir();
    try {
      await expect(
        runGateList([limited], process.cwd(), {
          now,
          gateSlotsDir: dir,
          runProcess: async () => {
            throw new Error('boom');
          },
        }),
      ).rejects.toThrow('boom');
      expect(readdirSync(join(dir, 'sast'))).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not touch the pool for a gate without maxConcurrent', async () => {
    const dir = mkDir();
    try {
      await runGateList([{ ...limited, maxConcurrent: undefined }], process.cwd(), {
        now,
        gateSlotsDir: dir,
        runProcess: async () => done,
      });
      expect(readdirSync(dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('writes one waiting line, then runs once the other run releases', async () => {
    const dir = mkDir();
    try {
      mkdirSync(join(dir, 'sast', 'slot-0'), { recursive: true });
      writeFileSync(join(dir, 'sast', 'slot-0', 'owner'), String(process.pid));
      const lines: string[] = [];
      let ran = false;
      const pending = runGateList([limited], process.cwd(), {
        now,
        gateSlotsDir: dir,
        gateSlotPollMs: 5,
        onGateOutput: (name, chunk) => lines.push(`${name}|${chunk.stream}|${chunk.text}`),
        runProcess: async () => ((ran = true), done),
      });
      await new Promise((r) => setTimeout(r, 40));
      expect(ran).toBe(false);
      expect(lines).toEqual(['sast|stderr|sast: waiting for a free slot (1 of 1 in use by other tickets)\n']);
      rmSync(join(dir, 'sast', 'slot-0'), { recursive: true });
      const out = await pending;
      expect(out.kind).toBe('ran');
      expect(ran).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns stopped when Stop lands during the wait, and never spawns', async () => {
    const dir = mkDir();
    try {
      mkdirSync(join(dir, 'sast', 'slot-0'), { recursive: true });
      writeFileSync(join(dir, 'sast', 'slot-0', 'owner'), String(process.pid));
      const ac = new AbortController();
      let ran = false;
      const pending = runGateList([limited], process.cwd(), {
        now,
        gateSlotsDir: dir,
        gateSlotPollMs: 5,
        signal: ac.signal,
        runProcess: async () => ((ran = true), done),
      });
      setTimeout(() => ac.abort(), 20);
      const out = await pending;
      expect(out.kind).toBe('stopped');
      expect(ran).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('runGateList gate timeout', () => {
  const now = () => '2026-07-30T10:00:00.000Z';
  const timeoutOf = async (script: string | null, timeoutMinutes?: number): Promise<number | undefined> => {
    let seen: number | undefined;
    const gates = [{ name: 'g', command: 'npm', args: ['run', 'x'], script, required: true, ...(timeoutMinutes ? { timeoutMinutes } : {}) }];
    await runGateList(gates, process.cwd(), { now, runProcess: async (_c, _a, _w, o) => (seen = o?.timeoutMs, { kind: 'completed', exitCode: 0, output: '' }) });
    return seen;
  };
  it('gives the visual and layout sweeps a timeout above the 31 minute sweep', async () => {
    expect(await timeoutOf('test:visual:docker')).toBe(UI_GATE_TIMEOUT_MS);
    expect(await timeoutOf('test:layout:docker')).toBe(UI_GATE_TIMEOUT_MS);
    expect(UI_GATE_TIMEOUT_MS).toBeGreaterThan(31 * 60 * 1_000);
  });
  it('a gate timeoutMinutes from the manifest wins over the default', async () => {
    expect(await timeoutOf('test:visual:docker', 60)).toBe(60 * 60 * 1_000);
    expect(await timeoutOf('test', 5)).toBe(5 * 60 * 1_000);
  });
  it('leaves another gate on the default timeout', async () => {
    expect(await timeoutOf('test')).toBeUndefined();
  });
});
