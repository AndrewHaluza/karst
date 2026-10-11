import { describe, it, expect } from 'vitest';
import { makeReviewArtifactsLoader } from './artifactsLoader.js';

type Rev = { sha: string; at: string; trailers: Record<string, string> };
function fakeStore(files: Record<string, { kind: string; text: string }>, reports: Rev[] = []) {
  return {
    listArtifacts: async () =>
      Object.keys(files).map((path) => ({ path, revisions: 1, latestSha: `sha-${path}` })),
    history: async (_t: number, path: string): Promise<Rev[]> =>
      path.startsWith('_karst/alignment/')
        ? reports
        : [{ sha: `sha-${path}`, at: '', trailers: { kind: files[path]!.kind } }],
    show: async (_t: number, _sha: string, path: string) => Buffer.from(files[path]!.text),
  };
}

describe('makeReviewArtifactsLoader', () => {
  it('returns undefined with no intent and no spec/plan', async () => {
    const load = makeReviewArtifactsLoader({
      intentOf: () => null,
      checksOf: () => new Set(),
      storeFor: () => fakeStore({ 'r/notes.md': { kind: 'research', text: 'x' } }),
    });
    expect(await load(1)).toBeUndefined();
  });
  it('loads intent + latest spec/plan, ignoring other kinds', async () => {
    const load = makeReviewArtifactsLoader({
      intentOf: () => '## Goal\ng',
      checksOf: () => new Set(),
      storeFor: () =>
        fakeStore({
          'r/docs/plan.md': { kind: 'plan', text: 'PLANBODY' },
          'r/notes.md': { kind: 'research', text: 'NOTES' },
        }),
    });
    const a = await load(1);
    expect(a?.intent).toBe('## Goal\ng');
    expect(a?.plan).toContain('PLANBODY');
    expect(a?.plan).toContain('r/docs/plan.md');
    expect(JSON.stringify(a)).not.toContain('NOTES');
  });
  it('intent only when the ticket has no artifact store', async () => {
    const load = makeReviewArtifactsLoader({ intentOf: () => 'I', checksOf: () => new Set(), storeFor: () => null });
    expect(await load(1)).toEqual({ intent: 'I', spec: null, plan: null });
  });
  it('drops the spec when the alignment report is clean for the current fingerprints and a plan exists', async () => {
    const files = {
      'r/spec.md': { kind: 'spec', text: 'SPEC' },
      'r/plan.md': { kind: 'plan', text: 'PLAN' },
    };
    const { intentFingerprint } = await import('../artifacts/chain.js');
    const report: Rev = {
      sha: 'x',
      at: '',
      trailers: { specfp: 'spec.md@sha-r/spec.md', intentfp: intentFingerprint('I'), mediumplus: '0' },
    };
    // relPath is stripped of the repo segment, so the spec fingerprint is `spec.md@<sha>`.
    const load = makeReviewArtifactsLoader({
      intentOf: () => 'I',
      checksOf: () => new Set(),
      storeFor: () => fakeStore(files, [report]),
    });
    const a = await load(1);
    expect(a?.spec).toBeNull();
    expect(a?.plan).toContain('PLAN');
  });
  it('keeps the spec without a report', async () => {
    const load = makeReviewArtifactsLoader({
      intentOf: () => 'I',
      checksOf: () => new Set(),
      storeFor: () =>
        fakeStore({ 'r/spec.md': { kind: 'spec', text: 'SPEC' }, 'r/plan.md': { kind: 'plan', text: 'PLAN' } }),
    });
    expect((await load(1))?.spec).toContain('SPEC');
  });
});
