import { clean } from './staleGeneratedCi.js';
import { MAX_CI_LOG_CHARS } from './transientCi.js';

/**
 * Base red (T1383, @arch:AP-12): the failing test ids of a CI job log, as a closed, normalized set. A PR check whose ids are
 * all in the ids of a failed develop push run of the same job failed the same way on develop.
 *
 * The log is untrusted data: it is bounded, read as text, and only matched against the three closed patterns below.
 */

/** Prefix of `autopilot_reruns.pattern` for a rebase marker (keyed by the PR run): `base-red:<base>`. */
export const BASE_RED_PREFIX = 'base-red:';
/** Prefix of `autopilot_reruns.pattern` for a wait row (keyed by the develop run): `base-red-wait:<pr run id>`. */
export const BASE_RED_WAIT_PREFIX = 'base-red-wait:';

/** `- <project> <file>::<title>` of `visual-sweep-gate.mjs` (console form, or the backticked comment form). */
const GATE_LINE = /^- `?([\w-]+)`? (\S+?)::(.+)$/;
/** The diff tail of a gate line. The title itself holds `: `, so only these two tails are cut, at the end. */
const GATE_TAIL = /: (?:\d+ pixels\b.*|diff size unavailable)$/;
/** `<n>) [<project>] › <path>:<line>:<col> › … › <leaf>` of the playwright failure list. */
const LIST_LINE = /^\d+\) \[([\w-]+)\] › (\S+?):\d+:\d+ › (.+)$/;
const TAGS = /(?:\s+@\S+)+\s*$/;
const TIMING = /\s+\(\d+(?:\.\d+)?m?s\)\s*$/;
/** `FAIL [|project|] <file> > <name>` of vitest. */
const VITEST_LINE = /^FAIL\s+(?:\|[^|]+\|\s+)?(\S+)\s+>\s+(.+?)(?:\s+\d+(?:\.\d+)?m?s)?$/;

const basename = (path: string): string => path.slice(path.lastIndexOf('/') + 1);

function idOf(line: string): string | null {
  const gate = GATE_LINE.exec(line);
  if (gate) return `${gate[1]} ${basename(gate[2]!)}::${gate[3]!.replace(GATE_TAIL, '').trim()}`;
  const list = LIST_LINE.exec(line);
  if (list) {
    const segments = list[3]!.split(' › ');
    const leaf = segments[segments.length - 1]!.replace(TIMING, '').replace(TAGS, '').trim();
    return `${list[1]} ${basename(list[2]!)}::${leaf}`;
  }
  const vitest = VITEST_LINE.exec(line);
  if (vitest) return `vitest ${vitest[1]} > ${vitest[2]!.trim()}`;
  return null;
}

/** The sorted, unique failing test ids of a job log. Empty when no line matches: the check is then not classified. */
export function extractFailingTestIds(log: string): string[] {
  const tail = log.length > MAX_CI_LOG_CHARS ? log.slice(-MAX_CI_LOG_CHARS) : log;
  const ids = new Set<string>();
  for (const raw of tail.split('\n')) {
    const id = idOf(clean(raw));
    if (id !== null) ids.add(id);
  }
  return [...ids].sort();
}

/** True when the PR set is not empty and every PR id is in the base set. A null base set (no log) is empty. */
export function isBaseRed(prIds: readonly string[], baseIds: readonly string[] | null): boolean {
  if (prIds.length === 0) return false;
  const base = new Set(baseIds);
  return prIds.every((id) => base.has(id));
}

/** A marker of this step (rebase or wait): the transient and no-change steps do not read it. */
export function isBaseRedPattern(pattern: string): boolean {
  return pattern.startsWith(BASE_RED_PREFIX) || pattern.startsWith(BASE_RED_WAIT_PREFIX);
}
