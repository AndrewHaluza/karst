/**
 * Connection facts for `karst mcp serve`.
 *
 * The server is a long-lived process the extension starts alongside an agent
 * session; unlike the one-shot CLI it cannot be handed its registry path inside
 * every argv, so it resolves `--db`/`--manifest`/`--ticket` ONCE at startup from
 * its own spawn flags (the `mcp serve` argv) or, exactly like the CLI's agents
 * do today, from the `KARST_*` environment (`src/agent/cliEnv.ts`). The outbox
 * path for `draft propose` is env-only (`KARST_OUTBOX`).
 *
 * Resolution is deliberately FLAG-FIRST: an explicit spawn flag wins over an
 * inherited env value, so a launch can point the server at a different ticket
 * than the ambient shell.
 */

import {
  KARST_DB_ENV,
  KARST_MANIFEST_ENV,
  KARST_TICKET_KEY_ENV,
} from '../../agent/cliEnv.js';

/** Env key naming the planning outbox directory (`draft propose` writes here). */
export const KARST_OUTBOX_ENV = 'KARST_OUTBOX';

/** The global flags `mcp serve` accepts (parsed by `main.ts`'s `parseGlobalFlags`). */
export interface McpGlobalFlags {
  readonly db?: string;
  readonly manifest?: string;
  readonly ticket?: string;
}

/** The resolved per-call connection facts. Any field may be absent. */
export interface McpServerConfig {
  readonly db?: string;
  readonly manifest?: string;
  readonly ticket?: string;
  readonly outbox?: string;
}

/** Flag first, then the inherited `KARST_*` env — the CLI's env-ref contract. */
export function resolveMcpConfig(
  flags: McpGlobalFlags,
  env: Readonly<Record<string, string | undefined>>,
): McpServerConfig {
  return {
    ...(flags.db ?? env[KARST_DB_ENV] ? { db: flags.db ?? env[KARST_DB_ENV] } : {}),
    ...(flags.manifest ?? env[KARST_MANIFEST_ENV]
      ? { manifest: flags.manifest ?? env[KARST_MANIFEST_ENV] }
      : {}),
    ...(flags.ticket ?? env[KARST_TICKET_KEY_ENV]
      ? { ticket: flags.ticket ?? env[KARST_TICKET_KEY_ENV] }
      : {}),
    ...(env[KARST_OUTBOX_ENV] ? { outbox: env[KARST_OUTBOX_ENV] } : {}),
  };
}

/**
 * The env the in-process handler dispatch runs with: the server's own env, with
 * the resolved config overlaid as the `KARST_*` keys the CLI reads directly
 * (`KARST_TICKET` is the message/inbox identity cross-check; `KARST_OUTBOX` is
 * where `draft propose` writes). Overlaying here — rather than requiring every
 * spawn to re-export them — is what keeps `message`/`inbox`/`draft` working when
 * the server was started from explicit flags alone.
 */
export function dispatchEnv(
  config: McpServerConfig,
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string | undefined> {
  return {
    ...env,
    ...(config.db ? { [KARST_DB_ENV]: config.db } : {}),
    ...(config.manifest ? { [KARST_MANIFEST_ENV]: config.manifest } : {}),
    ...(config.ticket ? { [KARST_TICKET_KEY_ENV]: config.ticket } : {}),
    ...(config.outbox ? { [KARST_OUTBOX_ENV]: config.outbox } : {}),
  };
}
