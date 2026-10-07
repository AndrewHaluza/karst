/**
 * Launch-time MCP server configuration for an agent session.
 *
 * The karst MCP server is registered from a config file (or a `--mcp-config`
 * flag) the session launch owns — NEVER a `.mcp.json` committed into a repo or
 * worktree, which would dirty `git status` and leak a machine path into the
 * diff. This module is the ONE place that renders the server entry and each
 * core's config shape; `karst mcp install` reuses it for user-scope output.
 *
 * vscode-free so the CLI's `mcp install` can import it under plain `node`.
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** An MCP server entry in the standard (`mcpServers`) shape. */
export interface McpServerEntry {
  readonly command: string;
  readonly args: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
}

/** Everything needed to start `karst mcp serve` for one session. */
export interface McpConnection {
  readonly cliEntry: string;
  readonly dbPath?: string;
  readonly manifestPath?: string;
  readonly ticketKey?: string;
  readonly outboxPath?: string;
}

/** Agents `mcp install` knows how to shape a config for. */
export type McpAgent = 'generic' | 'claude' | 'cursor' | 'opencode' | 'codex';

export const MCP_AGENTS: readonly McpAgent[] = ['generic', 'claude', 'cursor', 'opencode', 'codex'];

/** The server name registered in every agent's config. */
export const KARST_MCP_NAME = 'karst';

/**
 * The `karst mcp serve` argv for a connection. `command` is the plain `node`
 * binary (the CLI is invoked that way everywhere), never `process.execPath` —
 * in the extension host that is Electron, which cannot run the CLI.
 */
export function karstMcpServerEntry(
  connection: McpConnection,
  name: string = KARST_MCP_NAME,
): McpServerEntry {
  const args = [connection.cliEntry, 'mcp', 'serve'];
  if (connection.dbPath) args.push('--db', connection.dbPath);
  if (connection.manifestPath) args.push('--manifest', connection.manifestPath);
  if (connection.ticketKey) args.push('--ticket', connection.ticketKey);
  const env = connection.outboxPath ? { KARST_OUTBOX: connection.outboxPath } : undefined;
  return { command: 'node', args, ...(env ? { env } : {}) };
}

/** The standard `{ mcpServers: { karst: … } }` config claude/cursor/generic read. */
export function mcpServersConfig(
  connection: McpConnection,
  name: string = KARST_MCP_NAME,
): { mcpServers: Record<string, McpServerEntry> } {
  return { mcpServers: { [name]: karstMcpServerEntry(connection, name) } };
}

/** One `mcp`-section server (opencode/opencode2 shape). */
export interface OpencodeMcpServer {
  readonly type: 'local';
  readonly command: string[];
  readonly enabled: boolean;
  readonly environment?: Record<string, string>;
}

/**
 * Read a standard `{ mcpServers: { … } }` file karst wrote for a launch. A core
 * whose config is a blob (opencode2) converts this rather than karst writing a
 * second, core-specific file.
 */
export function readMcpServersConfig(path: string): Record<string, McpServerEntry> {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as { mcpServers?: Record<string, McpServerEntry> };
  return parsed.mcpServers ?? {};
}

/** opencode/opencode2 `mcp` section from a standard servers map. */
export function opencodeMcpSection(
  servers: Record<string, McpServerEntry>,
): Record<string, OpencodeMcpServer> {
  const out: Record<string, OpencodeMcpServer> = {};
  for (const [name, entry] of Object.entries(servers)) {
    out[name] = {
      type: 'local',
      command: [entry.command, ...entry.args],
      enabled: true,
      ...(entry.env ? { environment: { ...entry.env } } : {}),
    };
  }
  return out;
}

/** opencode's `mcp` map: a local (stdio) server whose `command` is a single argv array. */
export function opencodeMcpConfig(
  connection: McpConnection,
  name: string = KARST_MCP_NAME,
): { mcp: Record<string, OpencodeMcpServer> } {
  const entry = karstMcpServerEntry(connection, name);
  return { mcp: opencodeMcpSection({ [name]: entry }) };
}

/** codex's `~/.codex/config.toml` snippet (TOML, not JSON). */
export function codexMcpConfig(
  connection: McpConnection,
  name: string = KARST_MCP_NAME,
): string {
  const entry = karstMcpServerEntry(connection, name);
  const args = entry.args.map((a) => JSON.stringify(a)).join(', ');
  return `[mcp_servers.${name}]\ncommand = "node"\nargs = [${args}]\n`;
}

/**
 * The config an agent consumes: an object for the JSON agents, a TOML string
 * for codex. `format` tells `mcp install` how to serialize it.
 */
export function mcpConfigForAgent(
  agent: McpAgent,
  connection: McpConnection,
  name: string = KARST_MCP_NAME,
): { format: 'json' | 'toml'; value: unknown } {
  switch (agent) {
    case 'opencode':
      return { format: 'json', value: opencodeMcpConfig(connection, name) };
    case 'codex':
      return { format: 'toml', value: codexMcpConfig(connection, name) };
    case 'generic':
    case 'claude':
    case 'cursor':
      return { format: 'json', value: mcpServersConfig(connection, name) };
  }
}

/** The user-scope config path for an agent, or `null` when it has no fixed one. */
export function userScopeMcpPath(agent: McpAgent, home: string = homedir()): string | null {
  switch (agent) {
    case 'claude':
      return join(home, '.claude.json');
    case 'cursor':
      return join(home, '.cursor', 'mcp.json');
    case 'opencode':
      return join(home, '.config', 'opencode', 'opencode.json');
    case 'codex':
      return join(home, '.codex', 'config.toml');
    case 'generic':
      return null;
  }
}
