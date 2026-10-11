import type { AgentAdapter } from './adapter.js';

export type KarstChannel = 'mcp' | 'cli-env';

/**
 * Does this launch get the karst MCP server? ONE predicate shared by the
 * launch-time MCP config writer (`ui/session.ts`) and the seed composer, so
 * the text a session reads and the tools it actually has cannot disagree.
 */
export function launchHasMcp(input: {
  adapter: Pick<AgentAdapter, 'surfaces'>;
  hookChannel: unknown;
  cliEntry?: string | null;
  dbPath?: string | null;
}): boolean {
  return Boolean(
    input.adapter.surfaces?.mcpConfigInteractive?.supported &&
      input.hookChannel &&
      input.cliEntry &&
      input.dbPath,
  );
}

export function channelFor(hasMcp: boolean): KarstChannel {
  return hasMcp ? 'mcp' : 'cli-env';
}
