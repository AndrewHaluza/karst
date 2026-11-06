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
 * Verbs that only `runCliAsync` handles. The synchronous `runCli` throws
 * `unknown command` for them. `runCliAsync` falls through to `runCli(argv)`
 * with no `env` or `io`, so route ONLY these verbs there.
 */
function isAsyncVerb(argv: readonly string[]): boolean {
  const [verb, sub] = argv;
  if (verb === 'setup') return sub === 'verify' || sub === 'check';
  return verb === 'servers' || verb === 'base' || verb === 'stage' || verb === 'artifact' || verb === 'doctor';
}

/**
 * The real tool runner: a call is the SAME dispatch as a shell call. The async
 * verbs (`servers`, `setup verify`, `setup check`, `base`, `stage`, `artifact`,
 * `doctor`) route through `runCliAsync`; everything else is the synchronous
 * `runCli`, which opens and closes its store per call.
 */
export const defaultMcpRunner: McpToolRunner = {
  async run(argv: string[], env, io: CliIo): Promise<string> {
    if (isAsyncVerb(argv)) {
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
