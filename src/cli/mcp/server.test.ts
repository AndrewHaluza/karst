import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { commandNames, getCommandSpec } from '../registry.js';
import {
  callTool,
  createKarstMcpServer,
  preservingProcessEnv,
  type McpToolRunner,
} from './server.js';
import { MCP_EXCLUDED_COMMANDS, encodeToolArgv, globalArgv, mcpToolNames, mcpTools } from './tools.js';
import type { CliIo } from '../main.js';
import type { McpServerConfig } from './config.js';

interface Recorded {
  argv: string[];
  env: Readonly<Record<string, string | undefined>>;
  io: CliIo;
}

function recorder(result = 'handler-out'): { runner: McpToolRunner; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const runner: McpToolRunner = {
    async run(argv, env, io) {
      calls.push({ argv, env, io });
      return result;
    },
  };
  return { runner, calls };
}

const NO_CONFIG: McpServerConfig = {};

describe('mcp tools', () => {
  it('exposes every registry command except the excluded internals', () => {
    const expected = commandNames().filter((n) => !MCP_EXCLUDED_COMMANDS.includes(n));
    expect(mcpToolNames()).toEqual(expected);
  });

  it('exposes the host-invoked graph and node verbs, but never test', () => {
    expect(mcpToolNames()).toContain('graph');
    expect(mcpToolNames()).toContain('node');
    expect(mcpToolNames()).not.toContain('test');
  });

  it('takes each tool input schema verbatim from the registry', () => {
    for (const tool of mcpTools()) {
      expect(tool.inputSchema, tool.name).toBe(getCommandSpec(tool.name)!.input);
      expect(tool.description).toBe(getCommandSpec(tool.name)!.summary);
    }
  });
});

describe('encodeToolArgv', () => {
  it('uses the registry encoder when present', () => {
    expect(encodeToolArgv(getCommandSpec('stage')!, { stage: 'fix' })).toEqual([
      'stage',
      'fix',
      'pass',
    ]);
  });

  it('encodes guide and schema explicitly (no registry encoder)', () => {
    expect(encodeToolArgv(getCommandSpec('guide')!, {})).toEqual(['guide']);
    expect(encodeToolArgv(getCommandSpec('schema')!, {})).toEqual(['schema']);
    expect(encodeToolArgv(getCommandSpec('schema')!, { command: 'subtask' })).toEqual([
      'schema',
      'subtask',
    ]);
  });

  it('encodes the closed graph/node parsers from the verb (and node --reason)', () => {
    expect(encodeToolArgv(getCommandSpec('graph')!, { verb: 'submit' })).toEqual([
      'graph',
      'submit',
    ]);
    expect(encodeToolArgv(getCommandSpec('node')!, { verb: 'complete' })).toEqual([
      'node',
      'complete',
    ]);
    expect(encodeToolArgv(getCommandSpec('node')!, { verb: 'block', reason: 'why' })).toEqual([
      'node',
      'block',
      '--reason',
      'why',
    ]);
  });
});

describe('globalArgv', () => {
  const config: McpServerConfig = { db: '/db', manifest: '/m.yml', ticket: 'K-1' };

  it('emits only the globals a command declares', () => {
    expect(globalArgv(getCommandSpec('stage')!, config)).toEqual([
      '--db',
      '/db',
      '--manifest',
      '/m.yml',
      '--ticket',
      'K-1',
    ]);
    // fix-brief declares db only.
    expect(globalArgv(getCommandSpec('fix-brief')!, config)).toEqual(['--db', '/db']);
    // draft declares none — it must never see a global it refuses.
    expect(globalArgv(getCommandSpec('draft')!, config)).toEqual([]);
  });
});

describe('callTool', () => {
  it('returns a tool error for an unknown tool', async () => {
    const { runner } = recorder();
    const result = await callTool('nope', {}, NO_CONFIG, {}, runner);
    expect(result.isError).toBe(true);
    expect(result.content[0]).toMatchObject({ type: 'text', text: expect.stringMatching(/unknown/) });
  });

  it('refuses a tool that maps to an excluded command', async () => {
    const { runner } = recorder();
    const result = await callTool('test', { subcommand: 'reset' }, NO_CONFIG, {}, runner);
    expect(result.isError).toBe(true);
  });

  it('returns a validation error before the handler runs', async () => {
    const { runner, calls } = recorder();
    const result = await callTool('stage', { stage: 'ship' }, NO_CONFIG, {}, runner);
    expect(result.isError).toBe(true);
    expect(result.content[0]).toMatchObject({
      type: 'text',
      text: expect.stringMatching(/one of/),
    });
    expect(calls).toHaveLength(0);
  });

  it('encodes the call and appends the resolved global flags', async () => {
    const { runner, calls } = recorder('{"ok":true}');
    const config: McpServerConfig = { db: '/db', manifest: '/m.yml', ticket: 'K-1' };
    const result = await callTool('stage', { stage: 'impl' }, config, {}, runner);
    expect(result.isError).toBeUndefined();
    expect(result.content[0]).toMatchObject({ type: 'text', text: '{"ok":true}' });
    expect(calls[0]!.argv).toEqual(['stage', 'impl', 'pass', '--db', '/db', '--manifest', '/m.yml', '--ticket', 'K-1']);
  });

  it('overlays the resolved config onto the handler env', async () => {
    const { runner, calls } = recorder();
    const config: McpServerConfig = { db: '/db', ticket: 'K-1', outbox: '/out' };
    await callTool('inbox', {}, config, { KARST_TICKET: 'stale' }, runner);
    expect(calls[0]!.env).toMatchObject({ KARST_DB: '/db', KARST_TICKET: 'K-1', KARST_OUTBOX: '/out' });
  });

  it('feeds the validated draft object back as stdin', async () => {
    const { runner, calls } = recorder('{"ok":true,"file":"f","id":1}');
    await callTool('draft', { title: 'T', description: 'D', summary: 'S', repos: ['extention'] }, NO_CONFIG, {}, runner);
    expect(calls[0]!.argv).toEqual(['draft', 'propose']);
    expect(calls[0]!.io.readStdin(10)).toBe(
      JSON.stringify({ title: 'T', description: 'D', summary: 'S', repos: ['extention'] }),
    );
  });

  it('turns a handler throw into a tool error', async () => {
    const runner: McpToolRunner = {
      async run() {
        throw new Error('no ticket found');
      },
    };
    const result = await callTool('context', { key: 'K-1' }, NO_CONFIG, {}, runner);
    expect(result.isError).toBe(true);
    expect(result.content[0]).toMatchObject({ text: 'no ticket found' });
  });
});

describe('preservingProcessEnv', () => {
  const io: CliIo = { readStdin: () => '' };

  it('restores a KARST_* key a handler deleted and drops one it added', async () => {
    const surviving = 'KARST_MCP_TEST_SURVIVING';
    const added = 'KARST_MCP_TEST_ADDED';
    process.env[surviving] = 'original';
    delete process.env[added];
    try {
      const runner: McpToolRunner = {
        async run() {
          delete process.env[surviving];
          process.env[added] = 'new';
          return 'handler-out';
        },
      };
      const out = await preservingProcessEnv(runner).run([], {}, io);
      expect(out).toBe('handler-out');
      expect(process.env[surviving]).toBe('original');
      expect(process.env[added]).toBeUndefined();
    } finally {
      delete process.env[surviving];
      delete process.env[added];
    }
  });

  it('restores the environment even when the handler throws', async () => {
    const key = 'KARST_MCP_TEST_THROW';
    process.env[key] = 'original';
    try {
      const runner: McpToolRunner = {
        async run() {
          delete process.env[key];
          throw new Error('boom');
        },
      };
      await expect(preservingProcessEnv(runner).run([], {}, io)).rejects.toThrow('boom');
      expect(process.env[key]).toBe('original');
    } finally {
      delete process.env[key];
    }
  });

  it('is wired into createKarstMcpServer, so a scrub cannot leak to the next call', async () => {
    const key = 'KARST_MCP_TEST_WIRING';
    process.env[key] = 'original';
    const runner: McpToolRunner = {
      async run() {
        delete process.env[key]; // what `servers spin` does to the real process env
        return 'ok';
      },
    };
    const server = createKarstMcpServer({ db: '/db' }, {}, runner);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'env-test', version: '1.0.0' }, { capabilities: {} });
    try {
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      for (const _ of [0, 1]) {
        const result = await client.callTool({ name: 'guide', arguments: {} });
        expect((result.content as Array<{ text: string }>)[0]!.text).toBe('ok');
        expect(process.env[key]).toBe('original');
      }
    } finally {
      await client.close();
      await server.close();
      delete process.env[key];
    }
  });
});
