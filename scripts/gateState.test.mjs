import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { BASELINE_READERS, classifyPath, firstPassEnabled, isCleanRun, planScope, planSkip, scopeLine, stateKey, touchesUi } from './gateState.mjs';
import { ALWAYS_RUN, alwaysFiles } from './gateAlways.mjs';
import { scopedArgs } from './vitestGate.mjs';

const GOOD = { version: 1, tree: 'a'.repeat(40), base: 'b1', clean: true, failed: [] };
const plan = (over = {}) => planScope({ state: GOOD, readable: true, base: 'b1', delta: [{ status: 'M', path: 'src/a.ts' }], ...over });

describe('classifyPath', () => {
  it.each([
    ['src/a.ts', 'code'],
    ['src/ui/x.tsx', 'code'],
    ['src/a.test.ts', 'code'],
    ['docs/arch/x.md', 'docs'],
  ])('%s -> %s', (path, kind) => expect(classifyPath(path).kind).toBe(kind));

  it.each([
    'package-lock.json',
    'package.json',
    'npm-shrinkwrap.json',
    'yarn.lock',
    'pnpm-lock.yaml',
    'tsconfig.json',
    'tsconfig.build.json',
    'vitest.config.ts',
    'vitest.integration.config.ts',
    'scripts/vitest-global-setup.mjs',
    'scripts/other.mjs',
    'tests/visual/x.ts',
    'src/data/fixture.json',
    'src/ui/x.css',
    'README.md',
  ])('%s forces a full run', (path) => expect(classifyPath(path).kind).toBe('full'));
});

const PNG = 'tests/visual/__baselines__/dark/usage--loading.png';

describe('baseline PNG', () => {
  it('classifies a baseline PNG as the readers', () => expect(classifyPath(PNG)).toEqual({ kind: 'readers', files: BASELINE_READERS }));
  it('keeps a non-PNG under the baseline directory full', () => expect(classifyPath('tests/visual/__baselines__/x.json').kind).toBe('full'));
  it('scopes a PNG-only delta to the two readers', () => {
    expect(plan({ delta: [{ status: 'M', path: PNG }] })).toMatchObject({ kind: 'scoped', paths: BASELINE_READERS });
  });
  it('scopes a deleted or renamed PNG to the readers', () => {
    expect(plan({ delta: [{ status: 'D', path: PNG }] })).toMatchObject({ kind: 'scoped', paths: BASELINE_READERS });
  });
  it('adds the readers to the code files, once', () => {
    const r = plan({ delta: [{ status: 'A', path: PNG }, { status: 'M', path: 'src/a.ts' }, { status: 'A', path: 'tests/visual/__baselines__/light/b.png' }] });
    expect(r.paths).toEqual([...BASELINE_READERS, 'src/a.ts']);
  });
  it('stays full for a PNG plus package.json', () => {
    expect(plan({ delta: [{ status: 'M', path: PNG }, { status: 'M', path: 'package.json' }] }).kind).toBe('full');
  });
  it('stays full for a PNG plus tests/visual/foo.ts', () => {
    expect(plan({ delta: [{ status: 'M', path: PNG }, { status: 'M', path: 'tests/visual/foo.ts' }] }).reason).toContain('outside src and docs');
  });
  it('stays full when a non-baseline file is deleted next to a PNG', () => {
    expect(plan({ delta: [{ status: 'M', path: PNG }, { status: 'D', path: 'src/a.ts' }] }).reason).toContain('deleted or renamed');
  });
  it.each(BASELINE_READERS)('reader %s exists', (file) => expect(existsSync(file)).toBe(true));
});

describe('planScope', () => {
  it('scopes a delta of code files and carries the stored failed files', () => {
    const r = plan({ state: { ...GOOD, failed: ['src/old.test.ts'] } });
    expect(r).toEqual({ kind: 'scoped', paths: ['src/a.ts'], failed: ['src/old.test.ts'], since: GOOD.tree });
  });
  it('selects no path for a docs-only delta', () => {
    expect(plan({ delta: [{ status: 'M', path: 'docs/x.md' }] })).toMatchObject({ kind: 'scoped', paths: [], failed: [] });
  });
  it('runs full with KARST_GATE_FULL=1', () => expect(plan({ force: true })).toEqual({ kind: 'full', reason: 'KARST_GATE_FULL=1' }));
  it('runs full without state', () => expect(plan({ state: null }).reason).toContain('no earlier run'));
  it('runs full when the state is unreadable', () => expect(plan({ state: null, readable: false }).reason).toBe('earlier run state is unreadable'));
  it('runs full when the state is flagged unreadable with a state value', () => expect(plan({ readable: false }).reason).toContain('unreadable'));
  it('runs full when the earlier run was not clean', () => expect(plan({ state: { ...GOOD, clean: false } }).reason).toContain('killed, hung'));
  it('runs full when the merge base moved', () => expect(plan({ base: 'b2' }).reason).toContain('merge base moved'));
  it('runs full when there is no merge base', () => expect(plan({ base: null }).reason).toContain('merge base moved'));
  it('runs full when the comparison failed', () => expect(plan({ delta: null }).reason).toContain('could not compare'));
  it('runs full when a file was deleted or renamed', () => {
    expect(plan({ delta: [{ status: 'D', path: 'src/a.ts' }] }).reason).toContain('deleted or renamed');
  });
  it.each(['package-lock.json', 'package.json', 'tsconfig.json', 'vitest.config.ts', 'scripts/vitest-setup-env.mjs', 'scripts/x.mjs', 'src/f.json'])(
    'runs full when %s changed',
    (path) => expect(plan({ delta: [{ status: 'M', path }] }).kind).toBe('full'),
  );
  it('keeps a full verdict even when other paths are code', () => {
    expect(plan({ delta: [{ status: 'M', path: 'src/a.ts' }, { status: 'M', path: 'package.json' }] }).kind).toBe('full');
  });
});

describe('planScope first pass', () => {
  const first = (over = {}) => planScope({ state: null, readable: true, base: 'm'.repeat(40), delta: [{ status: 'M', path: 'src/a.ts' }], firstPass: true, ...over });
  it('scopes a code-only branch diff since the merge base', () =>
    expect(first()).toEqual({ kind: 'scoped', paths: ['src/a.ts'], failed: [], since: 'm'.repeat(40), branchDiff: true }));
  it('selects no test for a docs-only branch diff', () => expect(first({ delta: [{ status: 'M', path: 'docs/x.md' }] })).toMatchObject({ kind: 'scoped', paths: [], branchDiff: true }));
  it('runs full without the opt-in', () => expect(first({ firstPass: false }).reason).toBe('no earlier run'));
  it('runs full when a file was deleted', () => expect(first({ delta: [{ status: 'D', path: 'src/a.ts' }] }).reason).toBe('src/a.ts was deleted or renamed'));
  it('runs full for a full trigger', () => expect(first({ delta: [{ status: 'M', path: 'package.json' }] }).reason).toContain('package.json changed'));
  it('runs full on an empty branch diff', () => expect(first({ delta: [] }).reason).toBe('the branch diff is empty'));
  it('runs full without a merge base', () => expect(first({ base: null }).reason).toBe('no merge base for the branch diff'));
  it('runs full when the comparison failed', () => expect(first({ delta: null }).reason).toContain('could not compare'));
  it('runs full when the state is unreadable, even with the opt-in', () => expect(first({ readable: false }).reason).toBe('earlier run state is unreadable'));
  it('KARST_GATE_FULL=1 beats the opt-in', () => expect(first({ force: true }).reason).toBe('KARST_GATE_FULL=1'));
  it('prints the branch diff scope line', () =>
    expect(scopeLine('test:unit', { kind: 'scoped', count: 2, since: 'a'.repeat(40), branchDiff: true })).toBe(`test:unit: 2 files, branch diff since ${'a'.repeat(12)}`));
});

describe('firstPassEnabled', () => {
  it('is on only for the branch-diff value', () => {
    expect(firstPassEnabled({ KARST_GATE_FIRST_PASS: 'branch-diff' })).toBe(true);
    expect(firstPassEnabled({})).toBe(false);
    expect(firstPassEnabled({ KARST_GATE_FIRST_PASS: '1' })).toBe(false);
  });
  it('is off on GitHub Actions', () => expect(firstPassEnabled({ KARST_GATE_FIRST_PASS: 'branch-diff', GITHUB_ACTIONS: 'true' })).toBe(false));
  it('is off on a base-moved merged tree', () => expect(firstPassEnabled({ KARST_GATE_FIRST_PASS: 'branch-diff', KARST_MERGED_BASE_SHA: 'abc' })).toBe(false));
});

describe('ALWAYS_RUN', () => {
  const entries = Object.entries(ALWAYS_RUN).flatMap(([config, sets]) => Object.values(sets).flatMap((files) => files.map((f) => [config, f])));
  it.each(entries)('%s lists an existing file %s', (_c, file) => {
    expect(existsSync(file)).toBe(true);
  });
  const unit = ['npx', 'vitest', 'run'];
  const integration = [...unit, '--config', 'vitest.integration.config.ts'];
  it('adds the scanners for a code diff outside src/ui', () => {
    expect(alwaysFiles(unit, ['src/a.ts'])).toEqual(ALWAYS_RUN.unit.any);
    expect(alwaysFiles(integration, ['src/a.ts'])).toEqual(ALWAYS_RUN.integration.any);
  });
  it('adds the bundle readers too when the diff holds src/ui', () => {
    expect(alwaysFiles(unit, ['src/ui/a.tsx'])).toEqual([...ALWAYS_RUN.unit.any, ...ALWAYS_RUN.unit.ui]);
    expect(alwaysFiles(integration, ['src/ui/a.tsx'])).toEqual(ALWAYS_RUN.integration.ui);
  });
  it('adds nothing for a docs-only diff', () => expect(alwaysFiles(unit, [])).toEqual([]));
});

describe('isCleanRun', () => {
  it('is clean for a pass', () => expect(isCleanRun({ status: 0 })).toBe(true));
  it('is clean for parsed failures', () => expect(isCleanRun({ status: 1, parsedAllFailures: true })).toBe(true));
  it.each([
    ['hung', { status: 1, hung: true }],
    ['signaled', { status: 1, signaled: true }],
    ['137', { status: 137 }],
    ['127', { status: 127 }],
    ['unparsed', { status: 1, parsedAllFailures: false }],
  ])('is not clean when %s', (_n, run) => expect(isCleanRun(run)).toBe(false));
});

describe('scopeLine and stateKey', () => {
  it('prints the three forms', () => {
    expect(scopeLine('test:unit', { kind: 'full', reason: 'no earlier run' })).toBe('full: no earlier run');
    expect(scopeLine('test:unit', { kind: 'scoped', count: 3, since: 'a'.repeat(40) })).toBe(`test:unit: 3 files, delta since ${'a'.repeat(12)}`);
    expect(scopeLine('test:visual:docker', { kind: 'skipped', since: 'b'.repeat(40) })).toBe(`skipped: no UI change since ${'b'.repeat(12)}`);
  });
  it('keys differ per args', () => {
    expect(stateKey(['npx', 'vitest', 'run'])).not.toBe(stateKey(['npx', 'vitest', 'run', '--config', 'x']));
    expect(stateKey(['a'])).toBe(stateKey(['a']));
  });
  it('touchesUi asks the predicate', () => {
    expect(touchesUi([{ path: 'a' }, { path: 'b' }], (p) => p === 'b')).toBe(true);
    expect(touchesUi([{ path: 'a' }], () => false)).toBe(false);
  });
});

describe('scopedArgs', () => {
  it('swaps run for related and appends the files', () => {
    expect(scopedArgs(['npx', 'vitest', 'run', '--config', 'x.ts'], ['src/a.ts'])).toEqual(['npx', 'vitest', 'related', '--config', 'x.ts', '--run', '--passWithNoTests', 'src/a.ts']);
  });
  it('is null without a run command', () => expect(scopedArgs(['node', 'x.mjs'], ['a'])).toBeNull());
});

describe('planSkip', () => {
  const isUi = (p) => p.startsWith('src/ui/');
  const skip = (over = {}) => planSkip({ state: GOOD, readable: true, base: 'b1', delta: [{ status: 'M', path: 'docs/x.md' }], isUiPath: isUi, ...over });
  it('skips when the delta holds no UI path', () => expect(skip()).toEqual({ kind: 'skip', since: GOOD.tree }));
  it('skips on an empty delta', () => expect(skip({ delta: [] }).kind).toBe('skip'));
  it('runs when the delta holds a UI path', () => expect(skip({ delta: [{ status: 'M', path: 'src/ui/a.tsx' }] })).toMatchObject({ kind: 'run', delta: 1 }));
  it('runs when a UI file was deleted', () => expect(skip({ delta: [{ status: 'D', path: 'src/ui/a.tsx' }] }).kind).toBe('run'));
  const RED = { ...GOOD, failed: [{ project: 'dark', title: 'settings/default: full-page screenshot' }] };
  it('carries the delta paths and no failed test after a green run', () =>
    expect(skip({ delta: [{ status: 'M', path: 'src/ui/a.tsx' }, { status: 'M', path: 'docs/x.md' }] })).toEqual({
      kind: 'run', delta: 2, since: GOOD.tree, paths: ['src/ui/a.tsx', 'docs/x.md'], failed: [],
    }));
  it('runs the failed tests of a red run when the delta holds no UI path', () =>
    expect(skip({ state: RED })).toEqual({ kind: 'run', delta: 1, since: GOOD.tree, paths: ['docs/x.md'], failed: RED.failed }));
  it('runs a red run on an empty delta', () => expect(skip({ state: RED, delta: [] })).toMatchObject({ kind: 'run', paths: [], failed: RED.failed }));
  it('copies the failed tests', () => expect(skip({ state: RED }).failed[0]).not.toBe(RED.failed[0]));
  it.each([
    ['a file path', ['src/a.test.ts']],
    ['no title', [{ project: 'dark' }]],
    ['an empty project', [{ project: '', title: 't' }]],
    ['null', [null]],
  ])('reads a failed entry with %s as unreadable', (_, failed) => {
    expect(skip({ state: { ...GOOD, failed } })).toEqual({ kind: 'run', reason: 'earlier run state is unreadable' });
  });
  it.each([
    ['KARST_GATE_FULL=1', { force: true }],
    ['no earlier green run', { state: null }],
    ['unreadable', { state: null, readable: false }],
    ['unreadable', { readable: false }],
    ['not green', { state: { ...GOOD, clean: false } }],
    ['merge base moved', { base: 'b2' }],
    ['could not compare', { delta: null }],
  ])('runs for %s', (reason, over) => {
    const r = skip(over);
    expect(r.kind).toBe('run');
    expect(r.reason).toContain(reason === 'unreadable' ? 'unreadable' : reason);
  });
});
