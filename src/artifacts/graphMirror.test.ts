import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openStore, type Store } from '../store/db.js';
import { createTicketFlow } from '../workflow/stages/create.js';
import { mirrorGraphArtifacts } from './graphMirror.js';
import type { RevisionInput } from './store.js';

describe('mirrorGraphArtifacts', () => {
  let store: Store;
  let ticketId: number;
  beforeEach(() => {
    store = openStore(':memory:');
    ticketId = createTicketFlow(store, { key: 'T-1', title: 't' }).id;
    store.db
      .prepare(
        `INSERT INTO approach_graph_runs (id, ticket_id, stage_key, stage_attempt, approach_id, status, created_at)
         VALUES (1, ?, 'impl', 0, 'gsd', 'running', 'now')`,
      )
      .run(ticketId);
    const ins = store.db.prepare(
      `INSERT INTO approach_artifact_instances
         (graph_run_id, artifact_id, snapshot_path, sha256, media_type, byte_size, sensitivity, created_at)
       VALUES (1, ?, ?, 'x', 'text/markdown', 1, ?, 'now')`,
    );
    ins.run('plan', '/snap/plan.md', null);
    ins.run('secrets', '/snap/secrets.md', 'credentials');
  });
  afterEach(() => store.close());

  it('commits public instances with source=graph and skips sensitive ones', async () => {
    const commits: RevisionInput[] = [];
    const artifacts = { commitRevision: async (i: RevisionInput) => (commits.push(i), 'sha') };
    const res = await mirrorGraphArtifacts({ store, artifacts, debug: () => {} }, ticketId);
    expect(res).toEqual({ committed: 1, skippedSensitive: 1 });
    expect(commits).toHaveLength(1);
    expect(commits[0]).toMatchObject({
      repo: 'graph',
      relPath: 'run-1/plan',
      sourcePath: '/snap/plan.md',
      trailers: { source: 'graph', approach: 'gsd' },
    });
  });

  it('keeps going when one commit throws', async () => {
    const artifacts = { commitRevision: async () => { throw new Error('x'); } };
    const res = await mirrorGraphArtifacts({ store, artifacts, debug: () => {} }, ticketId);
    expect(res.committed).toBe(0);
  });
});
