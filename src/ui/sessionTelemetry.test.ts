import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  SessionManager,
  KARST_TICKET_ENV,
  KARST_LAUNCH_ENV,
  KARST_DB_ENV,
  KARST_PROVIDER_ENV,
  type SessionTerminal,
  type TerminalHost,
  type CreateTerminalOpts,
} from './session.js';
import type { AgentAdapter } from '../agent/adapter.js';

const adapter: AgentAdapter = {
  buildInteractiveCommand: () => ({ command: 'agent', args: [], env: {} }),
  runHeadless: () => Promise.reject(new Error('not used')),
  requiredBinary: 'agent',
  capabilities: { lifecycleEvents: true, resume: true },
};

function recordingHost(): { host: TerminalHost; opts: CreateTerminalOpts[] } {
  const opts: CreateTerminalOpts[] = [];
  const terminal: SessionTerminal = {
    show: () => {},
    sendText: () => {},
    dispose: () => {},
    onDidClose: () => {},
  };
  return {
    opts,
    host: {
      createTerminal: (o) => {
        opts.push(o);
        return terminal;
      },
      restoredSessions: () => [],
    },
  };
}

const launch = { dbPath: '/storage/karst.db', cliEntry: '/ext/dist/cli/main.js' };

const channelFor = () => ({
  endpointUrl: 'http://127.0.0.1:4567/hooks',
  configDir: '/runtime',
  launchId: 'fresh-launch',
});

describe('guide-attribution terminal env (Task 4)', () => {
  it('seeds KARST_DB and KARST_PROVIDER so a karst-guide pull is attributable', () => {
    const { host, opts } = recordingHost();
    const mgr = new SessionManager(host, channelFor);
    mgr.openSession(
      adapter,
      7,
      '/wt/a',
      undefined,
      'a composed seed',
      undefined,
      undefined,
      undefined,
      undefined,
      [],
      { dbPath: '/storage/karst.db', cliEntry: '/ext/cli.js' },
      { provider: 'claude', model: null },
    );
    expect(opts).toHaveLength(1);
    const env = opts[0]!.env;
    expect(env[KARST_TICKET_ENV]).toBe('7');
    expect(env[KARST_LAUNCH_ENV]).toBe('fresh-launch');
    expect(env[KARST_DB_ENV]).toBe('/storage/karst.db');
    expect(env[KARST_PROVIDER_ENV]).toBe('claude');
  });

  it('omits KARST_PROVIDER when no identity is supplied', () => {
    const { host, opts } = recordingHost();
    new SessionManager(host, channelFor).openSession(adapter, 7, '/wt/a', undefined, 'seed', undefined, undefined, undefined, undefined, [], launch);
    const env = opts[0]!.env;
    expect(env[KARST_TICKET_ENV]).toBe('7');
    expect(env[KARST_PROVIDER_ENV]).toBeUndefined();
  });

  it('exports KARST_CLI, KARST_DB, KARST_MANIFEST, KARST_TICKET when supplied; KARST_TICKET_ID unchanged', () => {
    const { host, opts } = recordingHost();
    new SessionManager(host, channelFor).openSession(adapter, 7, '/wt/a', undefined, 'seed', undefined, undefined, undefined, undefined, [], {
      ...launch,
      manifestPath: '/repo/karst.yml',
      ticketKey: 'NDL-7',
    });
    const env = opts[0]!.env;
    expect(env['KARST_CLI']).toBe('/ext/dist/cli/main.js');
    expect(env['KARST_DB']).toBe('/storage/karst.db');
    expect(env['KARST_MANIFEST']).toBe('/repo/karst.yml');
    expect(env['KARST_TICKET']).toBe('NDL-7');
    expect(env[KARST_TICKET_ENV]).toBe('7');
  });

  it.each([
    ['cliEntry', { dbPath: '/storage/karst.db' }],
    ['dbPath', { cliEntry: '/ext/dist/cli/main.js' }],
    ['both', {}],
  ])('missing %s → launch fails, no terminal', async (_what, options) => {
    const { host, opts } = recordingHost();
    const mgr = new SessionManager(host, channelFor);
    // `openSession` is async (its trust hook may await a contended lock), so a
    // pre-launch refusal surfaces as a rejection.
    await expect(
      mgr.openSession(adapter, 7, '/wt/a', undefined, 'seed', undefined, undefined, undefined, undefined, [], options),
    ).rejects.toThrow(/CLI entry or database path/);
    expect(opts).toHaveLength(0);
    expect(mgr.isLive(7)).toBe(false);
  });
});

describe('delivery channel per live session', () => {
  const mcpAdapter: AgentAdapter = {
    ...adapter,
    surfaces: { mcpConfigInteractive: { supported: true } },
  } as AgentAdapter;
  const dirs: string[] = [];
  afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));
  const open = (a: AgentAdapter, host: TerminalHost): SessionManager => {
    const configDir = mkdtempSync(join(tmpdir(), 'karst-mcp-'));
    dirs.push(configDir);
    const mgr = new SessionManager(host, () => ({ ...channelFor(), configDir }));
    mgr.openSession(a, 7, '/wt/a', undefined, 'seed', undefined, undefined, undefined, undefined, [], launch);
    return mgr;
  };

  it('a core without a launch-time MCP flag → cli-env', () => {
    expect(open(adapter, recordingHost().host).sessionChannel(7)).toBe('cli-env');
  });

  it('an MCP-registering launch → mcp, and the flag reaches the host for persistence', () => {
    const { host, opts } = recordingHost();
    expect(open(mcpAdapter, host).sessionChannel(7)).toBe('mcp');
    expect(opts[0]!.mcp).toBe(true);
  });

  it('no session → cli-env', () => {
    expect(new SessionManager(recordingHost().host, channelFor).sessionChannel(7)).toBe('cli-env');
  });

  const revived = (mcp?: boolean): SessionManager => {
    const terminal: SessionTerminal = { show: () => {}, sendText: () => {}, dispose: () => {}, onDidClose: () => {} };
    const host: TerminalHost = {
      createTerminal: () => terminal,
      restoredSessions: () => [{ ticketId: 7, terminal, launchId: 'old', ...(mcp ? { mcp } : {}) }],
    };
    const mgr = new SessionManager(host, channelFor);
    expect(mgr.nudge(7, 'hi')).toBe(true);
    return mgr;
  };

  it('an adopted revived session restores the persisted mcp flag', () => {
    expect(revived(true).sessionChannel(7)).toBe('mcp');
  });

  it('an adopted revived session with no record (older build) → cli-env', () => {
    expect(revived().sessionChannel(7)).toBe('cli-env');
  });
});
