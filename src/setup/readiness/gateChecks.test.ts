import { describe, it, expect } from 'vitest';
import { checkGates } from './gateChecks.js';
import { fakeProbes } from './fakeProbes.testutil.js';
import type { GateDef, Manifest } from '../../manifest/types.js';

const manifest = (extra: Partial<Manifest>): Manifest =>
  ({
    host: '127.0.0.1',
    portRange: [3000, 3999],
    baselineBranch: 'main',
    repositories: { web: { repoPath: '/w/web', hasMigrations: false } },
    ...extra,
  }) as Manifest;
const review = (gates: GateDef[], requireIndependentSignal = true) =>
  ({ maxFixAttempts: 3, stallTimeoutMinutes: 10, requireIndependentSignal, gates, repositories: {} }) as never;
const uat = (gates: GateDef[], testerVerifier?: GateDef) =>
  ({ maxFixAttempts: 3, stallTimeoutMinutes: 10, gates, repositories: {}, testerVerifier }) as never;
const npmGate = (script: string): GateDef => ({ name: 'g', kind: 'command', command: 'npm', args: ['run', script] });
const main = () => 'main';
const ids = (items: { id: string; status: string }[]) => items.map((i) => `${i.id}:${i.status}`);

describe('checkGates', () => {
  it('review without gates and without package.json fails; with package.json ok', async () => {
    const m = manifest({ review: review([]) });
    expect(ids(await checkGates(m, main, fakeProbes({ fileExists: () => false })))).toContain('gates.review:fail');
    expect(ids(await checkGates(m, main, fakeProbes()))).toContain('gates.review:ok');
  });
  it('declared review gates are ok even without package.json', async () => {
    const m = manifest({ review: review([{ name: 'x', kind: 'command', command: 'make', args: ['test'] }]) });
    expect(ids(await checkGates(m, main, fakeProbes({ fileExists: () => false })))).toContain('gates.review:ok');
  });
  it('no review/uat block emits no gate items', async () => {
    expect(await checkGates(manifest({}), main, fakeProbes())).toEqual([]);
  });
  it('npm script missing on baseline fails with the script named; present passes', async () => {
    const m = manifest({ review: review([npmGate('test')]) });
    const bad = await checkGates(m, main, fakeProbes({ baseDefinesScript: async () => false }));
    const item = bad.find((i) => i.id === 'gates.script.review.gates[0]')!;
    expect(item.status).toBe('fail');
    expect(item.fix).toContain('"test"');
    const good = await checkGates(m, main, fakeProbes());
    expect(good.find((i) => i.id === 'gates.script.review.gates[0]')!.status).toBe('ok');
  });
  it('kind:script gates are checked by script name', async () => {
    const m = manifest({ uat: uat([{ name: 'e', kind: 'script', script: 'e2e' }]) });
    const seen: string[] = [];
    await checkGates(m, main, fakeProbes({ baseDefinesScript: async (_r, _b, s) => (seen.push(s), true) }));
    expect(seen).toEqual(['e2e']);
  });
  it('gate scoped to another repo is not checked against this one', async () => {
    const m = manifest({ review: review([{ ...npmGate('test'), repo: 'api' }]) });
    const items = await checkGates(m, main, fakeProbes({ baseDefinesScript: async () => false }));
    expect(items.some((i) => i.id.startsWith('gates.script.'))).toBe(false);
  });
  it('non-npm gate commands are not script-checked', async () => {
    const m = manifest({ review: review([{ name: 'x', kind: 'command', command: 'make', args: ['test'] }]) });
    const items = await checkGates(m, main, fakeProbes({ baseDefinesScript: async () => false }));
    expect(items.some((i) => i.id.startsWith('gates.script.'))).toBe(false);
  });
  it('uat declared but empty warns; with a tester it is ok', async () => {
    expect(ids(await checkGates(manifest({ uat: uat([]) }), main, fakeProbes()))).toContain('gates.uat:warn');
    const tv: GateDef = { name: 'tv', kind: 'command', command: 'playwright', args: [] };
    expect(ids(await checkGates(manifest({ uat: uat([], tv) }), main, fakeProbes()))).toContain('gates.uat:ok');
  });
  it('tester command: relative path must exist, bare binary must resolve', async () => {
    const rel: GateDef = { name: 'tv', kind: 'command', command: 'scripts/tv.sh', repo: 'web' };
    expect(ids(await checkGates(manifest({ uat: uat([], rel) }), main, fakeProbes({ fileExists: () => false })))).toContain('uat.tester:fail');
    expect(ids(await checkGates(manifest({ uat: uat([], rel) }), main, fakeProbes()))).toContain('uat.tester:ok');
    const bin: GateDef = { name: 'tv', kind: 'command', command: 'playwright', args: ['test'] };
    expect(ids(await checkGates(manifest({ uat: uat([], bin) }), main, fakeProbes({ binaryResolves: () => false })))).toContain('uat.tester:fail');
    expect(ids(await checkGates(manifest({ uat: uat([], bin) }), main, fakeProbes()))).toContain('uat.tester:ok');
  });
});
