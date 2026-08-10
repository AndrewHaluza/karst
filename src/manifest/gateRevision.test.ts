import { describe, it, expect } from 'vitest';
import { gateRevision } from './gateRevision.js';
import type { Manifest, UatGateDef } from './types.js';
import { manifest, repo, uat, review } from './fixtures.js';

/** A script gate, the shape both `uat.gates` and `review.gates` actually carry. */
const gate = (name: string): UatGateDef => ({ name, kind: 'script', script: name });

describe('gateRevision', () => {
  it('has no answer without a manifest, rather than a hash of nothing', () => {
    expect(gateRevision(undefined)).toBeNull();
  });

  it('is stable across property order, so two processes agree', () => {
    // The digest is compared between runs recorded by DIFFERENT extension-host
    // processes. Object key order in the loaded YAML is not something either
    // side controls, so an order-sensitive hash would report a gate-set change
    // on every restart.
    const a = manifest({ web: repo({ repoPath: '/web' }) }, { uat: uat({ gates: [gate('test')] }) });
    const b: Manifest = { ...a, uat: uat({ gates: [gate('test')] }) };
    expect(gateRevision(a)).toBe(gateRevision(b));
  });

  it('changes when a gate is removed — the question was deleted, not answered', () => {
    // RC5: `integration` failed, was commented out of karst.yml mid-session, and
    // the next attempt read as a clean pass with nothing marking that a failing
    // gate had been deleted rather than fixed.
    const before = manifest({}, { uat: uat({ gates: [gate('unit'), gate('integration')] }) });
    const after = manifest({}, { uat: uat({ gates: [gate('unit')] }) });
    expect(gateRevision(before)).not.toBe(gateRevision(after));
  });

  it('changes when review config changes', () => {
    const before = manifest({}, { review: review({ gates: [gate('lint')] }) });
    const after = manifest({}, { review: review({ gates: [gate('lint'), gate('build')] }) });
    expect(gateRevision(before)).not.toBe(gateRevision(after));
  });

  it('changes when a repository path changes, since that decides what a probe finds', () => {
    // A gate set is resolved from a package.json probe, so the directory probed
    // is as much an input as the declared list.
    const before = manifest({ web: repo({ repoPath: '/a' }) });
    const after = manifest({ web: repo({ repoPath: '/b' }) });
    expect(gateRevision(before)).not.toBe(gateRevision(after));
  });

  it('ignores manifest edits that cannot alter a gate set', () => {
    // A fingerprint that moved on every unrelated save would report "the gate
    // set changed" constantly, and a warning that fires constantly is one
    // nobody reads.
    const base = manifest({}, { uat: uat({ gates: [gate('test')] }) });
    expect(gateRevision({ ...base, defaultModel: 'sonnet' })).toBe(gateRevision(base));
  });

  it('ignores uat env/secrets/maxFixAttempts edits — run-time inputs, not questions', () => {
    // The whole `uat:` block used to be hashed, so rotating a secret or
    // changing `maxFixAttempts` between two attempts reported "the gate set
    // changed" — a false positive that turns the RC5 signal into noise. Only
    // the gate LISTS and repository paths decide the questions.
    const base = manifest({}, { uat: uat({ gates: [gate('test')] }) });
    const envTweak: Manifest = {
      ...base,
      uat: { ...base.uat!, env: { FOO: 'bar' }, secrets: ['s'], maxFixAttempts: 3 },
    };
    expect(gateRevision(envTweak)).toBe(gateRevision(base));
  });

  it('hashes a per-repository gate override, which REPLACES the global list', () => {
    const withGlobal = manifest({ web: repo({ repoPath: '/web' }) }, { uat: uat({ gates: [gate('test')] }) });
    const withOverride: Manifest = {
      ...withGlobal,
      uat: {
        ...withGlobal.uat!,
        repositories: { web: { gates: [gate('integration')] } },
      },
    };
    expect(gateRevision(withOverride)).not.toBe(gateRevision(withGlobal));
  });
});
