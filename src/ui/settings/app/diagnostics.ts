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
import type { SettingsSection } from '../sections.js';
import { DEFAULT_START_STATUS } from '../../../workflow/stages/startDefaults.js';

/** A repository field fault resolved to its `name.fieldPath` display key. */
export interface RepoFieldError {
  readonly key: string;
}

/** Strip the `Invalid karst.yml: ` prefix (plus an optional `(path)`) once. */
export function manifestFaultDetail(raw: string | null): string {
  if (!raw) return '';
  return String(raw).replace(/^Invalid karst\.yml(?: \([^)]*\))?:\s*/, '');
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
  // The preset vocabulary lives on its own tab. Matched BEFORE the general list
  // because `agentPresets`/`activeAgentPreset`/`defaultAgentPreset` all start
  // with "agent" and would otherwise fall through to `^agents?`.
  if (/\b(agentPresets|activeAgentPreset|defaultAgentPreset)\b/.test(msg)) return 'presets';
  if (/^uat\b|^review\b/.test(msg)) return 'quality';
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