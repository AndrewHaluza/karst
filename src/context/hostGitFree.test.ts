import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The extension-host event-loop invariant: a host path must never call the
 * BLOCKING `execFileSync`. This guards the two regressions T650 fixed — base-sha
 * resolution at planning ingest, and the drift probes inside `renderTicketContext`
 * — plus every other context/driver module the host renders through.
 *
 * `src/cli/context.ts` is deliberately NOT here: the CLI is a short-lived
 * process, so its synchronous drift runner (`computeDriftNotesSync`) is allowed.
 */
const HOST_MODULES = [
  'src/context/ticketContext.ts',
  'src/context/drift.ts',
  'src/extension.ts',
  'src/extension/ops/planningConstraintChecks.ts',
  'src/extension/ops/planningOutbox.ts',
  'src/approaches/graph/driver.ts',
];

describe('host context paths never call execFileSync', () => {
  it('none of the host modules import a synchronous child-process runner', () => {
    const offenders = HOST_MODULES.filter((rel) =>
      readFileSync(join(process.cwd(), rel), 'utf8').includes('execFileSync'),
    );
    expect(offenders).toEqual([]);
  });

  it('renderTicketContext does no git at all', () => {
    const source = readFileSync(join(process.cwd(), 'src', 'context', 'ticketContext.ts'), 'utf8');
    // No child-process import means the render cannot shell out — the drift
    // notes must arrive precomputed through `opts.driftNotes`.
    expect(source).not.toContain('child_process');
    expect(source).not.toMatch(/\bexecFile(Sync)?\b/);
  });
});
