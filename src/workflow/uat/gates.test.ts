import { describe, it, expect } from 'vitest';
import { resolveUatGates, runUatGates, PROBE_SCRIPTS } from './gates.js';
import { uat } from '../../manifest/fixtures.js';

describe('resolveUatGates', () => {
  it('probes package.json when no gates are configured', () => {
    const res = resolveUatGates(
      { kind: 'ok', scripts: { test: 'vitest', e2e: 'playwright test', build: 'tsc' } },
      undefined,
      null,
    );
    expect(res.kind).toBe('gates');
    if (res.kind !== 'gates') return;
    // Cheapest first, in PROBE_SCRIPTS order, and `build` is not a test script.
    expect(res.gates.map((g) => g.name)).toEqual(['test', 'e2e']);
    expect(res.gates.every((g) => g.required === false)).toBe(true);
  });

  it('blocks nothing-to-run when the repo defines no known test script', () => {
    const res = resolveUatGates({ kind: 'ok', scripts: { build: 'tsc' } }, undefined, null);
    expect(res).toMatchObject({ kind: 'unavailable', blocker: 'nothing-to-run' });
    if (res.kind !== 'unavailable') return;
    for (const script of PROBE_SCRIPTS) expect(res.reason).toContain(script);
  });

  it('blocks nothing-to-run when package.json is absent', () => {
    expect(resolveUatGates({ kind: 'absent' }, undefined, null)).toMatchObject({
      kind: 'unavailable',
      blocker: 'nothing-to-run',
    });
  });

  // A malformed package.json is a repository defect an agent can fix; a
  // permission error is environmental and an agent cannot chmod its way out.
  it('makes a malformed package.json a required, failing gate', () => {
    const res = resolveUatGates({ kind: 'malformed', message: 'Unexpected token' }, undefined, null);
    expect(res.kind).toBe('gates');
    if (res.kind !== 'gates') return;
    expect(res.gates).toEqual([]);
  });

  it('blocks capability-missing on an IO error', () => {
    expect(resolveUatGates({ kind: 'io-error', message: 'EACCES' }, undefined, null)).toMatchObject({
      kind: 'unavailable',
      blocker: 'capability-missing',
    });
  });

  it('prefers explicit gates over the probe and marks them required', () => {
    const res = resolveUatGates(
      { kind: 'ok', scripts: { test: 'vitest', e2e: 'playwright test' } },
      uat({ gates: [{ name: 'integration', kind: 'script', script: 'test:integration' }] }),
      null,
    );
    expect(res.kind).toBe('gates');
    if (res.kind !== 'gates') return;
    expect(res.gates).toEqual([
      {
        name: 'integration',
        command: 'npm',
        args: ['run', 'test:integration'],
        script: 'test:integration',
        required: true,
      },
    ]);
  });

  it('renders a command gate as argv with no shell', () => {
    const res = resolveUatGates(
      { kind: 'ok', scripts: {} },
      uat({ gates: [{ name: 'gotest', kind: 'command', command: 'go', args: ['test', './...'] }] }),
      null,
    );
    expect(res.kind).toBe('gates');
    if (res.kind !== 'gates') return;
    expect(res.gates[0]).toEqual({
      name: 'gotest', command: 'go', args: ['test', './...'], script: null, required: true,
    });
  });

  it('keeps only the gates targeting this repository', () => {
    const config = uat({
      gates: [
        { name: 'test', kind: 'script', script: 'test' },
        { name: 'gotest', kind: 'command', command: 'go', args: ['test'], repo: 'api' },
      ],
    });
    const forWeb = resolveUatGates({ kind: 'ok', scripts: { test: 'v' } }, config, 'web');
    expect(forWeb.kind === 'gates' && forWeb.gates.map((g) => g.name)).toEqual(['test']);
    const forApi = resolveUatGates({ kind: 'ok', scripts: { test: 'v' } }, config, 'api');
    expect(forApi.kind === 'gates' && forApi.gates.map((g) => g.name)).toEqual(['test', 'gotest']);
  });

  // Standing amendment: repository ENTRIES may share a repoPath (a monorepo
  // with several runnable services), and a repo may need a wholly different
  // gate list than the global one — `uat.repositories.<name>.gates` is that
  // override, and it must win over the global `uat.gates` list for its repo,
  // not merely add a `repo:`-scoped entry to it.
  it('lets a per-repository gate override replace the global gate list for that repo only', () => {
    const config = uat({
      gates: [{ name: 'test', kind: 'script', script: 'test' }],
      repositories: {
        api: { gates: [{ name: 'gotest', kind: 'command', command: 'go', args: ['test'] }] },
      },
    });
    const forApi = resolveUatGates({ kind: 'ok', scripts: { test: 'v' } }, config, 'api');
    expect(forApi.kind === 'gates' && forApi.gates.map((g) => g.name)).toEqual(['gotest']);
    // The override is per-repo: an unrelated repo keeps the global list.
    const forWeb = resolveUatGates({ kind: 'ok', scripts: { test: 'v' } }, config, 'web');
    expect(forWeb.kind === 'gates' && forWeb.gates.map((g) => g.name)).toEqual(['test']);
  });

  // Defect found in the brief's pasted implementation: it checked `probe.kind
  // === 'io-error'` BEFORE looking at declared gates, so an unreadable
  // package.json blocked a repo even when its uat.gates never needed to read
  // one (e.g. all `kind: 'command'` gates). That contradicts this task's own
  // opening line: "Explicit uat.gates always wins". Fixed by resolving
  // declared gates first and only consulting the probe when none apply.
  it('lets explicit gates win over an unreadable package.json', () => {
    const res = resolveUatGates(
      { kind: 'io-error', message: 'EACCES' },
      uat({ gates: [{ name: 'gotest', kind: 'command', command: 'go', args: ['test'] }] }),
      null,
    );
    expect(res.kind).toBe('gates');
    if (res.kind !== 'gates') return;
    expect(res.gates.map((g) => g.name)).toEqual(['gotest']);
  });

  it('lets explicit gates win over a malformed package.json', () => {
    const res = resolveUatGates(
      { kind: 'malformed', message: 'Unexpected token' },
      uat({ gates: [{ name: 'gotest', kind: 'command', command: 'go', args: ['test'] }] }),
      null,
    );
    expect(res.kind).toBe('gates');
    if (res.kind !== 'gates') return;
    expect(res.gates.map((g) => g.name)).toEqual(['gotest']);
  });
});

describe('runUatGates', () => {
  const now = () => '2026-07-30T10:00:00.000Z';

  it('runs every gate — no short-circuit on the first failure', async () => {
    const out = await runUatGates(
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
    const out = await runUatGates(
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
    const started = runUatGates(
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
    const started = runUatGates(
      [
        { name: 'fast', command: 'node', args: ['-e', 'process.exit(0)'], script: null, required: true },
        { name: 'slow', command: 'node', args: ['-e', 'setTimeout(()=>{},60000)'], script: null, required: true },
      ],
      process.cwd(),
      {
        signal: controller.signal,
        now,
        // Abort right after the first gate's result is recorded, before the
        // loop reaches the second (slow) gate's spawn.
      },
    );
    // Give the first gate time to complete and be pushed to `results`, then
    // abort so the second gate's runProcess call observes it.
    setTimeout(() => controller.abort(), 200);
    const out = await started;
    expect(out.kind).toBe('stopped');
    if (out.kind !== 'stopped') return;
    expect(out.results).toEqual([
      expect.objectContaining({ name: 'fast', exitCode: 0 }),
    ]);
  });

  it('fails a configured gate whose script the repo does not define', async () => {
    const out = await runUatGates(
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
    const out = await runUatGates(
      [{ name: 'test', command: 'node', args: ['-e', 'process.exit(0)'], script: 'test', required: true }],
      process.cwd(),
      { now },
    );
    if (out.kind !== 'ran') throw new Error('expected ran');
    expect(out.results[0]).toMatchObject({ exitCode: 0 });
  });
});
