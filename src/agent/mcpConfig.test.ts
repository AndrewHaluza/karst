import { describe, expect, it } from 'vitest';
import { codexMcpConfigArgs } from './mcpConfig.js';

describe('codexMcpConfigArgs', () => {
  it('renders one --config pair per key, TOML-quoted', () => {
    expect(
      codexMcpConfigArgs({ karst: { command: 'node', args: ['/a b/main.js', 'mcp', 'serve'] } }),
    ).toEqual([
      '--config',
      'mcp_servers.karst.command="node"',
      '--config',
      'mcp_servers.karst.args=["/a b/main.js","mcp","serve"]',
    ]);
  });

  it('adds one env key per variable and escapes quotes and backslashes', () => {
    const args = codexMcpConfigArgs({
      karst: { command: 'node', args: [], env: { KARST_OUTBOX: 'C:\\o"x' } },
    });
    expect(args).toContain('mcp_servers.karst.env.KARST_OUTBOX="C:\\\\o\\"x"');
  });

  it('quotes a server name that is not a bare TOML key', () => {
    const args = codexMcpConfigArgs({ 'my server': { command: 'node', args: [] } });
    expect(args[1]).toBe('mcp_servers."my server".command="node"');
  });

  it('returns nothing for no servers', () => {
    expect(codexMcpConfigArgs({})).toEqual([]);
  });
});
