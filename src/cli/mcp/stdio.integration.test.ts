import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { openStore, type Store } from '../../store/db.js';
import { createTicket, getTicket } from '../../store/tickets.js';
import { transition } from '../../workflow/machine.js';
import { SCHEMA_VERSION } from '../../store/schemaVersion.js';
import { mcpToolNames } from './tools.js';

/**
 * The MCP server over the REAL stdio transport: a Client spawns `karst mcp
 * serve` as a child process and talks JSON-RPC to it, exactly as an agent CLI
 * would. This is the surface the ticket requires — tool list parity with the
 * registry, an invalid input coming back as a tool error, a draft landing in
 * the outbox, a stage write while the extension holds the DB, and a clean
 * refusal after a schema bump.
 *
 * Integration-named because it spawns a real child process (see AGENTS.md).
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..');
const CLI_ENTRY = join(REPO_ROOT, 'src', 'cli', 'main.ts');
/**
 * `tsx` resolved through Node's normal module lookup, NOT a hard per-worktree
 * path: a karst worktree shares the repository root's `node_modules`, so a
 * worktree that has no `node_modules/tsx` of its own still resolves it one
 * directory up. The hardcoded `<REPO_ROOT>/node_modules/tsx/dist/cli.mjs` made
 * the child die with a bare "Connection closed" whenever this worktree had not
 * installed its own copy.
 */
const TSX_CLI = createRequire(import.meta.url).resolve('tsx/cli');

/** Env for the child: the ambient environment WITHOUT karst refs (isolation), plus the outbox. */
function childEnv(outbox: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !key.startsWith('KARST_')) env[key] = value;
  }
  env.KARST_OUTBOX = outbox;
  return env;
}

describe('karst mcp serve over stdio', () => {
  let dir: string;
  let dbPath: string;
  let outbox: string;
  let extension: Store;
  let client: Client;
  let transport: StdioClientTransport;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'karst-mcp-stdio-'));
    dbPath = join(dir, 'karst.db');
    outbox = join(dir, 'outbox');
    const { mkdirSync } = await import('node:fs');
    mkdirSync(outbox, { recursive: true });

    // Seed a ticket at impl and KEEP the connection open for the whole suite,
    // standing in for the extension holding the registry while the server runs.
    extension = openStore(dbPath);
    createTicket(extension, { key: 'K-1', title: 'mcp demo' });
    transition(extension, 1, 'scope', { kind: 'passed' }); // scope -> impl (running)

    transport = new StdioClientTransport({
      command: process.execPath,
      args: [TSX_CLI, CLI_ENTRY, 'mcp', 'serve', '--db', dbPath, '--ticket', 'K-1'],
      env: childEnv(outbox),
      stderr: 'pipe',
    });
    client = new Client({ name: 'karst-test-client', version: '1.0.0' }, { capabilities: {} });
    await client.connect(transport);
  });

  afterAll(async () => {
    await client?.close();
    extension?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('lists exactly the registry tools (minus only test)', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...mcpToolNames()].sort());
    expect(tools.map((t) => t.name)).not.toContain('test');
    expect(tools.map((t) => t.name)).toContain('graph');
    expect(tools.map((t) => t.name)).toContain('node');
    const stage = tools.find((t) => t.name === 'stage')!;
    expect(stage.inputSchema).toMatchObject({ type: 'object', required: ['stage'] });
  });

  it('returns a validation error as a tool error', async () => {
    const result = await client.callTool({ name: 'stage', arguments: { stage: 'ship' } });
    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ text: string }>)[0]!.text;
    expect(text).toMatch(/one of/);
  });

  it('lands a draft proposal in the outbox', async () => {
    const result = await client.callTool({
      name: 'draft',
      arguments: {
        title: 'Split the work',
        description: 'One piece is its own job.',
        summary: 'Accepted the split; rejected doing it inline.',
        repos: ['extention'],
      },
    });
    expect(result.isError).toBeUndefined();
    const files = readdirSync(outbox).filter((f) => f.endsWith('.json'));
    expect(files.length).toBeGreaterThan(0);
  }, 30000);

  it('writes a stage marker while the extension holds the DB (WAL + busy_timeout)', async () => {
    const result = await client.callTool({ name: 'stage', arguments: { stage: 'impl' } });
    expect(result.isError).toBeUndefined();

    const ticket = getTicket(extension, 1);
    expect(ticket.stages.find((s) => s.stageKey === 'impl')?.status).toBe('passed');
    expect(ticket.stages.find((s) => s.stageKey === 'uat')?.status).toBe('running');
  });

  it('refuses the next call cleanly after a schema-version bump', async () => {
    extension.db.pragma('user_version = 1');
    try {
      const result = await client.callTool({ name: 'context', arguments: { key: 'K-1' } });
      expect(result.isError).toBe(true);
      const text = (result.content as Array<{ text: string }>)[0]!.text;
      expect(text).toMatch(new RegExp(`schema v1.*v${SCHEMA_VERSION}`));
    } finally {
      extension.db.pragma(`user_version = ${SCHEMA_VERSION}`);
    }
  });
});
