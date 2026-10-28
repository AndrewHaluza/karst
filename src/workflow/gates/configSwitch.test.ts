import { describe, expect, it } from 'vitest';
import { applyConfigSwitch } from './disable.js';
import { declaredReviewGatesFor, resolveReviewGates } from '../review/gates.js';
import { declaredGatesFor } from '../uat/gates.js';
import { resolveTargetGates } from '../stages/uat.js';
import { review, uat } from '../../manifest/fixtures.js';
import { gateRevision } from '../../manifest/gateRevision.js';
import { validateGate } from '../../manifest/validate/uat.js';
import { validateReview } from '../../manifest/validate/review.js';
import { assertReferencesResolve } from '../../manifest/validate/semantics.js';
import type { Manifest } from '../../manifest/types.js';
import type { ScriptProbe } from './probe.js';

const g = (name: string, enabled?: boolean) => ({
  name,
  kind: 'script' as const,
  script: name,
  ...(enabled === undefined ? {} : { enabled }),
});
const probe: ScriptProbe = { kind: 'ok', scripts: { test: 'x', e2e: 'y' } };

describe('applyConfigSwitch', () => {
  it('cuts only the disabled names', () => {
    expect(applyConfigSwitch([g('a'), g('b', false)], false).disabledNames).toEqual(['b']);
  });
  it('all off + no probe flag: keep declared, cut every name (bypass)', () => {
    const r = applyConfigSwitch([g('a', false)], undefined);
    expect(r.declared).toHaveLength(1);
    expect(r.disabledNames).toEqual(['a']);
  });
  it('all off + probe flag: resolve as an empty list', () => {
    expect(applyConfigSwitch([g('a', false)], true)).toEqual({ declared: [], disabledNames: [] });
  });
  it('probe flag is inert while one gate is on', () => {
    expect(applyConfigSwitch([g('a'), g('b', false)], true).disabledNames).toEqual(['b']);
  });
});

describe('stage resolution with config-off gates', () => {
  it('uat: config-off gate becomes a skipped row', () => {
    const r = resolveTargetGates(probe, uat({ gates: [g('test'), g('e2e', false)] }), []);
    expect(r).toMatchObject({ kind: 'gates', gates: [{ name: 'test' }], skipped: [{ name: 'e2e' }] });
  });
  it('uat: all off runs nothing, all skipped', () => {
    const r = resolveTargetGates(probe, uat({ gates: [g('test', false)] }), []);
    expect(r).toMatchObject({ kind: 'gates', gates: [], skipped: [{ name: 'test' }] });
  });
  it('uat: all off + probe runs the probed scripts', () => {
    const r = resolveTargetGates(probe, uat({ gates: [g('x', false)], probeWhenAllDisabled: true }), []);
    expect(r).toMatchObject({ kind: 'gates', gates: [{ name: 'test' }, { name: 'e2e' }], skipped: [] });
  });
  it('review: all off runs nothing; all off + probe probes', () => {
    const cfg = review({ gates: [g('lint', false)] });
    expect(resolveReviewGates(probe, cfg, [])).toMatchObject({ gates: [], skipped: [{ name: 'lint' }] });
    const probing = review({ gates: [g('lint', false)], probeWhenAllDisabled: true });
    expect(resolveReviewGates({ kind: 'ok', scripts: { lint: 'l' } }, probing, [])).toMatchObject({
      gates: [{ name: 'lint' }],
      skipped: [],
    });
  });
  it('an all-off override still replaces the global list', () => {
    const off = [g('only', false)];
    expect(declaredGatesFor(uat({ gates: [g('a')], repositories: { api: { gates: off } } }), 'api')).toEqual(off);
    expect(
      declaredReviewGatesFor(review({ gates: [g('a')], repositories: { api: { gates: off } } }), 'api'),
    ).toEqual(off);
  });
});

describe('config-off is judged per repository entry', () => {
  const cfg = uat({
    gates: [
      { ...g('test', false), repo: 'a' },
      { ...g('test'), repo: 'b' },
    ],
  });
  it('a gate off for one entry still runs for another in the same worktree', () => {
    expect(resolveTargetGates(probe, cfg, ['a', 'b'])).toMatchObject({
      gates: [{ name: 'test' }],
      skipped: [],
    });
  });
  it('off for the only entry stays skipped', () => {
    expect(resolveTargetGates(probe, cfg, ['a'])).toMatchObject({ gates: [], skipped: [{ name: 'test' }] });
  });
});

describe('manifest surface', () => {
  it('validateGate accepts a boolean enabled and rejects others', () => {
    expect(validateGate({ name: 'a', kind: 'script', script: 'a', enabled: false }, 0, 'uat.gates').enabled).toBe(false);
    expect(() => validateGate({ name: 'a', kind: 'script', script: 'a', enabled: 'no' }, 0, 'uat.gates')).toThrow(/enabled/);
  });
  it('rejects a non-boolean review.probeWhenAllDisabled', () => {
    expect(() => validateReview({ probeWhenAllDisabled: 'yes' }, [])).toThrow(/probeWhenAllDisabled/);
  });
  it('gateRevision moves when a gate is toggled', () => {
    const base = (enabled?: boolean) =>
      ({ repositories: {}, uat: uat({ gates: [g('a', enabled)] }) }) as unknown as Manifest;
    expect(gateRevision(base())).not.toBe(gateRevision(base(false)));
  });
  it('semantics: all review gates off + requireIndependentSignal + no probe is a problem', () => {
    const m = (extra: object) =>
      ({ repositories: {}, review: review({ gates: [g('lint', false)], requireIndependentSignal: true, ...extra }) }) as unknown as Manifest;
    expect(() => assertReferencesResolve(m({}), false)).toThrow(/every gate is disabled \(lint\)/);
    expect(() => assertReferencesResolve(m({ probeWhenAllDisabled: true }), false)).not.toThrow();
  });
});
