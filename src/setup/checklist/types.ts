import type { ManifestSection } from '../../manifest/sectionTable.js';

export type ChecklistStatus = 'todo' | 'done' | 'skipped';

/** One thing first setup must configure. `tool` is the typed setup tool that sets it. */
export interface ChecklistItem {
  code: string;
  section: ManifestSection;
  title: string;
  required: boolean;
  status: ChecklistStatus;
  tool: string;
  detail: string;
}

/**
 * A skip the USER approved in the popup. Only the host writes it, in extension
 * storage. `target` names one repository for the per-repository items.
 */
export interface SkipRecord {
  code: string;
  target?: string;
  reason: string;
  at: string;
}
