/**
 * Error attribution for the settings app — which tab a manifest fault points at,
 * and which single repository field it names.
 *
 * Both were inline-script helpers keyed off the `Invalid karst.yml: ` prefix
 * that `loadManifest` attaches. The prefix comes off exactly once, here; while
 * it was left on, the anchored patterns never matched and the inline
 * repository-field messages silently never appeared.
 *
 * These are DISPLAY concerns layered on top of `validateManifest`'s existing
 * single-fault architecture, not a change to it: `validateManifest` throws on the
 * first fault, so at most one field is ever mappable at a time.
 *
 * Kept separate from `reducer.ts` because nothing here mutates anything — it is
 * the selector half of the state boundary.
 */
import type { Manifest } from '../../../manifest/types.js';
import type { QuotaPatch } from '../messages.js';
import { REVIEW_MAX_FIX_ATTEMPTS } from '../../../manifest/qualityDefaults.js';
import { validateQuota } from '../../../manifest/validate/quota.js';
import type { SettingsSection } from '../sections.js';
import { evidenceErrors, readStallDetection, stallErrors } from './sections/qualityDraft.js';
import { DEFAULT_START_STATUS } from '../../../workflow/stages/startDefaults.js';

/** A repository field fault resolved to its `name.fieldPath` display key. */
export interface RepoFieldError {
  readonly key: string;
}

/**
 * Strip the file prefix (plus an optional `(path)`) once.
 *
 * `loadManifest` has shipped two shapes: `Invalid karst.yml: …` from the
 * validator and a bare `karst.yml: repositories[1] …` from load-time refusals.
 * Both describe the FILE, not a field, so the display layer must not show the
 * prefix as if it were part of the fault (SET-5).
 */
export function manifestFaultDetail(raw: string | null): string {
  if (!raw) return '';
  return String(raw).replace(/^(?:Invalid )?karst\.yml(?: \([^)]*\))?:\s*/, '');
}

/** Short field text for a manifest path whose host fault is long; other paths show the host text. */
const FIELD_MESSAGES: Readonly<Record<string, string>> = {
  'autopilot.conflicts.maxRounds': 'Enter a whole number of at least 1.',
  'autopilot.ci.maxAttempts': 'Enter a whole number of at least 1.',
};

/** The Settings tab that renders each inline-mapped field (SET-6). */
const FIELD_OWNER: Readonly<Record<string, SettingsSection>> = {
  'autopilot.conflicts.maxRounds': 'autopilot',
  'autopilot.ci.maxAttempts': 'autopilot',
};

/**
 * Whether `raw` is already shown inline on `section` (SET-6, UI-R25).
 *
 * The field-level message under the control is the better place for a fault the
 * section itself renders; repeating it in the top banner is noise on a page the
 * user is already looking at.
 */
export function hasInlineFieldFault(raw: string | null, section: SettingsSection): boolean {
  for (const [path, owner] of Object.entries(FIELD_OWNER)) {
    if (owner === section && fieldFaultFor(raw, path) !== undefined) return true;
  }
  return false;
}

/**
 * Upsert a partial `quota:` block onto a manifest (Q4-SAVE).
 *
 * Shared by the reducer's `quota-saved` case: the Accounts tab saves at once, so
 * the patch has to land on BOTH the draft and the baseline — otherwise the next
 * unrelated Agents Save would write the old threshold back.
 *
 * The merge goes through the SAME `validateQuota` the host runs (R-X1: import
 * the rule, never mirror it). `validateManifest` always resolves
 * `quota.warnThresholdPct` (default 80) even when the file has no `quota:`
 * block, and the host's `state` pushes that validated manifest. The draft and
 * baseline must therefore carry the same RESOLVED block, not an absent one —
 * clearing the only key used to leave the input blank until the next state push
 * snapped it back to the default.
 */
export function applyQuotaPatch(manifest: Manifest, patch: QuotaPatch): Manifest {
  const nextQuota: Record<string, unknown> = { ...(manifest.quota ?? {}) };
  for (const key of ['warnThresholdPct', 'claudeGlobalStatusline', 'claudeOauthUsageApi'] as const) {
    if (!Object.hasOwn(patch, key)) continue;
    const value = patch[key];
    if (value === null) delete nextQuota[key];
    else nextQuota[key] = value;
  }
  const next = { ...manifest } as Record<string, unknown>;
  next.quota = validateQuota(nextQuota);
  return next as unknown as Manifest;
}

/**
 * Local (webview-side) validation errors per tab (SET-4 + SET-12).
 *
 * The host only ever reports the FIRST fault it finds, and while the user is
 * editing a Quality field the host has not seen the draft yet — so the shell
 * cannot say how many fields are wrong from `validation.error` alone. These are
 * the same rules the Quality tab shows beside its own controls (`qualityDraft`),
 * counted per field, and only for the tab that has them.
 */
export function localFieldErrors(draft: Manifest): Partial<Record<SettingsSection, number>> {
  const stall = stallErrors(
    readStallDetection(draft),
    draft.review?.maxFixAttempts ?? REVIEW_MAX_FIX_ATTEMPTS,
  );
  let quality = 0;
  if (stall.sameFileRounds) quality += 1;
  if (stall.repeatedFindingRounds) quality += 1;
  const evidence = draft.uat?.testerObservations?.requireEvidence;
  if (evidence) {
    const errors = evidenceErrors(evidence);
    if (errors.file) quality += 1;
    if (errors.whenChanged) quality += 1;
  }
  return quality === 0 ? {} : { quality };
}

/** The first tab (in nav order) holding a local field error, or null. */
export function firstSectionWithLocalError(
  errors: Partial<Record<SettingsSection, number>>,
  order: readonly SettingsSection[],
): SettingsSection | null {
  for (const section of order) {
    if ((errors[section] ?? 0) > 0) return section;
  }
  return null;
}

/** The message to show under the field `path`, or undefined when the fault is for another path. */
export function fieldFaultFor(raw: string | null, path: string): string | undefined {
  const detail = manifestFaultDetail(raw);
  if (!detail || !detail.startsWith(path)) return undefined;
  return FIELD_MESSAGES[path] ?? detail;
}

/**
 * The one repository field a `ManifestError` names, if any.
 *
 * Order matters: the repository/convention forms embed field names the general
 * test would also match (`repository "api".baselineBranch`), so the qualified
 * prefixes are decided first and the bare field names last.
 */
export function parseRepoFieldError(raw: string | null): RepoFieldError | null {
  const msg = manifestFaultDetail(raw);
  if (!msg) return null;
  let m = msg.match(/^repository "([^"]+)"\.(repoPath|baselineBranch)\b/);
  if (m) return { key: `${m[1]}.${m[2]}` };
  m = msg.match(/^repository "([^"]+)" service\.docker\.(image|containerPort)\b/);
  if (m) return { key: `${m[1]}.docker.${m[2]}` };
  m = msg.match(/^repository "([^"]+)" service\.(start|health)\b/);
  if (m) return { key: `${m[1]}.${m[2]}` };
  m = msg.match(/^repository "([^"]+)" service\.portRange\b/);
  if (m) return { key: `${m[1]}.portRange` };
  m = msg.match(/^repository "([^"]+)" service\.ports\[(\d+)\]\.(name|env|default)\b/);
  if (m) return { key: `${m[1]}.ports.${m[2]}.${m[3]}` };
  // A per-repo convention fault: map it to the repo card's override control (the
  // `conventions.` prefix distinguishes it from the global Git-tab fault).
  m = msg.match(
    /^repository "([^"]+)" conventions\.(commitMessage|pullRequestTitle|pullRequestDescription)\b/,
  );
  if (m) return { key: `${m[1]}.${m[2]}` };
  return null;
}

/**
 * Whether the error banner should be visible for `raw`.
 *
 * A mapped error stays silent (no banner, no highlight) until the user has
 * touched that exact field — that is what stops a freshly added repository from
 * showing an error before anyone has typed anything. An error that does not map
 * to one field always shows, because there is no better place for it.
 */
export function shouldShowBanner(raw: string | null, touched: readonly string[]): boolean {
  const parsed = parseRepoFieldError(raw);
  if (!parsed) return Boolean(raw);
  return touched.includes(parsed.key);
}

/**
 * The tab a fault belongs to, for the nav marker and the banner prefix. Display
 * only — `validateManifest` stays the authority on WHETHER the manifest is
 * valid; this decides where to point. An unmatched message returns `null` and is
 * shown unattributed rather than blamed on a wrong tab.
 */
export function sectionForError(raw: string | null): SettingsSection | null {
  const msg = manifestFaultDetail(raw);
  if (!msg) return null;
  if (/^repositor(y|ies)\b/.test(msg)) return 'services';
  if (/^conventions\b|\bconventions\./.test(msg)) return 'git';
  if (/^ticketing\b/.test(msg)) return 'ticketing';
  if (/\bapproach(es)?\b/.test(msg)) return 'approaches';
  if (/^agents?\b/.test(msg)) return 'agents';
  if (/^processes\b/.test(msg)) return 'agents';
  // The preset vocabulary lives on the Agents page too.
  if (/\b(agentPresets|activeAgentPreset|defaultAgentPreset)\b/.test(msg)) return 'agents';
  if (/^uat\b|^review\b/.test(msg)) return 'quality';
  if (/^autopilot\b/.test(msg)) return 'autopilot';
  if (/^(host|portRange|baselineBranch|ticketLabelTemplate|agentProvider)\b/.test(msg)) {
    return 'general';
  }
  return null;
}

/**
 * The start-of-work status a freshly fetched status list defaults to: the one
 * literally named "in progress" when the provider has it, else the first.
 *
 * `DEFAULT_START_STATUS` is IMPORTED from the workflow source rather than
 * mirrored here (UI-R34 / R-X1). `start.ts` itself pulls in `store/db.js`
 * (better-sqlite3) and cannot be bundled for a webview, so the constant lives in
 * the browser-safe `startDefaults.ts` and `start.ts` re-exports it — one
 * definition, two importers, no mirror.
 */
export function pickDefaultStartStatus(names: readonly string[]): string | undefined {
  const match = names.find((n) => n.trim().toLowerCase() === DEFAULT_START_STATUS);
  return match ?? names[0];
}