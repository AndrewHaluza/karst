import { describe, expect, it } from 'vitest';
import { openStore } from '../store/db.js';
import type { ClaimEvidenceDeps } from '../approaches/graph/integration/claimEvidence.js';
import { createGraphClaimEvidence } from './graphClaimEvidenceBinding.js';

describe('createGraphClaimEvidence', () => {
  it('logs a throw and resolves, so the settle still runs', async () => {
    const errors: unknown[] = [];
    const evidence = createGraphClaimEvidence(
      () => {
        throw new Error('store is busy');
      },
      (message, error) => errors.push([message, String(error)]),
    );
    await expect(evidence(4)).resolves.toBeUndefined();
    expect(errors).toEqual([['karst: graph claim evidence failed for run 4', 'Error: store is busy']]);
  });

  it('logs a throw of the evidence step itself', async () => {
    const store = openStore(':memory:');
    const db = store.db;
    store.close();
    const errors: string[] = [];
    await createGraphClaimEvidence(() => ({ db }) as unknown as ClaimEvidenceDeps, (message) => errors.push(message))(4);
    expect(errors).toEqual(['karst: graph claim evidence failed for run 4']);
  });

  it('does nothing while the host is not wired', async () => {
    const errors: string[] = [];
    await createGraphClaimEvidence(() => undefined, (message) => errors.push(message))(4);
    expect(errors).toEqual([]);
  });
});
