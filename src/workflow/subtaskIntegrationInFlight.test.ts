import { describe, expect, it } from 'vitest';
import { openStore } from '../store/db.js';
import { upsertProject } from '../store/projects.js';
import { createTicket } from '../store/tickets.js';
import { integrateAndReleaseParent, isIntegrating } from './subtaskIntegration.js';
import type { GitRunner } from '../integrations/git.js';

describe('integration in flight', () => {
  it('marks the parent while integrateAndReleaseParent runs, and clears it after (even on failure)', async () => {
    const store = openStore(':memory:');
    try {
      const pid = upsertProject(store, { slug: 'p' }).id;
      const parent = createTicket(store, { key: 'P-1', title: 'p', projectId: pid }).id;
      const git = (async () => {
        throw new Error('git down');
      }) as unknown as GitRunner;
      expect(isIntegrating(parent)).toBe(false);
      const p = integrateAndReleaseParent(store, parent, git);
      expect(isIntegrating(parent)).toBe(true);
      await p;
      expect(isIntegrating(parent)).toBe(false);
    } finally {
      store.close();
    }
  });
});
