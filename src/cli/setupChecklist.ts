import { runReadiness, type ReadinessInput } from '../setup/readiness/runReadiness.js';
import { computeChecklist } from '../setup/checklist/compute.js';
import type { DiscoveryResult } from '../setup/discover.js';
import type { SkipRecord } from '../setup/checklist/types.js';

/**
 * `karst setup checklist` (@arch:CLI-21): the first-setup checklist, setup
 * sessions only. It takes NO flag: nothing on this verb can mark an item
 * skipped. A skip is a user decision the host records (`setup skip` only asks).
 */

export interface ChecklistCommandInput extends ReadinessInput {
  discovery: DiscoveryResult | undefined;
  /** Host-recorded skips, read from extension storage. */
  skips: readonly SkipRecord[];
}

export function parseSetupChecklistArgs(rest: readonly string[]): void {
  const [cmd, sub, ...flags] = rest;
  if (cmd !== 'setup' || sub !== 'checklist') {
    throw new Error(`expected 'setup checklist', got '${cmd ?? ''} ${sub ?? ''}'`.trim());
  }
  if (flags.length > 0) throw new Error(`karst setup checklist: unknown argument '${flags[0]}' (it takes no argument)`);
}

/** JSON `{ok, summary, next, items}`; `ok` is true when no required item is `todo`. */
export async function runSetupChecklistCommand(input: ChecklistCommandInput): Promise<string> {
  const report = await runReadiness(input);
  const items = computeChecklist({
    manifest: input.manifest,
    discovery: input.discovery,
    readiness: report.items,
    skips: input.skips,
  });
  const todo = items.filter((i) => i.status === 'todo');
  const summary = {
    todo: todo.length,
    done: items.filter((i) => i.status === 'done').length,
    skipped: items.filter((i) => i.status === 'skipped').length,
    requiredTodo: todo.filter((i) => i.required).length,
  };
  return JSON.stringify({ ok: summary.requiredTodo === 0, summary, next: todo[0]?.code ?? null, items });
}
