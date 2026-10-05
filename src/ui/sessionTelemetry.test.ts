import { describe, expect, it } from 'vitest';
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
      { dbPath: '/storage/karst.db' },
      { provider: 'claude', model: null },
    );
    expect(opts).toHaveLength(1);
    const env = opts[0]!.env;
    expect(env[KARST_TICKET_ENV]).toBe('7');
    expect(env[KARST_LAUNCH_ENV]).toBe('fresh-launch');
    expect(env[KARST_DB_ENV]).toBe('/storage/karst.db');
    expect(env[KARST_PROVIDER_ENV]).toBe('claude');
  });

  it('omits the attribution env when dbPath/provider are absent', () => {
    const { host, opts } = recordingHost();
    const mgr = new SessionManager(host, channelFor);
    mgr.openSession(adapter, 7, '/wt/a');
    const env = opts[0]!.env;
    expect(env[KARST_TICKET_ENV]).toBe('7');
    expect(env[KARST_DB_ENV]).toBeUndefined();
    expect(env[KARST_PROVIDER_ENV]).toBeUndefined();
  });

  it('exports KARST_CLI, KARST_DB, KARST_MANIFEST, KARST_TICKET when supplied; KARST_TICKET_ID unchanged', () => {
    const { host, opts } = recordingHost();
    const mgr = new SessionManager(host, channelFor);
    mgr.openSession(adapter, 7, '/wt/a', undefined, 'seed', undefined, undefined, undefined, undefined, [], {
      dbPath: '/storage/karst.db',
      cliEntry: '/ext/dist/cli/main.js',
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

  it('omits the CLI env when cliEntry/manifestPath/ticketKey are absent', () => {
    const { host, opts } = recordingHost();
    const mgr = new SessionManager(host, channelFor);
    mgr.openSession(adapter, 7, '/wt/a', undefined, 'seed', undefined, undefined, undefined, undefined, [], {
      dbPath: '/storage/karst.db',
    });
    const env = opts[0]!.env;
    expect(env['KARST_DB']).toBe('/storage/karst.db');
    expect(env['KARST_CLI']).toBeUndefined();
    expect(env['KARST_MANIFEST']).toBeUndefined();
    expect(env['KARST_TICKET']).toBeUndefined();
  });

  it('cliEntry without dbPath exports nothing CLI-related and debug-logs it', () => {
    const { host, opts } = recordingHost();
    const lines: string[] = [];
    const mgr = new SessionManager(host, channelFor);
    mgr.openSession(adapter, 7, '/wt/a', undefined, 'seed', undefined, undefined, undefined, undefined, [], {
      cliEntry: '/ext/dist/cli/main.js',
      manifestPath: '/repo/karst.yml',
      ticketKey: 'NDL-7',
      debug: (m) => lines.push(m),
    });
    const env = opts[0]!.env;
    expect(env['KARST_CLI']).toBeUndefined();
    expect(env['KARST_DB']).toBeUndefined();
    expect(env['KARST_MANIFEST']).toBeUndefined();
    expect(env['KARST_TICKET']).toBeUndefined();
    expect(lines.some((l) => l.includes('KARST_CLI'))).toBe(true);
    expect(mgr.sessionCliEnv(7)).toEqual({ cli: false, manifest: false, ticket: false });
  });

  it('dbPath without cliEntry exports only KARST_DB', () => {
    const { host, opts } = recordingHost();
    const mgr = new SessionManager(host, channelFor);
    mgr.openSession(adapter, 7, '/wt/a', undefined, 'seed', undefined, undefined, undefined, undefined, [], {
      dbPath: '/storage/karst.db',
      manifestPath: '/repo/karst.yml',
      ticketKey: 'NDL-7',
    });
    const env = opts[0]!.env;
    expect(env['KARST_DB']).toBe('/storage/karst.db');
    expect(env['KARST_CLI']).toBeUndefined();
    expect(env['KARST_MANIFEST']).toBeUndefined();
    expect(env['KARST_TICKET']).toBeUndefined();
  });
});

describe('recorded CLI export per live session (H1/H2)', () => {
  it('records what the launch exported', () => {
    const { host } = recordingHost();
    const mgr = new SessionManager(host, channelFor);
    mgr.openSession(adapter, 7, '/wt/a', undefined, 'seed', undefined, undefined, undefined, undefined, [], {
      dbPath: '/d',
      cliEntry: '/c',
      ticketKey: 'NDL-7',
    });
    expect(mgr.sessionCliEnv(7)).toEqual({ cli: true, manifest: false, ticket: true });
  });

  it('no session → undefined', () => {
    const mgr = new SessionManager(recordingHost().host, channelFor);
    expect(mgr.sessionCliEnv(7)).toBeUndefined();
  });

  it('an adopted revived session has no export record → undefined (literal fallback)', () => {
    const terminal: SessionTerminal = {
      show: () => {},
      sendText: () => {},
      dispose: () => {},
      onDidClose: () => {},
    };
    const host: TerminalHost = {
      createTerminal: () => terminal,
      restoredSessions: () => [{ ticketId: 7, terminal, launchId: 'old' }],
    };
    const mgr = new SessionManager(host, channelFor);
    expect(mgr.nudge(7, 'hi')).toBe(true);
    expect(mgr.sessionCliEnv(7)).toBeUndefined();
  });
});
