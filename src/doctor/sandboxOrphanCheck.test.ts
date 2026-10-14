import { describe, expect, it } from 'vitest';
import { checkSandboxOrphans } from './sandboxOrphanCheck.js';

describe('checkSandboxOrphans', () => {
  it('none → no checks', () => expect(checkSandboxOrphans([])).toEqual([]));
  it('one warn per orphan, report-only', () => {
    expect(checkSandboxOrphans([{ name: 'karst-ab12cd34-9-claude', ticketId: 9 }])).toEqual([{
      id: 'state.sandbox-orphan.karst-ab12cd34-9-claude', area: 'state', status: 'warn',
      detail: 'sandbox karst-ab12cd34-9-claude belongs to ticket 9, which is not live',
      fix: { tier: 'report', summary: 'orphan sandbox', nextStep: 'run "Karst: Clean Up Orphan Sandboxes" and confirm (unsynced commits in it are lost)' },
    }]);
  });
});
