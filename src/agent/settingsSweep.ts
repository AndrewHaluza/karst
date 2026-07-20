import { readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Housekeeping for the per-port hook-settings files (`writeHookSettings`).
 *
 * The hook endpoint binds an ephemeral port, so every window launch mints a new
 * filename and the old one is never revisited — without a sweep they accumulate
 * in global storage forever.
 *
 * Age, not liveness, is the test: there is no way to ask "is some other window
 * still using this port?" from here, and probing would race. Deleting an old
 * file is safe regardless, because the agent reads `--settings` once at launch
 * and never re-reads it — a live session keeps working after its file is gone.
 */

/** Only files this module's writer produced. The pre-port legacy name is excluded on purpose. */
const HOOK_SETTINGS_RE = /^karst-hooks\.\d+\.settings\.json$/;

/** How stale a hook-settings file must be before it is swept, in days. */
export const DEFAULT_SWEEP_AGE_DAYS = 7;

/**
 * Delete hook-settings files in `dir` last modified more than `maxAgeDays` ago.
 * Returns how many were removed. Never throws: this is best-effort cleanup
 * running during activation, and a failed unlink must not block startup.
 */
export function sweepHookSettings(
  dir: string,
  maxAgeDays: number = DEFAULT_SWEEP_AGE_DAYS,
): number {
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;

  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return 0; // no dir yet (first activation) — nothing to sweep
  }

  let removed = 0;
  for (const name of entries) {
    if (!HOOK_SETTINGS_RE.test(name)) continue;
    const path = join(dir, name);
    try {
      if (statSync(path).mtimeMs >= cutoff) continue;
      unlinkSync(path);
      removed += 1;
    } catch {
      // Raced with another window, or permissions — skip it and move on.
    }
  }
  return removed;
}
