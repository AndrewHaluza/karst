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

/**
 * `uat.*` keys with no consumer. `maxFixAttempts`, `gates`, `testerVerifier`
 * and `testerObservations` are wired — never list them.
 */
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

/**
 * RETIRED keys: they had a consumer once and no longer do. A different notice
 * from `INACTIVE` on purpose — "not yet" and "not any more" send an author to
 * opposite conclusions, and this one has a replacement to name.
 *
 * `processes.<key>.instructions` was the inline prompt override for `uatTester`
 * and `review`. A process's prompt is now exactly one thing: the body of the
 * agent PROFILE assigned to it (`processes.<key>.agent`, edited in Settings →
 * Agents). Two ways to say the same thing meant the Settings profile a user
 * picked could be silently outranked by a line in the yml they had forgotten,
 * with no surface saying which one was in force.
 */
const RETIRED_PROCESS_KEYS = ['instructions'] as const;

const RETIRED_INSTRUCTIONS =
  'retired — a process is prompted by the body of the agent profile assigned to it ' +
  '(`processes.<key>.agent`, edited in Settings → Agents); this value is no longer read ' +
  'and is dropped the next time Settings saves';

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

/**
 * The retired `processes.<key>.instructions`, aggregated across every process
 * that still declares one — a file that set it on both prompt-bearing roles
 * must not emit the same sentence twice.
 */
function processesNotice(raw: Record<string, unknown>): string | undefined {
  const processes = raw.processes;
  if (!isObject(processes)) return undefined;

  const found = new Set<string>();
  for (const config of Object.values(processes)) {
    if (!isObject(config)) continue;
    for (const key of RETIRED_PROCESS_KEYS) {
      if (config[key] !== undefined) found.add(key);
    }
  }
  if (found.size === 0) return undefined;

  const keys = RETIRED_PROCESS_KEYS.filter((k) => found.has(k)).join(', ');
  return `processes.*.${keys} — ${RETIRED_INSTRUCTIONS}`;
}

/** Notice lines for every inert key this manifest actually declares. */
export function detectInertKeys(raw: unknown): string[] {
  if (!isObject(raw)) return [];
  const notices: string[] = [];
  const uat = uatNotice(raw);
  if (uat) notices.push(uat);
  const agents = agentsNotice(raw);
  if (agents) notices.push(agents);
  const processes = processesNotice(raw);
  if (processes) notices.push(processes);
  return notices;
}
