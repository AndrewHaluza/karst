/**
 * Environment contract tests (Slice 3 Task 6).
 *
 * Host-owned values only; `KARST_GRAPH_RUN_ID`'s presence discriminates the
 * two `KARST_LAUNCH_ID` namespaces; a graph seed carries no marker
 * instruction and no `cliStagePrefix`; `terminalIdentity` re-identifies a
 * graph terminal unchanged; a manually opened terminal in a node workspace
 * is never adopted.
 */

import { describe, it, expect } from 'vitest';
import { buildGraphSessionEnv, graphRunIdFromEnv, isGraphSessionEnv } from './env.js';
import { composeNodePrompt } from '../executors/agent.js';
import { identifyTerminal } from '../../../ui/terminalIdentity.js';

const GRAPH_ENV = buildGraphSessionEnv({
  ticketId: 1,
  launchId: 11,
  graphRunId: 2,
  revisionId: 3,
  generation: 'gen-1',
  capability: 'cap',
  artifactRoot: '/root',
  callbackUrl: 'http://127.0.0.1:9/wakeup',
  dbPath: '/db/karst.db',
  projectId: 7,
});

describe('buildGraphSessionEnv', () => {
  it('sets host-owned values only, with KARST_GRAPH_RUN_ID as the discriminator', () => {
    expect(GRAPH_ENV).toEqual({
      KARST_TICKET_ID: '1',
      KARST_LAUNCH_ID: '11',
      KARST_GRAPH_RUN_ID: '2',
      KARST_GRAPH_REVISION_ID: '3',
      KARST_GRAPH_GENERATION: 'gen-1',
      KARST_GRAPH_CAPABILITY: 'cap',
      KARST_GRAPH_ARTIFACT_ROOT: '/root',
      KARST_GRAPH_CALLBACK_URL: 'http://127.0.0.1:9/wakeup',
      KARST_GRAPH_DB: '/db/karst.db',
      KARST_GRAPH_PROJECT: '7',
    });
    expect(isGraphSessionEnv(GRAPH_ENV)).toBe(true);
  });

  it('a planner session (no revision) omits KARST_GRAPH_REVISION_ID', () => {
    const env = buildGraphSessionEnv({
      ticketId: 1,
      launchId: 11,
      graphRunId: 2,
      revisionId: 0,
      generation: 'gen-1',
      capability: 'cap',
      artifactRoot: '/root',
      callbackUrl: 'http://127.0.0.1:9/wakeup',
      dbPath: '/db/karst.db',
      projectId: 7,
    });
    expect('KARST_GRAPH_REVISION_ID' in env).toBe(false);
    expect(env.KARST_GRAPH_RUN_ID).toBe('2');
  });

  it('graphRunIdFromEnv never falls through to the legacy namespace', () => {
    expect(graphRunIdFromEnv(GRAPH_ENV)).toBe(2);
    expect(graphRunIdFromEnv({ KARST_TICKET_ID: '1', KARST_LAUNCH_ID: '42' })).toBeUndefined();
    expect(graphRunIdFromEnv({ KARST_GRAPH_RUN_ID: '' })).toBeUndefined();
    expect(graphRunIdFromEnv({ KARST_GRAPH_RUN_ID: 'abc' })).toBeUndefined();
    expect(graphRunIdFromEnv(undefined)).toBeUndefined();
    expect(isGraphSessionEnv({})).toBe(false);
  });
});

describe('graph seed contract', () => {
  it('a graph node seed contains no done-marker instruction and no cliStagePrefix', () => {
    const seed = composeNodePrompt(
      '# karst-graph-node',
      '# ticket context',
      '# instructions',
      ['# input artifact'],
    );
    expect(seed).toContain('# karst-graph-node');
    expect(seed).toContain('# instructions');
    expect(seed).not.toMatch(/stage\s+(impl|fix)\s+pass/);
    expect(seed).not.toContain('stage impl pass');
    expect(seed).not.toContain('cliStagePrefix');
    // The graph environment itself carries no marker surface either.
    expect(Object.keys(GRAPH_ENV).some((k) => k.includes('STAGE') || k.includes('MARKER'))).toBe(false);
  });
});

describe('terminalIdentity unchanged', () => {
  it('re-identifies a graph terminal exactly like a legacy one', () => {
    const seenLookups: string[] = [];
    const identified = identifyTerminal(
      { pid: 4242, env: GRAPH_ENV },
      [{ pid: 4242, ticketId: 1, launchId: 'legacy-record' }],
      (launchId) => {
        seenLookups.push(launchId);
        return { ticketId: 1, provider: 'codex', model: 'gpt' };
      },
    );
    // KARST_TICKET_ID keeps its meaning; KARST_LAUNCH_ID rides opaquely as
    // the node-run id — the pid record's launchId is ignored when the env is
    // present (env wins), and the durable lookup is keyed on the launch id.
    expect(identified).toMatchObject({ ticketId: 1, launchId: '11' });
    expect(identified?.identity).toMatchObject({ provider: 'codex', model: 'gpt' });
    expect(seenLookups).toEqual(['11']);
  });

  it('a manually opened terminal in a node workspace is never adopted or counted', () => {
    // A manual terminal was never launched by karst, so this window holds no
    // pid record for it and it carries no KARST_LAUNCH_ID — without either
    // source of identity, adoption finds nothing.
    const identified = identifyTerminal({ pid: 9999, env: {} }, []);
    expect(identified).toBeUndefined();
    // A legacy karst terminal (env with the ticket) still resolves — the env
    // is the launch's own statement.
    expect(
      identifyTerminal({ pid: 9999, env: { KARST_TICKET_ID: '1' } }, []),
    ).toMatchObject({ ticketId: 1 });
  });
});
