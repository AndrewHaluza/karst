import { runReadiness, type ReadinessInput } from '../setup/readiness/runReadiness.js';
import { computeChecklist } from '../setup/checklist/compute.js';
import type { ChecklistItem } from '../setup/checklist/types.js';
import type { DiscoveryResult } from '../setup/discover.js';
import type { SkipRecord } from '../setup/checklist/types.js';

/**
 * `karst setup checklist` (@arch:CLI-14): the first-setup checklist; it writes nothing,
 * so it runs with or without a setup session. `--format text` renders the block the agent prints to the
 * user; nothing on this verb can mark an item skipped. A skip is a user
 * decision the host records (`setup skip` only asks).
 */

export type ChecklistFormat = 'json' | 'text';

export interface ChecklistSummary {
  todo: number;
  done: number;
  skipped: number;
  requiredTodo: number;
}

export interface ParsedSetupChecklistArgs {
  format: ChecklistFormat;
}

/** Longest `detail` the text block prints for one todo item; a long problem list is cut here. */
export const CHECKLIST_DETAIL_MAX = 120;

export interface ChecklistCommandInput extends ReadinessInput {
  discovery: DiscoveryResult | undefined;
  /** The directory of karst.yml. */
  manifestDir: string;
  /** Host-recorded skips, read from extension storage. */
  skips: readonly SkipRecord[];
  /** Output format; `json` by default, so the checklist loop contract does not change. */
  format?: ChecklistFormat;
}

export function parseSetupChecklistArgs(rest: readonly string[]): ParsedSetupChecklistArgs {
  const [cmd, sub, ...flags] = rest;
  if (cmd !== 'setup' || sub !== 'checklist') {
    throw new Error(`expected 'setup checklist', got '${cmd ?? ''} ${sub ?? ''}'`.trim());
  }
  let format: ChecklistFormat = 'json';
  for (let i = 0; i < flags.length; i += 1) {
    const flag = flags[i] ?? '';
    if (flag !== '--format') throw new Error(`karst setup checklist: unknown argument '${flag}'`);
    const value = flags[i + 1];
    if (value !== 'text' && value !== 'json') {
      throw new Error(`karst setup checklist: --format must be 'text' or 'json', got '${value ?? ''}'`);
    }
    format = value;
    i += 1;
  }
  return { format };
}

/**
 * The block the setup agent prints to the user unchanged, so every core shows
 * the same checklist. ASCII marks only, except the header separator and the
 * `Next:` arrow, which the terminals in use all render.
 */
export function renderChecklistText(
  items: readonly ChecklistItem[],
  summary: ChecklistSummary,
  next: string | null,
): string {
  const lines = [
    `Setup checklist  ${summary.done} of ${items.length} done · ${summary.skipped} skipped · ${summary.requiredTodo} required open`,
  ];
  for (const item of items) {
    if (item.status === 'done') {
      lines.push(`[x] ${item.title}`);
      continue;
    }
    if (item.status === 'skipped') {
      lines.push(`[-] ${item.title}  skipped by you`);
      continue;
    }
    lines.push(`[ ] ${item.title}  ${item.required ? 'required' : 'optional'}`);
    lines.push(`    ${item.detail.slice(0, CHECKLIST_DETAIL_MAX)}`);
  }
  const nextItem = summary.requiredTodo > 0 && next !== null ? items.find((i) => i.code === next) : undefined;
  lines.push(nextItem !== undefined ? `Next: ${nextItem.code} → ${nextItem.tool}` : 'All required items are done.');
  return lines.join('\n');
}

/** JSON `{ok, summary, next, items}` by default; `ok` is true when no required item is `todo`. */
export async function runSetupChecklistCommand(input: ChecklistCommandInput): Promise<string> {
  const report = await runReadiness(input);
  const items = computeChecklist({
    manifest: input.manifest,
    manifestDir: input.manifestDir,
    discovery: input.discovery,
    readiness: report.items,
    skips: input.skips,
  });
  const todo = items.filter((i) => i.status === 'todo');
  const summary: ChecklistSummary = {
    todo: todo.length,
    done: items.filter((i) => i.status === 'done').length,
    skipped: items.filter((i) => i.status === 'skipped').length,
    requiredTodo: todo.filter((i) => i.required).length,
  };
  const next = todo[0]?.code ?? null;
  if ((input.format ?? 'json') === 'text') return renderChecklistText(items, summary, next);
  return JSON.stringify({ ok: summary.requiredTodo === 0, summary, next, items });
}
