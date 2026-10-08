/**
 * Env vars through which an agent session reaches the karst CLI, so commands
 * handed to the agent read `node "$KARST_CLI" --db "$KARST_DB" ...` instead of
 * embedding machine paths. vscode-free.
 */
export const KARST_CLI_ENV = 'KARST_CLI';
/** Env key pointing the agent at the registry so a `karst guide` pull is attributable. */
export const KARST_DB_ENV = 'KARST_DB';
/** Env key carrying the host-set project id (a positive integer) for `notes --repos`. */
export const KARST_PROJECT_ENV = 'KARST_PROJECT';
/** Env key carrying the workspace manifest path, for `--manifest "$KARST_MANIFEST"`. */
export const KARST_MANIFEST_ENV = 'KARST_MANIFEST';
/** Env key carrying the ticket KEY (e.g. `NDL-7`); distinct from the numeric `KARST_TICKET_ID`. */
export const KARST_TICKET_KEY_ENV = 'KARST_TICKET';
/**
 * Env key carrying the path to the session's instruction file (`instructions.ts`
 * writes it, and the agent reads it). A pointer core reads it on demand; a
 * native-file core never needs it, but it is exported for every launch so the
 * same file is addressable regardless of the core's delivery channel.
 */
export const KARST_INSTRUCTIONS_ENV = 'KARST_INSTRUCTIONS';

/** A double-quoted shell reference to an env var: `"$NAME"`. */
export function envRef(name: string): string {
  return `"$${name}"`;
}

/** Matches a whole token that is exactly one double-quoted env reference. */
const ENV_REF = /^"\$[A-Z_][A-Z0-9_]*"$/;

/**
 * Double-quote a token, unless it is already a quoted env-var reference.
 * A literal is NOT escaped: an embedded `"` or `$` passes through as-is
 * (machine paths never carry them in practice).
 */
export function quoteArg(token: string): string {
  return ENV_REF.test(token) ? token : `"${token}"`;
}

export interface KarstCliEnvInput {
  cliEntry: string;
  dbPath: string;
  manifestPath?: string;
  ticketKey?: string;
  /** Session-dir path to the written instructions file (`KARST_INSTRUCTIONS`). */
  instructionsPath?: string;
}

/** The env entries to export so the refs from `karstCliRefs` resolve. */
export function karstCliEnv(input: KarstCliEnvInput): Record<string, string> {
  const entries: Array<[string, string | undefined]> = [
    [KARST_CLI_ENV, input.cliEntry],
    [KARST_DB_ENV, input.dbPath],
    [KARST_MANIFEST_ENV, input.manifestPath],
    [KARST_TICKET_KEY_ENV, input.ticketKey],
    [KARST_INSTRUCTIONS_ENV, input.instructionsPath],
  ];
  return Object.fromEntries(entries.filter((e): e is [string, string] => e[1] !== undefined));
}

/** The ref token set: `"$KARST_CLI"`, `"$KARST_DB"`, `"$KARST_MANIFEST"`, `"$KARST_TICKET"`. */
export function karstCliRefs(): { cli: string; db: string; manifest: string; ticket: string } {
  return {
    cli: envRef(KARST_CLI_ENV),
    db: envRef(KARST_DB_ENV),
    manifest: envRef(KARST_MANIFEST_ENV),
    ticket: envRef(KARST_TICKET_KEY_ENV),
  };
}

export interface SessionCliEnvInput {
  cliEntry?: string;
  dbPath?: string | null;
  manifestPath?: string;
  ticketKey?: string;
  /** Session-dir path to the written instructions file (`KARST_INSTRUCTIONS`). */
  instructionsPath?: string;
}

/**
 * The CLI env an interactive session exports. `KARST_CLI` and `KARST_DB` go
 * together: without `dbPath` nothing CLI-related is exported (a `"$KARST_CLI"`
 * command would be useless without its `--db`); `dbPath` alone exports only
 * `KARST_DB` (guide-pull attribution), never the manifest/ticket refs.
 *
 * `KARST_INSTRUCTIONS` is independent of the CLI refs — it is a file path the
 * agent reads — so it is exported whenever it is known, even without `dbPath`.
 */
export function sessionCliEnv(
  input: SessionCliEnvInput,
  debug?: (message: string) => void,
): Record<string, string> {
  const { cliEntry, dbPath, manifestPath, ticketKey, instructionsPath } = input;
  const instructions: Record<string, string> = instructionsPath
    ? { [KARST_INSTRUCTIONS_ENV]: instructionsPath }
    : {};
  if (!dbPath) {
    if (cliEntry) debug?.('[agent] session env: cliEntry without dbPath — KARST_CLI not exported');
    return instructions;
  }
  if (!cliEntry) return { [KARST_DB_ENV]: dbPath, ...instructions };
  return karstCliEnv({
    cliEntry,
    dbPath,
    ...(manifestPath ? { manifestPath } : {}),
    ...(ticketKey ? { ticketKey } : {}),
    ...(instructionsPath ? { instructionsPath } : {}),
  });
}

/** Which ref groups an env can resolve. `manifest`/`ticket` imply `cli`. */
export interface ExportedCliEnv {
  cli: boolean;
  manifest: boolean;
  ticket: boolean;
}

/** Read which `karstCliRefs` an env actually resolves. */
export function exportedCliEnv(env: Readonly<Record<string, string | undefined>>): ExportedCliEnv {
  const cli = Boolean(env[KARST_CLI_ENV] && env[KARST_DB_ENV]);
  return {
    cli,
    manifest: cli && Boolean(env[KARST_MANIFEST_ENV]),
    ticket: cli && Boolean(env[KARST_TICKET_KEY_ENV]),
  };
}

export interface CliTokens {
  cli: string;
  db: string;
  manifest?: string;
  ticket?: string;
}

/**
 * The tokens a composed karst command uses for an agent whose env exported
 * `exported`: a ref where the env carries the value, the literal otherwise.
 * `undefined` (a session karst has no export record for — older or revived)
 * → all literal.
 */
export function cliTokensFor(exported: ExportedCliEnv | undefined, literal: CliTokens): CliTokens {
  if (!exported?.cli) return literal;
  const refs = karstCliRefs();
  const manifest = exported.manifest ? refs.manifest : literal.manifest;
  const ticket = exported.ticket ? refs.ticket : literal.ticket;
  return {
    cli: refs.cli,
    db: refs.db,
    ...(manifest !== undefined ? { manifest } : {}),
    ...(ticket !== undefined ? { ticket } : {}),
  };
}
