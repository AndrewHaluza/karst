/**
 * Manifest keys the validator ACCEPTS but no code reads (decision D1,
 * `docs/config-ui-coverage.md`). karst keeps parsing and round-tripping them so
 * no existing file breaks and nothing is erased on Save — but it says so at
 * load, because a key that silently does nothing is indistinguishable from a
 * key that is broken.
 *
 * Runs over the RAW parsed object, after `migrateLegacyManifest` and before
 * `validateManifest`: the validator defaults `uat.env` to `{}` and
 * `uat.secrets` to `[]`, so after it runs, "the author wrote this" and "the
 * validator filled it in" cannot be told apart — and only the first deserves a
 * notice. Never throws: a malformed file is the validator's error to report,
 * with its own precise message, and a diagnostic helper must not pre-empt it.
 *
 * When a key gains a consumer, delete it from the list below and delete its
 * annotation in `karst.example.yml`.
 */

/** `uat.*` keys with no consumer. `maxFixAttempts` and `gates` are wired — never list them. */
const INERT_UAT_KEYS = [
  'testDir',
  'env',
  'secrets',
  'passthrough',
  'origins',
  'authBootstrap',
  'author',
] as const;

/** `uat.repositories.<name>.*` keys with no consumer. `gates` is wired per-repo. */
const INERT_UAT_REPO_KEYS = ['env', 'secrets', 'testDir'] as const;

/** `agents.<name>.*` keys with no consumer. Only `enabled` is read. */
const INERT_AGENT_KEYS = ['role', 'command', 'promptPath'] as const;

const INACTIVE = 'declared but not yet active — karst parses these and does not read them yet';

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function uatNotice(raw: Record<string, unknown>): string | undefined {
  const uat = raw.uat;
  if (!isObject(uat)) return undefined;

  const found: string[] = INERT_UAT_KEYS.filter((k) => uat[k] !== undefined).map((k) => `uat.${k}`);

  const repositories = uat.repositories;
  if (isObject(repositories)) {
    for (const [name, override] of Object.entries(repositories)) {
      if (!isObject(override)) continue;
      for (const key of INERT_UAT_REPO_KEYS) {
        if (override[key] !== undefined) found.push(`uat.repositories.${name}.${key}`);
      }
    }
  }

  return found.length ? `${found.join(', ')} — ${INACTIVE}` : undefined;
}

function agentsNotice(raw: Record<string, unknown>): string | undefined {
  const agents = raw.agents;
  if (!isObject(agents)) return undefined;

  // Aggregated across every agent, never one line per agent: a manifest with
  // eight declared agents would otherwise emit eight identical notices.
  const found = new Set<string>();
  for (const def of Object.values(agents)) {
    if (!isObject(def)) continue;
    for (const key of INERT_AGENT_KEYS) {
      if (def[key] !== undefined) found.add(key);
    }
  }
  if (found.size === 0) return undefined;

  const keys = INERT_AGENT_KEYS.filter((k) => found.has(k)).join(', ');
  const required = found.has('role')
    // `role` is required by validateManifest while being read by nothing, so an
    // author is compelled to supply a value that misleads them. Say it outright.
    ? ' (`role` is required by validation despite being unread)'
    : '';
  return `agents.*.${keys} — ${INACTIVE}${required}`;
}

/** Notice lines for every inert key this manifest actually declares. */
export function detectInertKeys(raw: unknown): string[] {
  if (!isObject(raw)) return [];
  const notices: string[] = [];
  const uat = uatNotice(raw);
  if (uat) notices.push(uat);
  const agents = agentsNotice(raw);
  if (agents) notices.push(agents);
  return notices;
}
