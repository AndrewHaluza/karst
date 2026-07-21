import { isSafePhaseName, phaseNameFault } from '../approaches/phaseName.js';

/**
 * Compose the `node <cli> phase <name> --db <db> [--manifest <yml>] --ticket`
 * prefix a workflow step appends a ticket key to (`$ARGUMENTS` in the generated
 * `/karst:<id>` command) to report that the agent has ENTERED that phase.
 *
 * Deliberately the sibling of `composeStageCommand` (`stage.ts`) and shaped the
 * same way: same `node "<cli>"` head, same double-quoting of paths so spaces
 * survive, same trailing `--ticket` so the caller only ever appends the key. The
 * phase name sits where the stage token sits — baked in, one composed command
 * per phase — so the rendered line reads as the command the agent will run.
 *
 * `manifestPath` is optional but load-bearing once several projects share one
 * DB: it names the project the key belongs to. Without it a key two projects
 * both use resolves to whichever row is older, and the mark lands on the wrong
 * board (§8, cross-project misresolution).
 *
 * It lives here rather than in `phase.ts` because that module is the CLI's
 * receiving end; this is the extension's sending end, and the only thing they
 * share is the wire format.
 *
 * Pure (no fs) so it is testable.
 */
export function composePhaseCommand(
  cliEntry: string,
  dbPath: string,
  phaseName: string,
  manifestPath?: string,
): string {
  // Not a third rule — the SAME predicate install uses (`requireWorkflow` →
  // `assertSafePhaseName`) and the CLI re-applies on receipt. Callers pass a
  // name that was already validated at install; this asserts that invariant at
  // the point of interpolation rather than trusting it, so no path that skipped
  // validation can ever reach a command line the agent executes.
  if (!isSafePhaseName(phaseName)) {
    throw new Error(phaseNameFault('phase name', phaseName));
  }
  const q = (s: string): string => `"${s}"`;
  return [
    'node',
    q(cliEntry),
    'phase',
    phaseName,
    '--db',
    q(dbPath),
    ...(manifestPath ? ['--manifest', q(manifestPath)] : []),
    '--ticket',
  ].join(' ');
}
