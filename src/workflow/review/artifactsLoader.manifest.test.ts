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
});
