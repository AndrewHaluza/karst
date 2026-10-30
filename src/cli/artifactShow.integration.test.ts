import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createArtifactStore } from '../artifacts/store.js';
import { openStore, type Store } from '../store/db.js';
import { createTicket } from '../store/tickets.js';
import { recordAlignmentOutcome } from '../workflow/artifacts/alignmentRecord.js';
import type { AlignmentOutcome } from '../workflow/artifacts/alignmentTrigger.js';
import { parseArtifactShowArgs, runArtifactShowCommand } from './artifactShow.js';

let tmp: string;
let registry: Store;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'art-show-'));
  registry = openStore(':memory:');
});
afterEach(() => {
  registry.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe('parseArtifactShowArgs', () => {
  it('takes exactly one path', () => {
    expect(parseArtifactShowArgs(['artifact', 'show', '_karst/alignment/intent-spec.md'])).toEqual({
      path: '_karst/alignment/intent-spec.md',
    });
    expect(() => parseArtifactShowArgs(['artifact', 'show'])).toThrow(/path/);
    expect(() => parseArtifactShowArgs(['artifact', 'show', 'x', 'y'])).toThrow(/unexpected/);
    expect(() => parseArtifactShowArgs(['artifact', 'show', '--kind'])).toThrow(/path/);
  });
});

describe('runArtifactShowCommand', () => {
  it('reads back the newest committed alignment report and errors on an unknown path', async () => {
    const ticket = createTicket(registry, { key: 'T-1', title: 't', projectId: 4 });
    const dbPath = join(tmp, 'karst.db');
    const store = createArtifactStore({ artifactsRoot: join(tmp, 'artifacts'), projectId: 4 });
    const base = { ticketId: ticket.id, edge: 'intent-spec', findings: [], parentFp: 'I', childFp: 'S', failed: false } satisfies Omit<AlignmentOutcome, 'report'>;
    const post = { postMessage: () => undefined };
    await recordAlignmentOutcome({ store, ...post }, { ...base, report: 'OLD report' });
    await recordAlignmentOutcome({ store, ...post }, { ...base, report: 'NEW report' });

    const argv = ['artifact', 'show', '_karst/alignment/intent-spec.md'];
    expect(await runArtifactShowCommand(registry, ticket.id, dbPath, argv)).toBe('NEW report');
    await expect(
      runArtifactShowCommand(registry, ticket.id, dbPath, ['artifact', 'show', 'nope/missing.md']),
    ).rejects.toThrow(/no artifact 'nope\/missing.md'/);
  });
});
