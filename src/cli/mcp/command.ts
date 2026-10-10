/**
 * `karst mcp <serve|install>` — the MCP dispatch.
 *
 * `serve` starts the stdio server; `install` prints (or writes) a user-scope
 * config for an agent whose launch karst cannot configure directly. Both live
 * behind the CLI's `runCliAsync`, like `servers`: `serve` never returns, so it
 * cannot use the synchronous `runCli` contract.
 */

import { runCli, runCliAsync, type CliIo } from '../main.js';
import type { McpGlobalFlags } from './config.js';
import { resolveMcpConfig } from './config.js';
import { runMcpInstall } from './installCommand.js';
import { runMcpServe, type McpToolRunner } from './server.js';

/**
 * The real tool runner: a call is the SAME dispatch as a shell call. `servers`
 * and `setup verify` are the async verbs and route through `runCliAsync`;
 * everything else is the synchronous `runCli`, which opens and closes its store
 * per call.
 */
export const defaultMcpRunner: McpToolRunner = {
  async run(argv: string[], env, io: CliIo): Promise<string> {
    if (argv[0] === 'servers' || (argv[0] === 'setup' && argv[1] === 'verify') || argv[0] === 'base') {
      return runCliAsync(argv, env);
    }
    return runCli(argv, env, io);
  },
};

/** Run an `mcp` subcommand. `serve` never resolves. */
export function runMcpCommand(
  rest: readonly string[],
  flags: McpGlobalFlags,
  env: Readonly<Record<string, string | undefined>>,
): Promise<string> {
  const sub = rest[1];
  if (sub === 'serve') {
    return runMcpServe(resolveMcpConfig(flags, env), env, defaultMcpRunner);
  }
  if (sub === 'install') {
    return Promise.resolve(runMcpInstall(rest, flags, env));
  }
  throw new Error(`unknown mcp subcommand '${sub ?? ''}' (want 'serve' or 'install')`);
}
