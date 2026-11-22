/**
 * Error attribution + local validation counts (SET-4, SET-5, SET-6, SET-12).
 *
 * Pure selectors: no React, no DOM. They run in plain node because everything
 * here has to be usable from both the reducer and the component render pass.
 */
import { describe, expect, it } from 'vitest';
import type { Manifest } from '../../../manifest/types.js';
import {
  applyQuotaPatch,
  fieldFaultFor,
  firstSectionWithLocalError,
  hasInlineFieldFault,
  localFieldErrors,
  manifestFaultDetail,
  sectionForError,
} from './diagnostics.js';

const manifest = (partial: Record<string, unknown>): Manifest =>
  partial as unknown as Manifest;

describe('manifestFaultDetail (SET-5)', () => {
  it('strips both file prefixes, with and without a path suffix', () => {
    expect(manifestFaultDetail('Invalid karst.yml: host must be a non-empty string')).toBe(
      'host must be a non-empty string',
    );
    expect(manifestFaultDetail('karst.yml: repositories[1] is not a mapping')).toBe(
      'repositories[1] is not a mapping',
    );
    expect(manifestFaultDetail('Invalid karst.yml (/repo/karst.yml): portRange min exceeds max')).toBe(
      'portRange min exceeds max',
    );
    expect(manifestFaultDetail(null)).toBe('');
  });

  it('routes a load-time repositories fault to Repositories (SET-5)', () => {
    expect(sectionForError('karst.yml: repositories[1] is not a mapping')).toBe('services');
  });
});

describe('inline field faults (SET-6)', () => {
  it('recognises the autopilot fields on the Autopilot tab only', () => {
    const fault = 'Invalid karst.yml: autopilot.conflicts.maxRounds must be a whole number of at least 1';
    expect(fieldFaultFor(fault, 'autopilot.conflicts.maxRounds')).toBe(
      'Enter a whole number of at least 1.',
    );
    expect(hasInlineFieldFault(fault, 'autopilot')).toBe(true);
    expect(hasInlineFieldFault(fault, 'general')).toBe(false);
  });

  it('does not hide a banner for a field the tab does not render', () => {
    const fault = 'Invalid karst.yml: conventions.branchName must include {slug}';
    expect(hasInlineFieldFault(fault, 'autopilot')).toBe(false);
    expect(hasInlineFieldFault(null, 'autopilot')).toBe(false);
  });
});

describe('localFieldErrors (SET-4 + SET-12)', () => {
  it('reports nothing for a defaulted manifest', () => {
    expect(localFieldErrors(manifest({}))).toEqual({});
  });

  it('counts each invalid stall field on Quality', () => {
    const draft = manifest({
      review: { stallDetection: { enabled: true, sameFileRounds: 0, repeatedFindingRounds: 0 } },
    });
    expect(localFieldErrors(draft)).toEqual({ quality: 2 });
  });

  it('counts the tester evidence fields when the rule is on', () => {
    const draft = manifest({
      uat: {
        testerObservations: {
          requireEvidence: { file: '/absolute/**', whenChanged: [] },
        },
      },
    });
    expect(localFieldErrors(draft)).toEqual({ quality: 2 });
  });

  it('ignores a disabled stall rule', () => {
    const draft = manifest({
      review: { stallDetection: { enabled: false, sameFileRounds: 0, repeatedFindingRounds: 0 } },
    });
    expect(localFieldErrors(draft)).toEqual({});
  });

  it('returns the first nav section that has errors', () => {
    expect(firstSectionWithLocalError({ quality: 1 }, ['general', 'quality'])).toBe('quality');
    expect(firstSectionWithLocalError({}, ['general', 'quality'])).toBeNull();
  });
});

describe('applyQuotaPatch (Q4-SAVE)', () => {
  it('sets a key, deletes on null and drops an emptied block', () => {
    const base = manifest({ host: 'localhost', quota: { warnThresholdPct: 70 } });
    expect(applyQuotaPatch(base, { claudeOauthUsageApi: true }).quota).toEqual({
      warnThresholdPct: 70,
      claudeOauthUsageApi: true,
    });
    // Deleting the only key leaves no block at all.
    expect(applyQuotaPatch(base, { warnThresholdPct: null }).quota).toBeUndefined();
    expect(applyQuotaPatch(manifest({ host: 'localhost' }), { warnThresholdPct: 90 }).quota).toEqual({
      warnThresholdPct: 90,
    });
    // A patch never names an unrelated key; it only merges over what is there.
    expect(applyQuotaPatch(base, { claudeGlobalStatusline: true }).quota).toEqual({
      warnThresholdPct: 70,
      claudeGlobalStatusline: true,
    });
  });
});
