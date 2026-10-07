import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runMcpInstall } from './installCommand.js';

const ENV = { KARST_CLI: '/ext/dist/cli/main.js', KARST_DB: '/db', KARST_MANIFEST: '/m.yml', KARST_TICKET: 'K-1' };

function parse(out: string): Record<string, unknown> {
  return JSON.parse(out) as Record<string, unknown>;
}

describe('runMcpInstall', () => {
  it('prints the standard mcpServers config with the CLI as argv[0]', () => {
    const out = parse(runMcpInstall(['mcp', 'install'], {}, ENV));
    expect(out.agent).toBe('generic');
    expect(out.config).toMatchObject({
      mcpServers: { karst: { command: 'node', args: ['/ext/dist/cli/main.js', 'mcp', 'serve', '--db', '/db', '--manifest', '/m.yml', '--ticket', 'K-1'] } },
    });
  });

  it('shapes opencode config as a local server whose command is one argv array', () => {
    const out = parse(runMcpInstall(['mcp', 'install', '--agent', 'opencode'], {}, ENV));
    expect(out.config).toMatchObject({
      mcp: { karst: { type: 'local', enabled: true, command: ['node', '/ext/dist/cli/main.js', 'mcp', 'serve', '--db', '/db', '--manifest', '/m.yml', '--ticket', 'K-1'] } },
    });
  });

  it('shapes codex config as a TOML snippet', () => {
    const out = parse(runMcpInstall(['mcp', 'install', '--agent', 'codex'], {}, ENV));
    expect(out.format).toBe('toml');
    expect(out.config).toContain('[mcp_servers.karst]');
    expect(out.config).toContain('command = "node"');
  });

  it('lets an explicit --cli override KARST_CLI', () => {
    const out = parse(runMcpInstall(['mcp', 'install', '--cli', '/other/cli.js'], {}, ENV));
    expect(out.config).toMatchObject({ mcpServers: { karst: { args: ['/other/cli.js', 'mcp', 'serve', '--db', '/db', '--manifest', '/m.yml', '--ticket', 'K-1'] } } });
  });

  it('rejects an unknown agent by name', () => {
    expect(() => runMcpInstall(['mcp', 'install', '--agent', 'nope'], {}, ENV)).toThrow(/unknown agent/);
  });

  it('requires a CLI entry', () => {
    expect(() => runMcpInstall(['mcp', 'install'], {}, {})).toThrow(/--cli/);
  });

  it('writes the config to --write and reports the path', () => {
    const dir = mkdtempSync(join(tmpdir(), 'karst-mcp-install-'));
    try {
      const target = join(dir, 'nested', 'mcp.json');
      const out = parse(runMcpInstall(['mcp', 'install', '--write', target], {}, ENV));
      expect(out).toEqual({ ok: true, agent: 'generic', path: target });
      const written = JSON.parse(readFileSync(target, 'utf8')) as Record<string, unknown>;
      expect(written).toMatchObject({ mcpServers: { karst: { command: 'node' } } });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('carries the planning outbox env into the server entry', () => {
    const out = parse(
      runMcpInstall(['mcp', 'install'], {}, { ...ENV, KARST_OUTBOX: '/out' }),
    );
    expect(out.config).toMatchObject({
      mcpServers: { karst: { env: { KARST_OUTBOX: '/out' } } },
    });
  });

  it('MERGES into an existing JSON config, preserving unrelated keys and servers', () => {
    const dir = mkdtempSync(join(tmpdir(), 'karst-mcp-merge-'));
    try {
      const target = join(dir, '.claude.json');
      writeFileSync(
        target,
        JSON.stringify({
          oauthAccount: { user: 'me' },
          theme: 'dark',
          mcpServers: { other: { command: 'npx', args: ['other'] } },
        }),
        'utf8',
      );
      runMcpInstall(['mcp', 'install', '--agent', 'claude', '--write', target], {}, ENV);
      const written = JSON.parse(readFileSync(target, 'utf8')) as Record<string, unknown>;
      expect(written).toMatchObject({
        oauthAccount: { user: 'me' },
        theme: 'dark',
        mcpServers: {
          other: { command: 'npx', args: ['other'] },
          karst: { command: 'node' },
        },
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('replaces only the named server on a re-write, never duplicating it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'karst-mcp-rewrite-'));
    try {
      const target = join(dir, 'mcp.json');
      writeFileSync(target, JSON.stringify({ mcpServers: { karst: { command: 'stale' } } }), 'utf8');
      runMcpInstall(['mcp', 'install', '--cli', '/new/cli.js', '--write', target], {}, ENV);
      const written = JSON.parse(readFileSync(target, 'utf8')) as {
        mcpServers: Record<string, { args: string[] }>;
      };
      expect(Object.keys(written.mcpServers)).toEqual(['karst']);
      expect(written.mcpServers.karst!.args[0]).toBe('/new/cli.js');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('MERGES into an existing TOML config, preserving other tables', () => {
    const dir = mkdtempSync(join(tmpdir(), 'karst-mcp-toml-'));
    try {
      const target = join(dir, 'config.toml');
      writeFileSync(
        target,
        'model = "gpt-5"\n\n[mcp_servers.other]\ncommand = "npx"\n\n[history]\npersistence = "save-all"\n',
        'utf8',
      );
      const out = parse(runMcpInstall(['mcp', 'install', '--agent', 'codex', '--write', target], {}, ENV));
      expect(out).toEqual({ ok: true, agent: 'codex', path: target });
      const written = readFileSync(target, 'utf8');
      expect(written).toContain('model = "gpt-5"');
      expect(written).toContain('[mcp_servers.other]');
      expect(written).toContain('[history]');
      expect(written).toContain('[mcp_servers.karst]');
      // The stale karst table is replaced, not appended a second time.
      expect(written.match(/\[mcp_servers\.karst\]/g)).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses to overwrite a config that is not valid JSON', () => {
    const dir = mkdtempSync(join(tmpdir(), 'karst-mcp-bad-'));
    try {
      const target = join(dir, 'broken.json');
      writeFileSync(target, '{ not json', 'utf8');
      expect(() =>
        runMcpInstall(['mcp', 'install', '--write', target], {}, ENV),
      ).toThrow(/not valid JSON/);
      expect(readFileSync(target, 'utf8')).toBe('{ not json');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
