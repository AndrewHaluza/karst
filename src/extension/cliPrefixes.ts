import * as vscode from 'vscode';
import { join } from 'node:path';
import { type MarkerStage } from '../agent/markerStage.js';
import { composeContextCommand } from '../cli/context.js';
import { composeStageCommand } from '../cli/stage.js';
import { composePhaseCommand } from '../cli/phaseCommand.js';
import { composeGuideCommand } from '../cli/guide.js';
import { composeTestCommand } from '../cli/test/main.js';
import { composeFixBriefCommand } from '../cli/fixBriefCommand.js';
import { composeConflictBriefCommand } from '../cli/conflictBriefCommand.js';
import { composeServersPrefix } from '../cli/serversCommand.js';
import { cliTokensFor, exportedCliEnv, sessionCliEnv, type CliTokens } from '../agent/cliEnv.js';
import { manifestPathOrThrow } from './manifestResolve.js';

/**
 * The two inputs every `buildCli*Prefix` needs: the CLI karst ships
 * (`dist/cli/main.js` inside the extension) and the workspace manifest path.
 * The manifest is BEST-EFFORT on purpose — unresolved means the CLI falls back
 * to an unscoped key lookup rather than the command failing to compose.
 */
export function cliEntryAndManifest(context: vscode.ExtensionContext): {
  cliEntry: string;
  manifestPath: string | undefined;
} {
  let manifestPath: string | undefined;
  try {
    manifestPath = manifestPathOrThrow();
  } catch {
    manifestPath = undefined;
  }
  return { cliEntry: join(context.extensionUri.fsPath, 'dist', 'cli', 'main.js'), manifestPath };
}

/**
 * Compose the `node <cli> context --db <db> --manifest <yml>` prefix the
 * generated `/karst:<id>` command runs to refresh live ticket context. The CLI
 * ships in `dist/cli/main.js`; the manifest path is best-effort (omitted when
 * unresolved — the CLI then renders without the services section).
 */
/**
 * The LITERAL tokens (machine paths) for a karst command, resolved ONCE per
 * composition: the CLI entry, the DB, the best-effort manifest and, when given,
 * the ticket key. `cliTokensFor` swaps in env refs only where the receiving
 * agent's env exported the value; this same object feeds that env
 * (`cliSessionInput`), so the refs and the export can never disagree.
 */
export function cliLiteral(
  context: vscode.ExtensionContext,
  dbPath: string,
  ticketKey?: string,
): CliTokens {
  const { cliEntry, manifestPath } = cliEntryAndManifest(context);
  return {
    cli: cliEntry,
    db: dbPath,
    ...(manifestPath ? { manifest: manifestPath } : {}),
    ...(ticketKey ? { ticket: ticketKey } : {}),
  };
}

/** The `sessionCliEnv` input that exports exactly `lit`. */
export function cliSessionInput(lit: CliTokens): {
  cliEntry: string;
  dbPath: string;
  manifestPath?: string;
  ticketKey?: string;
} {
  return {
    cliEntry: lit.cli,
    dbPath: lit.db,
    ...(lit.manifest ? { manifestPath: lit.manifest } : {}),
    ...(lit.ticket ? { ticketKey: lit.ticket } : {}),
  };
}

/** Tokens for a prompt delivered to an agent launched with `lit` exported. */
export function launchTokens(lit: CliTokens): CliTokens {
  return cliTokensFor(exportedCliEnv(sessionCliEnv(cliSessionInput(lit))), lit);
}

export function buildCliContextPrefix(tok: CliTokens): string {
  return composeContextCommand(tok.cli, tok.db, tok.manifest);
}

/**
 * Compose the `node <cli> stage <stage> pass --db <db> --ticket` prefix a session
 * runs (ticket key appended) to fire the done marker for the stage it is working
 * on. Same CLI entry as context. The manifest rides along so the CLI can tell
 * which project the ticket key belongs to — two projects sharing the DB may
 * legitimately use the same key.
 *
 * `stage` defaults to `impl` — the generated `/karst:<id>` command is written
 * per launch (no install-time generation) and only carries the impl boundary.
 * A live session seed passes the ticket's actual stage, so a resume at `fix`
 * fires `fix pass` instead of the impl marker (which would throw: no impl→? edge from fix).
 */
export function buildCliStagePrefix(tok: CliTokens, stage: MarkerStage = 'impl'): string {
  return composeStageCommand(tok.cli, tok.db, stage, tok.manifest);
}

/**
 * Compose, for one phase name, the `node <cli> phase <name> --db <db> --ticket`
 * prefix a workflow step runs (ticket key appended) to report entering that
 * phase. Same CLI entry and same best-effort manifest as the stage prefix — the
 * manifest is what stops a key two projects share from marking the wrong board.
 *
 * Returned as a function because the phase name is baked into each command, so
 * the renderer needs one per declared phase rather than a single prefix.
 */
export function buildCliPhasePrefix(tok: CliTokens): (phaseName: string) => string {
  return (phaseName: string): string =>
    composePhaseCommand(tok.cli, tok.db, phaseName, tok.manifest);
}

/**
 * Compose the `node <cli> guide` command a session runs to read the agent
 * manual (how Karst works, the flow, the CLI verbs). Same CLI entry as the
 * context/stage/phase prefixes; no DB, no manifest, no ticket — the guide is
 * static karst-authored content.
 */
export function buildCliGuidePrefix(tok: CliTokens): string {
  return composeGuideCommand(tok.cli);
}

/**
 * Compose the `node <cli> --db <db> --manifest <yml> --ticket <key>` prefix the
 * seed's `## Services` block appends each `servers` action to. Returns
 * `undefined` when the manifest path cannot be resolved: `servers
 * list|spin|restart` REFUSE without `--manifest`, so a prefix without it would
 * hand the session commands that throw — no block is better than a broken one.
 *
 * TERMINAL-ONLY: composed solely for an interactive session's launch seed
 * (servers are long-lived and belong to the ticket's terminal), never for a
 * headless prompt. It needs a ticket token too — a headless run's env carries
 * no reliable ticket key — so a token set without one yields `undefined`.
 */
export function buildCliServersPrefix(tok: CliTokens): string | undefined {
  if (!tok.manifest || !tok.ticket) return undefined;
  return composeServersPrefix(tok.cli, tok.db, tok.manifest, tok.ticket);
}

/**
 * Compose the `node <cli> test --db <db> --manifest <yml>` prefix the test-family
 * skill embeds so the agent never composes the `--db`/`--manifest` boilerplate
 * itself. Same CLI entry and best-effort manifest as the other prefixes.
 */
export function buildCliTestPrefix(tok: CliTokens): string {
  return composeTestCommand(tok.cli, tok.db, tok.manifest);
}

/**
 * Compose the `node <cli> fix-brief --db <db> --manifest <yml>` prefix a
 * session's generated fix command runs (ticket key appended) to pull the
 * failing-gate brief. Same CLI entry and best-effort manifest as the other
 * prefixes.
 */
export function buildCliFixBriefPrefix(tok: CliTokens): string {
  return composeFixBriefCommand(tok.cli, tok.db, tok.manifest);
}

/**
 * Compose the `node <cli> conflict-brief --db <db> --manifest <yml>` prefix a
 * session's generated resolve-conflict command runs (ticket key and repo
 * appended) to pull the merge-conflict brief. Same CLI entry and best-effort
 * manifest as the other prefixes.
 */
export function buildCliConflictBriefPrefix(tok: CliTokens): string {
  return composeConflictBriefCommand(tok.cli, tok.db, tok.manifest);
}
