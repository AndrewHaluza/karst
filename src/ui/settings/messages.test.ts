import { describe, it, expect, vi } from 'vitest';
import { parseSettingsMessage, routeSettingsAction, type SettingsActions } from './messages.js';

const draft = { host: 'x', portRange: [1, 2], baselineBranch: 'b', services: {} };

describe('parseSettingsMessage', () => {
  it('accepts save/validate with an object manifest', () => {
    expect(parseSettingsMessage({ type: 'save', manifest: draft })).toEqual({
      type: 'save', manifest: draft,
    });
    expect(parseSettingsMessage({ type: 'validate', manifest: draft })).toEqual({
      type: 'validate', manifest: draft,
    });
  });

  it('carries a valid save section through', () => {
    expect(parseSettingsMessage({ type: 'save', manifest: draft, section: 'git' })).toEqual({
      type: 'save', manifest: draft, section: 'git',
    });
  });

  it('rejects a save whose section is not a known tab', () => {
    // Dropped, never downgraded to a whole-manifest save: a bad section name must
    // not widen the write back to every tab.
    expect(parseSettingsMessage({ type: 'save', manifest: draft, section: 'nope' })).toBeNull();
    expect(parseSettingsMessage({ type: 'save', manifest: draft, section: 'constructor' })).toBeNull();
    expect(parseSettingsMessage({ type: 'save', manifest: draft, section: 7 })).toBeNull();
  });

  it('accepts request-state', () => {
    expect(parseSettingsMessage({ type: 'request-state' })).toEqual({ type: 'request-state' });
  });

  it('accepts install-approach / uninstall-approach with non-empty string id', () => {
    expect(parseSettingsMessage({ type: 'install-approach', id: 'my-approach' })).toEqual({
      type: 'install-approach', id: 'my-approach',
    });
    expect(parseSettingsMessage({ type: 'uninstall-approach', id: 'my-approach' })).toEqual({
      type: 'uninstall-approach', id: 'my-approach',
    });
  });

  it('rejects save/validate without an object manifest', () => {
    expect(parseSettingsMessage({ type: 'save' })).toBeNull();
    expect(parseSettingsMessage({ type: 'save', manifest: 'nope' })).toBeNull();
    expect(parseSettingsMessage({ type: 'validate', manifest: null })).toBeNull();
  });

  it('rejects install-approach / uninstall-approach with missing or empty id', () => {
    expect(parseSettingsMessage({ type: 'install-approach' })).toBeNull();
    expect(parseSettingsMessage({ type: 'install-approach', id: '' })).toBeNull();
    expect(parseSettingsMessage({ type: 'install-approach', id: 123 })).toBeNull();
    expect(parseSettingsMessage({ type: 'uninstall-approach' })).toBeNull();
    expect(parseSettingsMessage({ type: 'uninstall-approach', id: '' })).toBeNull();
    expect(parseSettingsMessage({ type: 'uninstall-approach', id: null })).toBeNull();
  });

  it('accepts set-token / clear-token (no payload)', () => {
    expect(parseSettingsMessage({ type: 'set-token' })).toEqual({ type: 'set-token' });
    expect(parseSettingsMessage({ type: 'clear-token' })).toEqual({ type: 'clear-token' });
  });

  it('accepts set-approach-enabled / set-agent-enabled with non-empty id/name + boolean enabled', () => {
    expect(parseSettingsMessage({ type: 'set-approach-enabled', id: 'a', enabled: false })).toEqual({
      type: 'set-approach-enabled', id: 'a', enabled: false,
    });
    expect(parseSettingsMessage({ type: 'set-agent-enabled', name: 'reviewer', enabled: true })).toEqual({
      type: 'set-agent-enabled', name: 'reviewer', enabled: true,
    });
  });

  it('rejects set-approach-enabled / set-agent-enabled with missing/empty id-name or non-boolean enabled', () => {
    expect(parseSettingsMessage({ type: 'set-approach-enabled', id: '', enabled: false })).toBeNull();
    expect(parseSettingsMessage({ type: 'set-approach-enabled', id: 'a', enabled: 'false' })).toBeNull();
    expect(parseSettingsMessage({ type: 'set-approach-enabled', enabled: false })).toBeNull();
    expect(parseSettingsMessage({ type: 'set-agent-enabled', name: '', enabled: true })).toBeNull();
    expect(parseSettingsMessage({ type: 'set-agent-enabled', name: 'x', enabled: 1 })).toBeNull();
  });

  it('accepts save-agent-file with non-empty name + string body (may be empty)', () => {
    expect(parseSettingsMessage({ type: 'save-agent-file', name: 'r', body: '# body' })).toEqual({
      type: 'save-agent-file', name: 'r', body: '# body',
    });
    expect(parseSettingsMessage({ type: 'save-agent-file', name: 'r', body: '' })).toEqual({
      type: 'save-agent-file', name: 'r', body: '',
    });
  });

  it('rejects save-agent-file with missing/empty name or non-string body', () => {
    expect(parseSettingsMessage({ type: 'save-agent-file', name: '', body: 'x' })).toBeNull();
    expect(parseSettingsMessage({ type: 'save-agent-file', name: 'r', body: 42 })).toBeNull();
    expect(parseSettingsMessage({ type: 'save-agent-file', body: 'x' })).toBeNull();
  });

  it('accepts / rejects create-agent and delete-agent by name', () => {
    expect(parseSettingsMessage({ type: 'create-agent', name: 'r' })).toEqual({
      type: 'create-agent', name: 'r',
    });
    expect(parseSettingsMessage({ type: 'delete-agent', name: 'r' })).toEqual({
      type: 'delete-agent', name: 'r',
    });
    expect(parseSettingsMessage({ type: 'create-agent', name: '' })).toBeNull();
    expect(parseSettingsMessage({ type: 'delete-agent' })).toBeNull();
  });

  it('rejects unknown / malformed shapes', () => {
    expect(parseSettingsMessage(null)).toBeNull();
    expect(parseSettingsMessage({ type: 'bogus' })).toBeNull();
    expect(parseSettingsMessage(42)).toBeNull();
  });

  it('parses get-approach-command-body', () => {
    expect(parseSettingsMessage({ type: 'get-approach-command-body', approachId: 'rpi', command: '/karst:rpi' }))
      .toEqual({ type: 'get-approach-command-body', approachId: 'rpi', command: '/karst:rpi' });
  });

  it('drops get-approach-command-body with a missing field', () => {
    expect(parseSettingsMessage({ type: 'get-approach-command-body', approachId: 'rpi' })).toBeNull();
  });
});

describe('browse-repo-path', () => {
  it('parses with a name', () => {
    expect(parseSettingsMessage({ type: 'browse-repo-path', name: 'backend' })).toEqual({
      type: 'browse-repo-path',
      name: 'backend',
    });
  });

  it('rejects a missing/blank name', () => {
    expect(parseSettingsMessage({ type: 'browse-repo-path' })).toBeNull();
    expect(parseSettingsMessage({ type: 'browse-repo-path', name: '' })).toBeNull();
  });

  it('parses open-manifest', () => {
    expect(parseSettingsMessage({ type: 'open-manifest' })).toEqual({ type: 'open-manifest' });
  });

  it('parses validate-process-assignments with a manifest', () => {
    expect(
      parseSettingsMessage({ type: 'validate-process-assignments', manifest: { host: 'x' } }),
    ).toEqual({ type: 'validate-process-assignments', manifest: { host: 'x' } });
  });

  it('rejects validate-process-assignments without a manifest', () => {
    expect(parseSettingsMessage({ type: 'validate-process-assignments' })).toBeNull();
    expect(parseSettingsMessage({ type: 'validate-process-assignments', manifest: null })).toBeNull();
  });
});

describe('routeSettingsAction', () => {
  function spies(): SettingsActions & { calls: Record<string, unknown[]> } {
    const calls: Record<string, unknown[]> = {
      browseRepoPath: [],
      openManifest: [],
      save: [],
      validate: [],
      validateProcessAssignments: [],
      requestState: [],
      installApproach: [],
      uninstallApproach: [],
      setToken: [],
      clearToken: [],
      setApproachEnabled: [],
      setAgentEnabled: [],
      saveAgentFile: [],
      createAgent: [],
      deleteAgent: [],
      getApproachCommandBody: [],
      fetchTicketStatuses: [],
      fetchTicketLists: [],
    };
    return {
      calls,
      save: (m, section) => { calls['save']!.push({ manifest: m, section }); },
      validate: (m) => { calls['validate']!.push(m); },
      validateProcessAssignments: (m) => { calls['validateProcessAssignments']!.push(m); },
      requestState: () => { calls['requestState']!.push(true); },
      installApproach: (id) => { calls['installApproach']!.push(id); },
      uninstallApproach: (id) => { calls['uninstallApproach']!.push(id); },
      setToken: () => { calls['setToken']!.push(true); },
      clearToken: () => { calls['clearToken']!.push(true); },
      setApproachEnabled: (id, enabled) => { calls['setApproachEnabled']!.push({ id, enabled }); },
      setAgentEnabled: (name, enabled) => { calls['setAgentEnabled']!.push({ name, enabled }); },
      saveAgentFile: (name, body) => { calls['saveAgentFile']!.push({ name, body }); },
      createAgent: (name) => { calls['createAgent']!.push(name); },
      deleteAgent: (name) => { calls['deleteAgent']!.push(name); },
      getApproachCommandBody: (approachId, command) => { calls['getApproachCommandBody']!.push({ approachId, command }); },
      fetchTicketStatuses: (listId, teamId) => { calls['fetchTicketStatuses']!.push({ listId, teamId }); },
      fetchTicketLists: (teamId) => { calls['fetchTicketLists']!.push(teamId); },
      browseRepoPath: (name) => { calls['browseRepoPath']!.push(name); },
      openManifest: () => { calls['openManifest']!.push(true); },
    };
  }

  it('routes a section-scoped save with its section', () => {
    const a = spies();
    routeSettingsAction({ type: 'save', manifest: draft, section: 'services' }, a);
    expect(a.calls.save).toEqual([{ manifest: draft, section: 'services' }]);
  });

  it('routes each valid message to its action', () => {
    const a = spies();
    routeSettingsAction({ type: 'save', manifest: draft }, a);
    routeSettingsAction({ type: 'validate', manifest: draft }, a);
    routeSettingsAction({ type: 'validate-process-assignments', manifest: draft }, a);
    routeSettingsAction({ type: 'request-state' }, a);
    routeSettingsAction({ type: 'install-approach', id: 'my-id' }, a);
    routeSettingsAction({ type: 'uninstall-approach', id: 'my-id' }, a);
    routeSettingsAction({ type: 'set-token' }, a);
    routeSettingsAction({ type: 'clear-token' }, a);
    routeSettingsAction({ type: 'set-approach-enabled', id: 'a', enabled: false }, a);
    routeSettingsAction({ type: 'set-agent-enabled', name: 'reviewer', enabled: false }, a);
    routeSettingsAction({ type: 'save-agent-file', name: 'r', body: '# body' }, a);
    routeSettingsAction({ type: 'create-agent', name: 'r' }, a);
    routeSettingsAction({ type: 'delete-agent', name: 'r' }, a);
    routeSettingsAction({ type: 'get-approach-command-body', approachId: 'rpi', command: '/rpi:research' }, a);
    routeSettingsAction({ type: 'browse-repo-path', name: 'backend' }, a);
    routeSettingsAction({ type: 'open-manifest' }, a);
    expect(a.calls.save).toEqual([{ manifest: draft, section: undefined }]);
    expect(a.calls.validate).toEqual([draft]);
    expect(a.calls.validateProcessAssignments).toEqual([draft]);
    expect(a.calls.requestState).toEqual([true]);
    expect(a.calls.installApproach).toEqual(['my-id']);
    expect(a.calls.uninstallApproach).toEqual(['my-id']);
    expect(a.calls.setToken).toEqual([true]);
    expect(a.calls.clearToken).toEqual([true]);
    expect(a.calls.setApproachEnabled).toEqual([{ id: 'a', enabled: false }]);
    expect(a.calls.setAgentEnabled).toEqual([{ name: 'reviewer', enabled: false }]);
    expect(a.calls.saveAgentFile).toEqual([{ name: 'r', body: '# body' }]);
    expect(a.calls.createAgent).toEqual(['r']);
    expect(a.calls.deleteAgent).toEqual(['r']);
    expect(a.calls.getApproachCommandBody).toEqual([{ approachId: 'rpi', command: '/rpi:research' }]);
    expect(a.calls.browseRepoPath).toEqual(['backend']);
    expect(a.calls.openManifest).toEqual([true]);
  });

  it('ignores malformed messages (no throw, no action)', () => {
    const a = spies();
    expect(() => routeSettingsAction({ type: 'bogus' }, a)).not.toThrow();
    expect(a.calls.save).toEqual([]);
    expect(a.calls.installApproach).toEqual([]);
  });

  it('returns undefined without dispatching for an unparsed message (UI-R13)', () => {
    const a = spies();
    expect(routeSettingsAction({ type: 'bogus' }, a)).toBeUndefined();
  });

  it('returns the matched action’s return value so a caller can await it', async () => {
    const a: SettingsActions = {
      ...spies(),
      requestState: () => Promise.resolve(),
    };
    const returned = routeSettingsAction({ type: 'request-state' }, a);
    expect(returned).toBeInstanceOf(Promise);
    await returned;
  });
});

describe('fetch-ticket-statuses', () => {
  it('parses a message with a listId', () => {
    expect(parseSettingsMessage({ type: 'fetch-ticket-statuses', listId: '42' })).toEqual({
      type: 'fetch-ticket-statuses',
      listId: '42',
    });
  });

  it('carries an optional teamId', () => {
    expect(
      parseSettingsMessage({ type: 'fetch-ticket-statuses', listId: '42', teamId: '9001' }),
    ).toEqual({ type: 'fetch-ticket-statuses', listId: '42', teamId: '9001' });
  });

  it('drops a message with a missing or blank listId', () => {
    expect(parseSettingsMessage({ type: 'fetch-ticket-statuses' })).toBeNull();
    expect(parseSettingsMessage({ type: 'fetch-ticket-statuses', listId: '' })).toBeNull();
  });

  it('drops a message with a non-string teamId', () => {
    expect(
      parseSettingsMessage({ type: 'fetch-ticket-statuses', listId: '42', teamId: 9001 }),
    ).toBeNull();
  });

  it('routes to fetchTicketStatuses', () => {
    const calls: { listId: string; teamId?: string }[] = [];
    const actions = {
      fetchTicketStatuses: (listId: string, teamId?: string) => calls.push({ listId, teamId }),
    } as unknown as SettingsActions;

    routeSettingsAction(
      { type: 'fetch-ticket-statuses', listId: '42', teamId: '9001' },
      actions,
    );

    expect(calls).toEqual([{ listId: '42', teamId: '9001' }]);
  });
});

describe('fetch-ticket-lists', () => {
  it('parses a message with a teamId', () => {
    expect(parseSettingsMessage({ type: 'fetch-ticket-lists', teamId: '9001' })).toEqual({
      type: 'fetch-ticket-lists', teamId: '9001',
    });
  });
  it('drops a missing/blank teamId', () => {
    expect(parseSettingsMessage({ type: 'fetch-ticket-lists' })).toBeNull();
    expect(parseSettingsMessage({ type: 'fetch-ticket-lists', teamId: '' })).toBeNull();
  });
  it('routes to fetchTicketLists', () => {
    const calls: string[] = [];
    const actions = { fetchTicketLists: (t: string) => calls.push(t) } as unknown as SettingsActions;
    routeSettingsAction({ type: 'fetch-ticket-lists', teamId: '9001' }, actions);
    expect(calls).toEqual(['9001']);
  });
});
