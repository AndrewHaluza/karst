import { describe, it, expect } from 'vitest';
import type { GateDef, Manifest } from '../../../../manifest/types.js';
import {
  addRepoOverride,
  evidenceErrors,
  removeRepoOverride,
  setProbeWhenAllDisabled,
  updateGates,
  updateTesterObservations,
  updateUat,
} from './qualityDraft.js';

const EVIDENCE = { file: '.karst/uat-scratch/out/**/summary.json', whenChanged: ['src/**'] };
const TESTER = { blockingSeverity: 'none', onSkip: 'reask', requireEvidence: EVIDENCE };
const GATE: GateDef = { name: 'unit', command: 'npm test' } as GateDef;

const draftOf = (uat?: object): Manifest => ({ uat }) as unknown as Manifest;
const testerOf = (draft: Manifest): unknown =>
  (draft.uat as { testerObservations?: unknown } | undefined)?.testerObservations;

describe('the tester block survives every UAT write that does not name it', () => {
  const draft = draftOf({ maxFixAttempts: 3, gates: [GATE], testerObservations: TESTER });

  it('keeps the block on a maxFixAttempts edit', () => {
    expect(testerOf(updateUat(draft, { maxFixAttempts: 5 }))).toEqual(TESTER);
  });

  it('keeps the block on a gate edit', () => {
    expect(testerOf(updateGates(draft, 'uat', (gates) => [...gates, { ...GATE, name: 'lint' }]))).toEqual(TESTER);
  });

  it('keeps the block when a repository override is added and removed', () => {
    const added = addRepoOverride(draft, 'uat', 'api', [GATE]);
    expect(testerOf(added)).toEqual(TESTER);
    expect(testerOf(removeRepoOverride(added, 'uat', 'api'))).toEqual(TESTER);
  });

  it('keeps the block when the probe flag changes', () => {
    expect(testerOf(setProbeWhenAllDisabled(draft, 'uat', true))).toEqual(TESTER);
  });

  it('removes the block only for an explicit testerObservations: undefined', () => {
    const next = updateUat(draft, { testerObservations: undefined });
    expect(next.uat).not.toHaveProperty('testerObservations');
    expect(next.uat).toMatchObject({ maxFixAttempts: 3 });
  });
});

describe('updateTesterObservations', () => {
  it('patches one key and keeps its siblings', () => {
    const next = updateTesterObservations(draftOf({ testerObservations: TESTER }), { blockingSeverity: 'high' });
    expect(testerOf(next)).toEqual({ ...TESTER, blockingSeverity: 'high' });
  });

  it('reads the block from the draft it gets, so two quick edits both land', () => {
    const first = updateTesterObservations(draftOf({ testerObservations: { blockingSeverity: 'none' } }), {
      onSkip: 'reask',
    });
    const second = updateTesterObservations(first, { blockingSeverity: 'low' });
    expect(testerOf(second)).toEqual({ blockingSeverity: 'low', onSkip: 'reask' });
  });

  it('deletes a key patched to undefined', () => {
    const next = updateTesterObservations(draftOf({ testerObservations: TESTER }), { requireEvidence: undefined });
    expect(testerOf(next)).toEqual({ blockingSeverity: 'none', onSkip: 'reask' });
  });

  it('fills the default severity when the block is absent', () => {
    expect(testerOf(updateTesterObservations(draftOf(), { onSkip: 'reask' }))).toEqual({
      blockingSeverity: 'none',
      onSkip: 'reask',
    });
  });
});

describe('evidenceErrors mirrors validate/uat.ts', () => {
  it('accepts a valid rule', () => {
    expect(evidenceErrors(EVIDENCE)).toEqual({});
  });

  it('flags an empty file and an empty list', () => {
    expect(evidenceErrors({ file: ' ', whenChanged: [] })).toEqual({
      file: 'Enter a glob for the evidence file.',
      whenChanged: 'Enter at least one glob.',
    });
  });

  it('flags absolute and parent paths', () => {
    expect(evidenceErrors({ file: '/tmp/x.json', whenChanged: ['src/**', '../other/**'] })).toEqual({
      file: 'Use a repo-relative glob: no leading "/" and no ".." segment.',
      whenChanged: 'Use repo-relative globs: no leading "/" and no ".." segment.',
    });
  });
});
