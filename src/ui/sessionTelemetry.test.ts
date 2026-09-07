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
});
