import { describe, expect, it } from 'vitest';
import { checkForgottenRemoteWorkspaces, checkSandboxOrphans } from './sandboxOrphanCheck.js';

describe('checkSandboxOrphans', () => {
  it('none → no checks', () => expect(checkSandboxOrphans([])).toEqual([]));
  it('one warn per orphan, report-only', () => {
    expect(checkSandboxOrphans([{ name: 'karst-ab12cd34-9-claude', ticketId: 9 }])).toEqual([{
      id: 'state.sandbox-orphan.karst-ab12cd34-9-claude', area: 'state', status: 'warn',
      detail: 'sandbox karst-ab12cd34-9-claude belongs to ticket 9, which is not live',
      fix: { tier: 'report', summary: 'orphan sandbox', nextStep: 'run "Karst: Clean Up Orphan Sandboxes" and confirm (unsynced commits in it are lost)' },
    }]);
  });
  it('an ssh orphan names its remote so two remotes never look alike (D824)', () => {
    expect(checkSandboxOrphans([{ name: 'karst-ab12cd34-9-claude', ticketId: 9, remote: 'devbox' }])[0]!.detail)
      .toBe('sandbox karst-ab12cd34-9-claude on devbox belongs to ticket 9, which is not live');
  });
});

describe('checkForgottenRemoteWorkspaces', () => {
  it('none → no checks', () => expect(checkForgottenRemoteWorkspaces([])).toEqual([]));
  it('one warn per forgotten workspace that points to its Delete, never to the orphan cleanup (D830)', () => {
    expect(checkForgottenRemoteWorkspaces([{ name: 'karst-ab12cd34-9-claude', ticketId: 9, remote: 'devbox' }])).toEqual([{
      id: 'state.sandbox-stray.devbox.karst-ab12cd34-9-claude', area: 'state', status: 'warn',
      detail: 'forgotten remote workspace karst-ab12cd34-9-claude on devbox (ticket 9)',
      fix: { tier: 'report', summary: 'forgotten remote workspace', nextStep: 'delete it from the ticket (the orphan cleanup never removes it)' },
    }]);
  });
});
