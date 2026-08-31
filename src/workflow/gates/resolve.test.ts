import { describe, it, expect } from 'vitest';
import { resolveGates, type DeclaredGate } from './resolve.js';

// UAT's own list — used here only as one concrete `probeList` value. The point
// of these tests is that `resolveGates` treats it as data, not a constant it
// reaches for on its own; see the dedicated "probeList" tests below.
const PROBE_LIST: readonly string[] = [
  'test',
  'test:integration',
  'e2e',
  'test:e2e',
  'cypress',
  'playwright',
];

describe('resolveGates', () => {
  it('probes package.json when no gates are declared', () => {
    const res = resolveGates(
      { kind: 'ok', scripts: { test: 'vitest', e2e: 'playwright test', build: 'tsc' } },
      [],
      PROBE_LIST,
    );
    expect(res.kind).toBe('gates');
    if (res.kind !== 'gates') return;
    // Cheapest first, in probeList order, and `build` is not a test script.
    expect(res.gates.map((g) => g.name)).toEqual(['test', 'e2e']);
    expect(res.gates.every((g) => g.required === false)).toBe(true);
  });

  it('blocks nothing-to-run when the repo defines no known test script', () => {
    const res = resolveGates({ kind: 'ok', scripts: { build: 'tsc' } }, [], PROBE_LIST);
    expect(res).toMatchObject({ kind: 'unavailable', blocker: 'nothing-to-run' });
    if (res.kind !== 'unavailable') return;
    for (const script of PROBE_LIST) expect(res.reason).toContain(script);
  });

  it('blocks nothing-to-run when package.json is absent', () => {
    expect(resolveGates({ kind: 'absent' }, [], PROBE_LIST)).toMatchObject({
      kind: 'unavailable',
      blocker: 'nothing-to-run',
    });
  });

  // The escape hatch has always existed — a declared `kind: command` gate is
  // resolved before the probe is even read — but the blocker named only the
  // Node path, so a Python or Rust repo read "karst is Node-only" and reached
  // for a package.json-shaped shim script instead. The reason has to say what
  // to do next, and it must say it for BOTH probe outcomes: a repo with no
  // package.json at all is the common non-Node case.
  it('points a repo with no package.json at command gates', () => {
    const res = resolveGates({ kind: 'absent' }, [], PROBE_LIST);
    expect(res.kind).toBe('unavailable');
    if (res.kind !== 'unavailable') return;
    expect(res.reason).toContain('no package.json');
    expect(res.reason).toContain('kind: command');
    expect(res.reason).toContain('karst.yml');
  });

  it('points a Node repo missing the probed scripts at command gates too', () => {
    const res = resolveGates({ kind: 'ok', scripts: { build: 'tsc' } }, [], PROBE_LIST);
    expect(res.kind).toBe('unavailable');
    if (res.kind !== 'unavailable') return;
    expect(res.reason).toContain('kind: command');
  });

  // A malformed package.json is a repository defect an agent can fix; a
  // permission error is environmental and an agent cannot chmod its way out.
  it('makes a malformed package.json a required, failing gate', () => {
    const res = resolveGates({ kind: 'malformed', message: 'Unexpected token' }, [], PROBE_LIST);
    expect(res.kind).toBe('gates');
    if (res.kind !== 'gates') return;
    expect(res.gates).toEqual([]);
  });

  it('blocks capability-missing on an IO error', () => {
    expect(resolveGates({ kind: 'io-error', message: 'EACCES' }, [], PROBE_LIST)).toMatchObject({
      kind: 'unavailable',
      blocker: 'capability-missing',
    });
  });

  it('prefers explicit gates over the probe and marks them required', () => {
    const declared: DeclaredGate[] = [{ name: 'integration', kind: 'script', script: 'test:integration' }];
    const res = resolveGates(
      { kind: 'ok', scripts: { test: 'vitest', e2e: 'playwright test' } },
      declared,
      PROBE_LIST,
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
    const declared: DeclaredGate[] = [
      { name: 'gotest', kind: 'command', command: 'go', args: ['test', './...'] },
    ];
    const res = resolveGates({ kind: 'ok', scripts: {} }, declared, PROBE_LIST);
    expect(res.kind).toBe('gates');
    if (res.kind !== 'gates') return;
    expect(res.gates[0]).toEqual({
      name: 'gotest', command: 'go', args: ['test', './...'], script: null, required: true,
    });
  });

  // Defect found in the brief's pasted implementation: it checked `probe.kind
  // === 'io-error'` BEFORE looking at declared gates, so an unreadable
  // package.json blocked a repository even when its declared gates never needed
  // to read one (e.g. all `kind: 'command'` gates). That contradicts the rule
  // that explicit gates always win. Fixed by resolving declared gates first and
  // only consulting the probe when none apply.
  it('lets declared gates win over an unreadable package.json', () => {
    const declared: DeclaredGate[] = [{ name: 'gotest', kind: 'command', command: 'go', args: ['test'] }];
    const res = resolveGates({ kind: 'io-error', message: 'EACCES' }, declared, PROBE_LIST);
    expect(res.kind).toBe('gates');
    if (res.kind !== 'gates') return;
    expect(res.gates.map((g) => g.name)).toEqual(['gotest']);
  });

  it('lets declared gates win over a malformed package.json', () => {
    const declared: DeclaredGate[] = [{ name: 'gotest', kind: 'command', command: 'go', args: ['test'] }];
    const res = resolveGates({ kind: 'malformed', message: 'Unexpected token' }, declared, PROBE_LIST);
    expect(res.kind).toBe('gates');
    if (res.kind !== 'gates') return;
    expect(res.gates.map((g) => g.name)).toEqual(['gotest']);
  });

  // `probeList` used to be the module-level `PROBE_SCRIPTS` constant; it is now
  // a parameter, which is the whole point of this move — UAT passes its own
  // list, review passes a different one. These two tests exist only to prove
  // the value that reaches `resolveGates` is the one that matters.
  describe('probeList is a parameter, not a constant', () => {
    it('discovers scripts from the given probe list only', () => {
      const res = resolveGates(
        { kind: 'ok', scripts: { lint: 'eslint .', typecheck: 'tsc --noEmit', test: 'vitest' } },
        [],
        ['lint', 'typecheck'],
      );
      expect(res.kind).toBe('gates');
      if (res.kind !== 'gates') return;
      // `test` is a real script but absent from THIS probe list, so it is never
      // discovered — the point being demonstrated.
      expect(res.gates.map((g) => g.name)).toEqual(['lint', 'typecheck']);
    });

    it('blocks nothing-to-run on an empty probe list even when scripts exist', () => {
      const res = resolveGates({ kind: 'ok', scripts: { test: 'vitest' } }, [], []);
      expect(res).toMatchObject({ kind: 'unavailable', blocker: 'nothing-to-run' });
    });
  });
});
