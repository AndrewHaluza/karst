import { describe, it, expect } from 'vitest';
import { runGateList } from './runList.js';

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
