/**
 * The Autopilot tab's write paths (@arch:SAVE: one page = one manifest key).
 *
 * `SECTION_FIELDS.autopilot` is `['autopilot']`. Every updater builds a NEW
 * block from the current one and the engine defaults, so an absent block never
 * writes a partial object and the draft that the caller holds is not mutated.
 * The defaults are imported from the host module, so the tab shows what the
 * engine uses for an absent key (R-X1).
 */
import {
  DEFAULT_AUTOPILOT_MAX_ATTEMPTS,
  DEFAULT_AUTOPILOT_MAX_ROUNDS,
  type AutopilotConfig,
  type AutopilotPolicy,
} from '../../../../manifest/autopilot.js';
import type { Manifest } from '../../../../manifest/types.js';

export type Update = (draft: Manifest) => Manifest;

/** The block as the tab shows it: the draft's block, or the engine defaults. */
export function autopilotView(draft: Manifest): AutopilotConfig {
  return (
    draft.autopilot ?? {
      enabled: false,
      ci: { policy: 'auto', maxAttempts: DEFAULT_AUTOPILOT_MAX_ATTEMPTS, checks: [] },
      conflicts: { policy: 'auto', maxRounds: DEFAULT_AUTOPILOT_MAX_ROUNDS },
    }
  );
}

function write(patch: (block: AutopilotConfig) => AutopilotConfig): Update {
  return (draft) => ({ ...draft, autopilot: patch(autopilotView(draft)) });
}

/** A whole number from typed text, or `null` when the text is not a number. */
function wholeNumber(text: string): number | null {
  const trimmed = text.trim();
  if (!/^-?\d+$/.test(trimmed)) return null;
  return Number(trimmed);
}

export function setEnabled(enabled: boolean): Update {
  return write((block) => ({ ...block, enabled }));
}

export function setCiPolicy(policy: AutopilotPolicy): Update {
  return write((block) => ({ ...block, ci: { ...block.ci, policy } }));
}

export function setConflictsPolicy(policy: AutopilotPolicy): Update {
  return write((block) => ({ ...block, conflicts: { ...block.conflicts, policy } }));
}

/**
 * An out-of-range number (0, negative) is stored as typed, so the host's
 * validator names the fault and the field shows it. Text that is not a number
 * keeps the last value.
 */
export function setCiMaxAttempts(text: string): Update {
  return (draft) => {
    const value = wholeNumber(text);
    if (value === null) return draft;
    return write((block) => ({ ...block, ci: { ...block.ci, maxAttempts: value } }))(draft);
  };
}

export function setConflictsMaxRounds(text: string): Update {
  return (draft) => {
    const value = wholeNumber(text);
    if (value === null) return draft;
    return write((block) => ({ ...block, conflicts: { ...block.conflicts, maxRounds: value } }))(draft);
  };
}

export function addCheck(name: string): Update {
  const check = name.trim();
  return (draft) => {
    if (check === '' || autopilotView(draft).ci.checks.includes(check)) return draft;
    return write((block) => ({ ...block, ci: { ...block.ci, checks: [...block.ci.checks, check] } }))(draft);
  };
}

export function removeCheck(name: string): Update {
  return write((block) => ({
    ...block,
    ci: { ...block.ci, checks: block.ci.checks.filter((check) => check !== name) },
  }));
}
