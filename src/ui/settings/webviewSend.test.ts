/**
 * The settings webview's type-checked message constructors (NDL-39).
 *
 * Proves each named sender posts the exact object the host's
 * `parseSettingsMessage` expects, and that the host union is closed (the
 * `@ts-expect-error` cases fail typecheck if the contract ever loosens).
 */
import { describe, it, expect } from 'vitest';
import { createSender } from './webviewSend.js';
import type { SettingsWebviewMessage } from './messages.js';
import type { Manifest } from '../../manifest/types.js';

const manifest = {} as unknown as Manifest;

function harness() {
  const posted: unknown[] = [];
  const sender = createSender({ postMessage: (m) => posted.push(m) });
  return { posted, sender };
}

describe('settings webviewSend', () => {
  it('posts the exact expected message for each sender', () => {
    const { posted, sender } = harness();

    sender.save(manifest, 'agents', 'r1');
    expect(posted.at(-1)).toEqual({ type: 'save', manifest, section: 'agents', requestId: 'r1' });

    sender.validate(manifest);
    expect(posted.at(-1)).toEqual({ type: 'validate', manifest });

    sender.validateProcessAssignments(manifest);
    expect(posted.at(-1)).toEqual({ type: 'validate-process-assignments', manifest });

    sender.installApproach('tdd');
    expect(posted.at(-1)).toEqual({ type: 'install-approach', id: 'tdd' });
    sender.uninstallApproach('tdd');
    expect(posted.at(-1)).toEqual({ type: 'uninstall-approach', id: 'tdd' });

    sender.setToken();
    expect(posted.at(-1)).toEqual({ type: 'set-token' });
    sender.clearToken();
    expect(posted.at(-1)).toEqual({ type: 'clear-token' });

    sender.setApproachEnabled('tdd', true, 'r2');
    expect(posted.at(-1)).toEqual({
      type: 'set-approach-enabled',
      id: 'tdd',
      enabled: true,
      requestId: 'r2',
    });
    sender.setAgentEnabled('tester', false);
    expect(posted.at(-1)).toEqual({ type: 'set-agent-enabled', name: 'tester', enabled: false });

    sender.saveAgentFile('tester', '# body');
    expect(posted.at(-1)).toEqual({ type: 'save-agent-file', name: 'tester', body: '# body' });
    sender.createAgent('tester');
    expect(posted.at(-1)).toEqual({ type: 'create-agent', name: 'tester' });
    sender.deleteAgent('tester');
    expect(posted.at(-1)).toEqual({ type: 'delete-agent', name: 'tester' });

    sender.requestState();
    expect(posted.at(-1)).toEqual({ type: 'request-state' });

    sender.getApproachCommandBody('tdd', 'run');
    expect(posted.at(-1)).toEqual({
      type: 'get-approach-command-body',
      approachId: 'tdd',
      command: 'run',
    });

    sender.fetchTicketStatuses('list-1', 'team-1');
    expect(posted.at(-1)).toEqual({
      type: 'fetch-ticket-statuses',
      listId: 'list-1',
      teamId: 'team-1',
    });
    sender.fetchTicketLists('team-1', 'r3');
    expect(posted.at(-1)).toEqual({ type: 'fetch-ticket-lists', teamId: 'team-1', requestId: 'r3' });

    sender.browseRepoPath('api');
    expect(posted.at(-1)).toEqual({ type: 'browse-repo-path', name: 'api' });
    sender.openManifest();
    expect(posted.at(-1)).toEqual({ type: 'open-manifest' });
    sender.openGraphPrompt('karst-graph-planner');
    expect(posted.at(-1)).toEqual({
      type: 'open-graph-prompt',
      identity: 'karst-graph-planner',
    });

    expect(posted).toHaveLength(19);
  });

  it('rejects a wrong argument type at compile time', () => {
    const { sender } = harness();
    // @ts-expect-error `enabled` is a boolean, never a string.
    sender.setApproachEnabled('tdd', 'yes');
  });
});

/**
 * The settings host union is closed — each `@ts-expect-error` must keep
 * failing typecheck.
 */
function hostUnionIsClosed(): void {
  const ok: SettingsWebviewMessage = { type: 'request-state' };
  void ok;

  // @ts-expect-error typo'd field name (ID, not id)
  const typo: SettingsWebviewMessage = { type: 'install-approach', ID: 'tdd' };
  void typo;

  // @ts-expect-error extra field not in the contract
  const extra: SettingsWebviewMessage = { type: 'request-state', manifest: {} };
  void extra;

  // @ts-expect-error unknown message type
  const unknown: SettingsWebviewMessage = { type: 'not-a-real-action' };
  void unknown;

  // @ts-expect-error missing required field (id)
  const missing: SettingsWebviewMessage = { type: 'install-approach' };
  void missing;
}
void hostUnionIsClosed;
