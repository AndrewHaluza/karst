import type { Manifest } from '../../manifest/types.js';
import type { DiscoveryResult } from '../discover.js';
import type { ReadinessItem } from '../readiness/types.js';
import { ITEMS } from './items.js';
import type { ChecklistItem, SkipRecord } from './types.js';

export interface ChecklistInput {
  manifest: Manifest | undefined;
  /** The directory of karst.yml; a relative `repoPath` resolves against it. */
  manifestDir: string;
  discovery: DiscoveryResult | undefined;
  readiness: readonly ReadinessItem[];
  /** Host-recorded user skips; never read from the agent's outbox. */
  skips: readonly SkipRecord[];
}

/** The detail every item carries while karst.yml is missing; the panel shows it once, not nine times. */
export const NO_MANIFEST_DETAIL = 'karst.yml does not exist or does not load';

/**
 * The first-setup checklist. Pure: no I/O. An item is `done` only when its rule
 * finds no open problem, and a rule reads the readiness result, not a tool call.
 */
export function computeChecklist(input: ChecklistInput): ChecklistItem[] {
  const { manifest } = input;
  return ITEMS.map((def): ChecklistItem => {
    const base = { code: def.code, section: def.section, title: def.title, required: def.required, tool: def.tool };
    if (manifest === undefined) {
      const load = input.readiness.find((i) => i.id === 'manifest.load');
      return { ...base, status: 'todo', detail: `${NO_MANIFEST_DETAIL}${load ? ` (${load.detail})` : ''}` };
    }
    const skipped = (target?: string): boolean =>
      input.skips.some((s) => s.code === def.code && (s.target === undefined || s.target === target));
    const { problems, skippedAny } = def.rule({
      manifest,
      manifestDir: input.manifestDir,
      discovered: input.discovery?.repos ?? [],
      readiness: input.readiness,
      skipped,
    });
    if (problems.length > 0 && skipped()) return { ...base, status: 'skipped', detail: 'the user skipped it' };
    if (problems.length > 0) return { ...base, status: 'todo', detail: problems.join('; ') };
    if (skippedAny) return { ...base, status: 'skipped', detail: 'the user skipped it' };
    return { ...base, status: 'done', detail: def.doneDetail };
  });
}
