/**
 * Ratchet ledger for the visual screenshot sweep (`@ui:RUNNING-SWEEP`), the
 * screenshot counterpart of the layout ledger (`@ui:LAYOUT-SANITY`).
 *
 * tests/visual/visual-known-failures.json is the only exemption for a red
 * screenshot. A failure that it does not list fails the gate, on a pull request
 * and on a push to develop. An entry whose test passes, or no longer exists,
 * is stale and fails the gate too, so the ledger only shrinks. Stale entries
 * are judged ONLY on a full run: a scoped run does not run every screenshot, so
 * it cannot tell a stale entry from one it did not run. The prune refuses
 * without a full, authoritative (docker) run.
 *
 * Pure functions plus the file read; scripts/visual-sweep-gate.mjs and
 * scripts/dockerGate.mjs own the report parsing and the env reads.
 */
import { readFileSync } from 'node:fs';

/** The committed ledger, repo-relative. */
export const LEDGER_REL = 'tests/visual/visual-known-failures.json';

/** Identity of one screenshot test: `<project>|<spec file>::<title>`. */
export function ledgerKey({ project, file, title }) {
  return `${project ?? ''}|${file ?? ''}::${title}`;
}

/** The ledger entries of `text`. Throws (naming `source`) on anything but an array of unique, non-empty strings. */
export function parseLedger(text, source) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`${source} is not valid JSON: ${err.message}`);
  }
  if (!Array.isArray(parsed) || parsed.some((key) => typeof key !== 'string' || key === '')) {
    throw new Error(`${source} must be a JSON array of non-empty strings`);
  }
  if (new Set(parsed).size !== parsed.length) throw new Error(`${source} lists an entry more than once`);
  return parsed;
}

/** The ledger at `path`. A missing file THROWS: the gate must not fall back to an empty exemption list. */
export function readLedger(path) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    throw new Error(`cannot read the visual ledger ${path}: ${err.message}`);
  }
  return parseLedger(text, path);
}

/** The file text for `keys`: sorted, unique, one entry per line. */
export function serializeLedger(keys) {
  const sorted = Array.from(new Set(keys)).sort();
  return sorted.length === 0 ? '[]\n' : `${JSON.stringify(sorted, null, 2)}\n`;
}

/**
 * Judge a run against the ledger. `statuses` maps each screenshot key of the
 * report to its Playwright outcome (`expected`, `unexpected`, `flaky`, `skipped`).
 *
 * - `unexpected`: failures the ledger does not list (blocking).
 * - `known`: failures the ledger lists (reported).
 * - `flaky`: un-ledgered screenshots that passed on retry (reported; a ledgered flaky one keeps its entry).
 * - `stale`: on a full run only, entries whose test passed or is absent from the report.
 */
export function judgeLedger({ statuses, ledger, fullRun }) {
  const listed = new Set(ledger);
  const unexpected = [];
  const known = [];
  const flaky = [];
  for (const [key, status] of statuses) {
    if (status === 'unexpected') (listed.has(key) ? known : unexpected).push(key);
    else if (status === 'flaky' && !listed.has(key)) flaky.push(key);
  }
  const stale = fullRun ? ledger.filter((key) => !statuses.has(key) || statuses.get(key) === 'expected') : [];
  return { unexpected, known, stale, flaky };
}

/** Removes the stale entries only; never adds. Refuses unless the run is authoritative and full. */
export function pruneLedger({ statuses, ledger, guard }) {
  if (!guard.authoritative) {
    throw new Error('visual ledger prune refused: run it via npm run -s test:visual:docker:prune (KARST_VISUAL_AUTHORITATIVE=1)');
  }
  if (!guard.fullRun) {
    throw new Error('visual ledger prune refused: the run was partial; run the whole sweep (no grep, no narrowed repeat pass)');
  }
  const stale = new Set(judgeLedger({ statuses, ledger, fullRun: true }).stale);
  return ledger.filter((key) => !stale.has(key));
}

/** The entries `head` adds to `base`. Null `base` (no ledger yet) adds nothing: that change creates the ledger. */
export function ledgerGrowth(base, head) {
  if (base === null) return [];
  const before = new Set(base);
  return head.filter((key) => !before.has(key));
}
