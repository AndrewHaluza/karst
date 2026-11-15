import { classifyStaleGeneratedLog } from './staleGeneratedCi.js';

/**
 * A base-moved failure that holds only stale generated files (T1169, D633, @arch:GATE-BASE-MOVED): every failed gate row
 * of the run names `<path> is stale: run <command>` for a command of `ship.regenerate`. The host then rebases and
 * regenerates with no agent round. The gate summary is stored data: it is bounded and only matched, never run.
 */
export interface FailedGateText {
  readonly summary: string | null;
}

/** The regenerate commands the failed gates name, or null when there is no failed gate or any gate fails for another reason. */
export function staleOnlyCommands(failed: readonly FailedGateText[], regenerate: readonly string[]): string[] | null {
  if (failed.length === 0) return null;
  const commands: string[] = [];
  for (const gate of failed) {
    if (gate.summary === null) return null;
    const found = classifyStaleGeneratedLog(gate.summary, regenerate);
    if (found === null) return null;
    for (const command of found) if (!commands.includes(command)) commands.push(command);
  }
  return commands;
}
