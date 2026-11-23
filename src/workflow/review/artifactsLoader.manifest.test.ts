import { describe, expect, it } from 'vitest';
import { makeReviewArtifactsLoader } from './artifactsLoader.js';

const base = { intentOf: () => 'I', checksOf: () => new Set<never>(), storeFor: () => null };

describe('review artifacts loader — manifest', () => {
  it('works without a manifest seam', async () => {
    const a = await makeReviewArtifactsLoader(base)(1);
    expect(a?.intent).toBe('I');
    expect(a).not.toHaveProperty('operatorManifest');
  });
  it('drops an unchanged manifest', async () => {
    const a = await makeReviewArtifactsLoader({ ...base, manifestOf: () => ({ path: 'p', content: 'c', changed: false }) })(1);
    expect(a).not.toHaveProperty('operatorManifest');
  });
  it('is undefined with nothing to show and no changed manifest', async () => {
    const l = makeReviewArtifactsLoader({ ...base, intentOf: () => null, manifestOf: () => ({ path: 'p', content: 'c', changed: false }) });
    expect(await l(1)).toBeUndefined();
  });
  it('carries the no-change claim, even with no intent', async () => {
    const claim = { reason: 'r', items: ['[high] t'] };
    const l = makeReviewArtifactsLoader({ ...base, intentOf: () => null, noChangeClaimOf: () => claim });
    expect((await l(1))?.noChangeClaim).toEqual(claim);
    expect(await makeReviewArtifactsLoader({ ...base, noChangeClaimOf: () => null })(1)).not.toHaveProperty('noChangeClaim');
  });
});
