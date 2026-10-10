import { describe, expect, it } from 'vitest';

import { sweepArtifactRetention } from './retention.js';

const noop = { debug: () => {}, logError: () => {} };

describe('sweepArtifactRetention', () => {
  it('does nothing when maxAgeDays is unset (keep forever)', async () => {
    expect(await sweepArtifactRetention({ globalStorageRoot: '/nonexistent', projectId: 1, manifest: undefined, ...noop })).toEqual([]);
  });

  it('tolerates a missing store root', async () => {
    expect(await sweepArtifactRetention({ globalStorageRoot: '/nonexistent', projectId: 1, manifest: { artifacts: { maxAgeDays: 5 } }, ...noop })).toEqual([]);
  });
});
