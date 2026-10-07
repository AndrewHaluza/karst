/**
 * `karst mcp install` — print (or write) a user-scope MCP config.
 *
 * The fallback for an agent whose launch karst cannot configure directly: the
 * user pastes the printed block into their own config, or `--write <path>` puts
 * it there. Printing is the default so the command never surprises a user by
 * editing `~/.claude.json`. The shape per agent comes from `agent/mcpConfig.ts`
 * — the SAME renderer a launch-time config uses, so the two cannot drift.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  KARST_MCP_NAME,
  MCP_AGENTS,
  mcpConfigForAgent,
  userScopeMcpPath,
  type McpAgent,
  type McpConnection,
} from '../../agent/mcpConfig.js';
import { KARST_CLI_ENV, KARST_DB_ENV, KARST_MANIFEST_ENV, KARST_TICKET_KEY_ENV } from '../../agent/cliEnv.js';
import { KARST_OUTBOX_ENV, type McpGlobalFlags } from './config.js';

interface InstallArgs {
  readonly agent: McpAgent;
  readonly cli?: string;
  readonly name?: string;
  readonly write?: string;
}

/** Parse `--agent/--cli/--name/--write`, refusing unknown flags and trailing argv. */
function parseInstallArgs(rest: readonly string[]): InstallArgs {
  let agent: McpAgent = 'generic';
  let cli: string | undefined;
  let name: string | undefined;
  let write: string | undefined;
  for (let i = 2; i < rest.length; i++) {
    const token = rest[i]!;
    const value = rest[i + 1];
    switch (token) {
      case '--agent':
        if (value === undefined || value.startsWith('-')) throw new Error('mcp install: --agent needs a value');
        if (!(MCP_AGENTS as readonly string[]).includes(value)) {
          throw new Error(`mcp install: unknown agent '${value}' (want ${MCP_AGENTS.join(', ')})`);
        }
        agent = value as McpAgent;
        i++;
        break;
      case '--cli':
        if (value === undefined) throw new Error('mcp install: --cli needs a path');
        cli = value;
        i++;
        break;
      case '--name':
        if (value === undefined) throw new Error('mcp install: --name needs a value');
        name = value;
        i++;
        break;
      case '--write':
        if (value === undefined) throw new Error('mcp install: --write needs a path');
        write = value;
        i++;
        break;
      default:
        throw new Error(`mcp install: unknown argument '${token}'`);
    }
  }
  return { agent, ...(cli ? { cli } : {}), ...(name ? { name } : {}), ...(write ? { write } : {}) };
}

/** A non-array, non-null object (the shape a config file parses to). */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Merge a generated config into an existing one WITHOUT dropping anything the
 * user already had. Top-level keys are preserved, and the one nested map the
 * configs use (`mcpServers`, or opencode's `mcp`) is merged entry-by-entry so
 * other servers survive. A key whose existing value is not an object (or whose
 * generated value is not one) is replaced outright, matching the shape the
 * renderer owns. Exported for the unit test.
 */
export function mergeMcpJsonConfig(existing: unknown, generated: unknown): unknown {
  if (!isPlainObject(existing) || !isPlainObject(generated)) return generated;
  const out: Record<string, unknown> = { ...existing };
  for (const [key, value] of Object.entries(generated)) {
    const prior = out[key];
    out[key] = isPlainObject(prior) && isPlainObject(value) ? { ...prior, ...value } : value;
  }
  return out;
}

/**
 * Replace (or append) one `[mcp_servers.<name>]` table in an existing TOML
 * document, leaving every other line byte-for-byte intact. The generated block
 * is karst-authored and ends in a newline. Exported for the unit test.
 */
export function mergeMcpTomlConfig(existing: string, name: string, block: string): string {
  const header = `[mcp_servers.${name}]`;
  const kept: string[] = [];
  let skipping = false;
  for (const line of existing.split('\n')) {
    if (skipping) {
      // The next table header ends the table being replaced; keep it and stop.
      if (/^\s*\[/.test(line)) skipping = false;
      else continue;
    }
    if (line.trim() === header) {
      skipping = true;
      continue;
    }
    kept.push(line);
  }
  const base = kept.join('\n').replace(/\s+$/, '');
  const normalized = block.endsWith('\n') ? block : `${block}\n`;
  return base.length > 0 ? `${base}\n\n${normalized}` : normalized;
}

/**
 * Parse an existing JSON config, or `undefined` when the file does not exist or
 * is empty. A file that exists but is not valid JSON THROWS: `--write` must
 * never silently destroy a config karst cannot read.
 */
function readExistingJson(path: string): unknown {
  if (!existsSync(path)) return undefined;
  const text = readFileSync(path, 'utf8').trim();
  if (text === '') return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch (e) {
    throw new Error(
      `mcp install: refusing to overwrite '${path}' — the existing file is not valid JSON (${(e as Error).message})`,
    );
  }
}

/**
 * Run `mcp install`. Resolves the CLI entry from `--cli` or `KARST_CLI`, the
 * registry facts from the global flags or their `KARST_*` env, and prints the
 * agent config as JSON (`{agent, path, config}`), or MERGES `config` into
 * `--write <path>` and prints `{ok, path}`. Merging (never replacing) is what
 * keeps `--write` safe against a real user-scope file: `~/.claude.json` holds
 * dozens of unrelated keys, so an overwrite would destroy the user's config.
 */
export function runMcpInstall(
  rest: readonly string[],
  flags: McpGlobalFlags,
  env: Readonly<Record<string, string | undefined>>,
): string {
  const parsed = parseInstallArgs(rest);
  const cliEntry = parsed.cli ?? env[KARST_CLI_ENV];
  if (!cliEntry) throw new Error('mcp install needs --cli <path> (or KARST_CLI)');
  const connection: McpConnection = {
    cliEntry,
    ...(flags.db ?? env[KARST_DB_ENV] ? { dbPath: flags.db ?? env[KARST_DB_ENV] } : {}),
    ...(flags.manifest ?? env[KARST_MANIFEST_ENV]
      ? { manifestPath: flags.manifest ?? env[KARST_MANIFEST_ENV] }
      : {}),
    ...(flags.ticket ?? env[KARST_TICKET_KEY_ENV]
      ? { ticketKey: flags.ticket ?? env[KARST_TICKET_KEY_ENV] }
      : {}),
    ...(env[KARST_OUTBOX_ENV] ? { outboxPath: env[KARST_OUTBOX_ENV] } : {}),
  };
  const { format, value } = mcpConfigForAgent(parsed.agent, connection, parsed.name);

  if (parsed.write !== undefined) {
    const name = parsed.name ?? KARST_MCP_NAME;
    let body: string;
    if (format === 'toml') {
      const existing = existsSync(parsed.write) ? readFileSync(parsed.write, 'utf8') : '';
      body = mergeMcpTomlConfig(existing, name, String(value));
    } else {
      const existing = readExistingJson(parsed.write);
      const merged = existing === undefined ? value : mergeMcpJsonConfig(existing, value);
      body = JSON.stringify(merged, null, 2) + '\n';
    }
    mkdirSync(dirname(parsed.write), { recursive: true });
    writeFileSync(parsed.write, body);
    return JSON.stringify({ ok: true, agent: parsed.agent, path: parsed.write });
  }

  return JSON.stringify(
    {
      agent: parsed.agent,
      format,
      path: userScopeMcpPath(parsed.agent),
      config: value,
    },
    null,
    2,
  );
}
