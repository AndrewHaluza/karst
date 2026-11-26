import { describe, expect, it, vi } from 'vitest';
import { REMOTE_ENV_ALLOWLIST, remoteEnv, remoteEnvScript, rewriteHostPaths } from './sshEnv.js';

const HOST_WS = '/Users/nick/Work/projects/karst/.karst/worktrees/t';
const REMOTE_WS = '/home/nick/.karst/karst-0a1b2c3d-7-claude';
const HOST_BRIDGE = '/Users/nick/Library/Application Support/karst/events/7';
const REMOTE_BRIDGE = `${REMOTE_WS}/bridge/7`;

const paths = {
  hostWorktreePath: HOST_WS,
  remoteWorktreePath: `${REMOTE_WS}/repo`,
  hostBridgeDir: HOST_BRIDGE,
  remoteBridgeDir: REMOTE_BRIDGE,
};

describe('REMOTE_ENV_ALLOWLIST', () => {
  it('carries the locale/terminal keys and the four adapter keys', () => {
    expect(REMOTE_ENV_ALLOWLIST).toEqual(
      expect.arrayContaining([
        'LANG', 'LC_ALL', 'TERM', 'COLORTERM', 'NO_COLOR', 'TZ',
        'OPENCODE_PERMISSION', 'OPENCODE_CONFIG_CONTENT', 'OPENCODE_CONFIG_DIR', 'OPENCODE_PURE',
      ]),
    );
  });
});

describe('remoteEnv', () => {
  it('drops a secret and keeps the adapter and karst keys', () => {
    const debug = vi.fn();
    const env = remoteEnv(
      {
        FOO_SECRET: 'hunter2',
        AWS_SECRET_ACCESS_KEY: 'AKIA-not-for-the-vm',
        OPENCODE_PURE: '0',
        KARST_TICKET_ID: '7',
        LANG: 'en_US.UTF-8',
      },
      paths,
      debug,
    );
    expect(env).not.toHaveProperty('FOO_SECRET');
    expect(env).not.toHaveProperty('AWS_SECRET_ACCESS_KEY');
    expect(env.OPENCODE_PURE).toBe('0');
    expect(env.KARST_TICKET_ID).toBe('7');
    expect(env.LANG).toBe('en_US.UTF-8');
    // Only the NAME is logged, never a value.
    expect(debug).toHaveBeenCalledWith(expect.stringContaining('FOO_SECRET'));
    expect(JSON.stringify(debug.mock.calls)).not.toContain('hunter2');
  });

  it('returns a NEW record and never mutates the input', () => {
    const input = { OPENCODE_PURE: '0' };
    const out = remoteEnv(input, paths);
    expect(out).not.toBe(input);
    expect(input).toEqual({ OPENCODE_PURE: '0' });
  });

  it('sets KARST_BRIDGE_DIR to the remote bridge run dir', () => {
    const env = remoteEnv({ KARST_BRIDGE_DIR: '/karst-bridge/7' }, paths);
    expect(env.KARST_BRIDGE_DIR).toBe(REMOTE_BRIDGE);
  });

  it('drops the host-only karst env (cli, db, manifest, instructions)', () => {
    const env = remoteEnv(
      {
        KARST_CLI: '/host/cli.js',
        KARST_DB: '/host/karst.db',
        KARST_MANIFEST: '/host/karst.yml',
        KARST_INSTRUCTIONS: '/host/i.md',
        KARST_LAUNCH_ID: 'l1',
      },
      paths,
    );
    expect(env).toEqual({ KARST_LAUNCH_ID: 'l1', KARST_BRIDGE_DIR: REMOTE_BRIDGE });
  });

  it('keeps the adapter keys with no host path left in the value', () => {
    const env = remoteEnv(
      {
        OPENCODE_PERMISSION: JSON.stringify({ edit: 'allow', files: [`${HOST_WS}/a.ts`] }),
        OPENCODE_CONFIG_DIR: `${HOST_BRIDGE}/opencode/opencode-config`,
        OPENCODE_CONFIG_CONTENT: JSON.stringify({ mcp: {}, cwd: HOST_WS }),
        CLAUDE_CONFIG_DIR: '/Users/nick/.claude-acct',
      },
      paths,
    );
    for (const key of ['OPENCODE_PERMISSION', 'OPENCODE_CONFIG_DIR', 'OPENCODE_CONFIG_CONTENT']) {
      expect(env[key], key).toBeDefined();
      expect(env[key], key).not.toContain(HOST_WS);
      expect(env[key], key).not.toContain(HOST_BRIDGE);
    }
    expect(env.OPENCODE_CONFIG_DIR).toBe(`${REMOTE_BRIDGE}/opencode/opencode-config`);
    expect(env.OPENCODE_PERMISSION).toContain(`${REMOTE_WS}/repo/a.ts`);
    // An account dir is a host path for a host store: not allowlisted.
    expect(env).not.toHaveProperty('CLAUDE_CONFIG_DIR');
  });

  it('drops a key that is not a valid shell name, without echoing a value', () => {
    const debug = vi.fn();
    const env = remoteEnv({ 'BAD-KEY': 'v', KARST_OK: '1' }, paths, debug);
    expect(env).not.toHaveProperty('BAD-KEY');
    expect(env.KARST_OK).toBe('1');
    expect(debug).toHaveBeenCalledWith(expect.stringContaining('BAD-KEY'));
    expect(JSON.stringify(debug.mock.calls)).not.toContain('"v"');
  });

  it('leaves a value untouched when no host path appears in it', () => {
    const env = remoteEnv({ TERM: 'xterm-256color', KARST_TICKET: 'K-7' }, paths);
    expect(env.TERM).toBe('xterm-256color');
    expect(env.KARST_TICKET).toBe('K-7');
  });
});

describe('remoteEnvScript', () => {
  it('renders one export line per key and quotes a value with a quote safely', () => {
    const script = remoteEnvScript({ KARST_TICKET_ID: '7', OPENCODE_PERMISSION: "it's fine" });
    expect(script).toBe(["export KARST_TICKET_ID='7'", "export OPENCODE_PERMISSION='it'\\''s fine'"].join('\n'));
    expect(script).not.toContain('\n\n');
  });

  it('refuses a name that is not a valid shell identifier', () => {
    expect(() => remoteEnvScript({ 'BAD KEY': 'x' })).toThrow(/env name/);
  });
});

describe('rewriteHostPaths', () => {
  it('rewrites the exact path and every child path, and nothing else', () => {
    expect(
      rewriteHostPaths(
        [HOST_WS, `${HOST_WS}/src/a.ts`, `${HOST_WS}/../other`, '--flag', `/x/${HOST_WS}`],
        HOST_WS,
        '/r/repo',
      ),
    ).toEqual(['/r/repo', '/r/repo/src/a.ts', '/r/repo/../other', '--flag', `/x/${HOST_WS}`]);
  });

  it('does not double a separator when the prefixes end with one', () => {
    expect(rewriteHostPaths([`${HOST_WS}/a`], `${HOST_WS}/`, '/r/repo/')).toEqual(['/r/repo/a']);
  });
});
