import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  ANTIGRAVITY_NOT_RUNNING_REASON,
  ANTIGRAVITY_UNRESPONSIVE_REASON,
  discoverAntigravityServer,
  parseLanguageServerCommand,
} from './antigravityDiscovery.js';

describe('antigravityDiscovery', () => {
  describe('parseLanguageServerCommand', () => {
    it('parses --csrf_token and --http_server_port with spaces', () => {
      const parsed = parseLanguageServerCommand(
        '/path/to/language_server --csrf_token secret-token-1 --http_server_port 57687',
      );
      expect(parsed).toEqual({
        csrfToken: 'secret-token-1',
        port: 57687,
      });
    });

    it('parses -csrf_token= and -http_server_port= with equals and quotes', () => {
      const parsed = parseLanguageServerCommand(
        '/path/to/language_server -csrf_token="secret-token-2" -http_server_port="57688"',
      );
      expect(parsed).toEqual({
        csrfToken: 'secret-token-2',
        port: 57688,
      });
    });

    it('parses --csrf-token and --port flags', () => {
      const parsed = parseLanguageServerCommand(
        'language_server_darwin_arm64 --csrf-token secret-token-3 --port 45123',
      );
      expect(parsed).toEqual({
        csrfToken: 'secret-token-3',
        port: 45123,
      });
    });

    it('returns csrfToken and null port when port is 0 or omitted', () => {
      const parsedWithoutPort = parseLanguageServerCommand(
        'language_server --csrf_token secret-token-4',
      );
      expect(parsedWithoutPort).toEqual({
        csrfToken: 'secret-token-4',
        port: null,
      });

      const parsedWithZeroPort = parseLanguageServerCommand(
        'language_server --csrf_token secret-token-4 --http_server_port 0',
      );
      expect(parsedWithZeroPort).toEqual({
        csrfToken: 'secret-token-4',
        port: null,
      });
    });

    it('returns null when csrf_token is missing', () => {
      const parsed = parseLanguageServerCommand(
        '/path/to/language_server --http_server_port 57687',
      );
      expect(parsed).toBeNull();
    });
  });

  describe('discoverAntigravityServer', () => {
    it('prefers env vars over discovered running servers', async () => {
      const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
      const result = await discoverAntigravityServer({
        env: {
          ANTIGRAVITY_LS_ADDRESS: '127.0.0.1:9999',
          ANTIGRAVITY_CSRF_TOKEN: 'env-token-xyz',
        },
        listProcesses: () => [
          {
            pid: 1234,
            command: 'language_server --csrf_token proc-token --http_server_port 57687',
          },
        ],
        readFile: () => null,
        listDir: () => [],
        fetchImpl: fetchMock,
      });

      expect(result).toEqual({
        address: '127.0.0.1:9999',
        csrfToken: 'env-token-xyz',
      });
      // Env vars win immediately, no probe fetch needed
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('returns not-running reason when env is empty and no processes or files exist', async () => {
      const result = await discoverAntigravityServer({
        env: {},
        listProcesses: () => [],
        readFile: () => null,
        listDir: () => [],
      });

      expect(result).toEqual({
        reason: ANTIGRAVITY_NOT_RUNNING_REASON,
      });
    });

    it('discovers running server via process argv with explicit port and verifies with GetUserStatus', async () => {
      const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
        expect(url).toBe('http://127.0.0.1:57687/exa.language_server_pb.LanguageServerService/GetUserStatus');
        expect(init?.method).toBe('POST');
        const headers = init?.headers as Record<string, string>;
        expect(headers['Connect-Protocol-Version']).toBe('1');
        expect(headers['x-codeium-csrf-token']).toBe('token-from-proc');
        return Promise.resolve(new Response('{"userStatus":{}}', { status: 200 }));
      });

      const result = await discoverAntigravityServer({
        env: {},
        listProcesses: () => [
          {
            pid: 4321,
            command: '/opt/agy/language_server --csrf_token token-from-proc --http_server_port 57687',
          },
        ],
        readFile: () => null,
        listDir: () => [],
        fetchImpl: fetchMock,
      });

      expect(result).toEqual({
        address: '127.0.0.1:57687',
        csrfToken: 'token-from-proc',
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('discovers port via listPorts when process argv does not specify port', async () => {
      const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
      const listPorts = vi.fn().mockResolvedValue([57687]);

      const result = await discoverAntigravityServer({
        env: {},
        listProcesses: () => [
          {
            pid: 5555,
            command: 'language_server --csrf_token token-lsof',
          },
        ],
        listPorts,
        readFile: () => null,
        listDir: () => [],
        fetchImpl: fetchMock,
      });

      expect(listPorts).toHaveBeenCalledWith(5555);
      expect(result).toEqual({
        address: '127.0.0.1:57687',
        csrfToken: 'token-lsof',
      });
    });

    it('discovers server from discovery.json file', async () => {
      const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
      const readFile = vi.fn().mockImplementation((path: string) => {
        if (path.includes('antigravity/discovery.json')) {
          return JSON.stringify({
            address: '127.0.0.1:51111',
            csrf_token: 'file-csrf-token',
          });
        }
        return null;
      });

      const result = await discoverAntigravityServer({
        env: {},
        listProcesses: () => [],
        readFile,
        listDir: () => [],
        fetchImpl: fetchMock,
      });

      expect(result).toEqual({
        address: '127.0.0.1:51111',
        csrfToken: 'file-csrf-token',
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('filters out grep commands and processes without language_server or agy in command', async () => {
      const fetchMock = vi.fn();
      const result = await discoverAntigravityServer({
        env: {},
        listProcesses: () => [
          {
            pid: 100,
            command: 'grep --csrf_token fake-token language_server',
          },
          {
            pid: 101,
            command: 'node some_other_script.js --csrf_token fake-token',
          },
        ],
        readFile: () => null,
        listDir: () => [],
        fetchImpl: fetchMock,
      });

      expect(result).toEqual({
        reason: ANTIGRAVITY_NOT_RUNNING_REASON,
      });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('when multiple candidate servers exist, picks the one that answers GetUserStatus', async () => {
      const fetchMock = vi.fn().mockImplementation((url: string) => {
        if (url.includes('50001')) {
          return Promise.reject(new Error('Connection refused'));
        }
        if (url.includes('50002')) {
          return Promise.resolve(new Response('{"userStatus":{}}', { status: 200 }));
        }
        return Promise.resolve(new Response('error', { status: 500 }));
      });

      const result = await discoverAntigravityServer({
        env: {},
        listProcesses: () => [
          {
            pid: 1,
            command: 'language_server --csrf_token token-1 --http_server_port 50001',
          },
          {
            pid: 2,
            command: 'language_server --csrf_token token-2 --http_server_port 50002',
          },
        ],
        readFile: () => null,
        listDir: () => [],
        fetchImpl: fetchMock,
        timeoutMs: 1500,
      });

      expect(result).toEqual({
        address: '127.0.0.1:50002',
        csrfToken: 'token-2',
      });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('when candidate servers exist but none answer GetUserStatus, returns unresponsive reason', async () => {
      const fetchMock = vi.fn().mockResolvedValue(new Response('Internal Error', { status: 500 }));

      const result = await discoverAntigravityServer({
        env: {},
        listProcesses: () => [
          {
            pid: 1,
            command: 'language_server --csrf_token token-dead --http_server_port 50001',
          },
        ],
        readFile: () => null,
        listDir: () => [],
        fetchImpl: fetchMock,
      });

      expect(result).toEqual({
        reason: ANTIGRAVITY_UNRESPONSIVE_REASON,
      });
    });

    it('token value never appears in returned reason', async () => {
      const secretToken = 'super-secret-csrf-value-999';
      const fetchMock = vi.fn().mockRejectedValue(new Error(`Failed to reach ${secretToken}`));

      const result = await discoverAntigravityServer({
        env: {},
        listProcesses: () => [
          {
            pid: 1,
            command: `language_server --csrf_token ${secretToken} --http_server_port 50001`,
          },
        ],
        readFile: () => null,
        listDir: () => [],
        fetchImpl: fetchMock,
      });

      expect('reason' in result).toBe(true);
      if ('reason' in result) {
        expect(result.reason).toBe(ANTIGRAVITY_UNRESPONSIVE_REASON);
        expect(result.reason).not.toContain(secretToken);
      }
    });

    it('discovers a daemon ls_*.json with httpPort and csrfToken', async () => {
      const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
      const daemonDir = join('/nope', '.gemini', 'antigravity', 'daemon');
      const readFile = vi.fn((path: string) =>
        path === join(daemonDir, 'ls_1234.json')
          ? JSON.stringify({ httpPort: 52111, csrfToken: 'daemon-ls-token' })
          : null,
      );

      const result = await discoverAntigravityServer({
        env: {},
        homeDir: '/nope',
        listProcesses: () => [],
        readFile,
        listDir: (dir) => (dir === daemonDir ? ['ls_1234.json'] : []),
        fetchImpl: fetchMock,
      });

      expect(result).toEqual({ address: '127.0.0.1:52111', csrfToken: 'daemon-ls-token' });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('discovers a daemon hub_*.json with http_server_port and csrf_token', async () => {
      const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
      const daemonDir = join('/nope', '.gemini', 'antigravity-ide', 'daemon');
      const readFile = vi.fn((path: string) =>
        path === join(daemonDir, 'hub_abc.json')
          ? JSON.stringify({ http_server_port: 52333, csrf_token: 'hub-token' })
          : null,
      );

      const result = await discoverAntigravityServer({
        env: {},
        homeDir: '/nope',
        listProcesses: () => [],
        readFile,
        listDir: (dir) => (dir === daemonDir ? ['hub_abc.json'] : []),
        fetchImpl: fetchMock,
      });

      expect(result).toEqual({ address: '127.0.0.1:52333', csrfToken: 'hub-token' });
    });

    it('ignores daemon files that are neither ls_*.json nor hub_*.json', async () => {
      const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
      const daemonDir = join('/nope', '.gemini', 'antigravity', 'daemon');
      const readFile = vi.fn((path: string) =>
        path.endsWith(join('antigravity', 'daemon', 'ls_real.json'))
          ? JSON.stringify({ port: 53001, csrfToken: 'real-token' })
          : null,
      );

      const result = await discoverAntigravityServer({
        env: {},
        homeDir: '/nope',
        listProcesses: () => [],
        readFile,
        listDir: (dir) =>
          dir === daemonDir ? ['other.json', 'ls_notes.txt', 'ls_real.json'] : [],
        fetchImpl: fetchMock,
      });

      expect(result).toEqual({ address: '127.0.0.1:53001', csrfToken: 'real-token' });
      const readPaths = readFile.mock.calls.map(([path]) => String(path));
      expect(readPaths.some((path) => path.endsWith('other.json'))).toBe(false);
      expect(readPaths.some((path) => path.endsWith('ls_notes.txt'))).toBe(false);
    });

    it('handles a throwing or empty listDir and still reads discovery.json', async () => {
      const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
      const readFile = vi.fn((path: string) =>
        path.endsWith(join('antigravity', 'discovery.json'))
          ? JSON.stringify({ address: '127.0.0.1:54001', csrf_token: 'file-token' })
          : null,
      );

      const throwing = await discoverAntigravityServer({
        env: {},
        homeDir: '/nope',
        listProcesses: () => [],
        readFile,
        listDir: () => {
          throw new Error('daemon dir unreadable');
        },
        fetchImpl: fetchMock,
      });
      expect(throwing).toEqual({ address: '127.0.0.1:54001', csrfToken: 'file-token' });

      const empty = await discoverAntigravityServer({
        env: {},
        homeDir: '/nope',
        listProcesses: () => [],
        readFile,
        listDir: () => [],
        fetchImpl: fetchMock,
      });
      expect(empty).toEqual({ address: '127.0.0.1:54001', csrfToken: 'file-token' });
    });

    it('skips a malformed daemon file and discovers the next valid one', async () => {
      const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
      const daemonDir = join('/nope', '.gemini', 'antigravity', 'daemon');
      const readFile = vi.fn((path: string) => {
        if (path === join(daemonDir, 'hub_a.json')) return '{not json';
        if (path === join(daemonDir, 'ls_b.json')) {
          return JSON.stringify({ httpPort: 55001, csrfToken: 'second-token' });
        }
        return null;
      });

      const result = await discoverAntigravityServer({
        env: {},
        homeDir: '/nope',
        listProcesses: () => [],
        readFile,
        listDir: (dir) => (dir === daemonDir ? ['ls_b.json', 'hub_a.json'] : []),
        fetchImpl: fetchMock,
      });

      expect(result).toEqual({ address: '127.0.0.1:55001', csrfToken: 'second-token' });
      expect(readFile.mock.calls.map(([path]) => String(path))).toContain(
        join(daemonDir, 'hub_a.json'),
      );
    });

    it('discovers appDataDir/daemon/ls_*.json', async () => {
      const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
      const appDataDir = '/nope/agy-app-data';
      const daemonDir = join(appDataDir, 'daemon');
      const readFile = vi.fn((path: string) =>
        path === join(daemonDir, 'ls_appdata.json')
          ? JSON.stringify({ httpPort: 56001, csrfToken: 'appdata-token' })
          : null,
      );

      const result = await discoverAntigravityServer({
        env: {},
        homeDir: '/nope',
        appDataDir,
        listProcesses: () => [],
        readFile,
        listDir: (dir) => (dir === daemonDir ? ['ls_appdata.json'] : []),
        fetchImpl: fetchMock,
      });

      expect(result).toEqual({ address: '127.0.0.1:56001', csrfToken: 'appdata-token' });
    });
  });
});
