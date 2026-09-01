/**
 * `parseFindings` — the boundary between an agent's raw review output and
 * `review_findings` (`store/reviewFindings.ts`). This is the one place in the
 * findings lane that reads text a model wrote about a diff it did not
 * necessarily understand, prompted by ticket content the model did not
 * necessarily author honestly. Everything downstream — the aggregate's R6,
 * the fix brief, `karst context` — trusts whatever this function returns, so
 * every field is validated here and nowhere else.
 *
 * **Reading shape.** Same whole-document-JSON-then-JSONL read `agent/cliFailure.ts`
 * (`extractStructured`) and `agent/tokenUsage.ts` (`events`) already use for
 * other provider output: try the whole trimmed document as one JSON value
 * first, and only fall back to splitting on lines when that fails, because
 * the interesting content is rarely on line 1 of a JSONL stream. A value is
 * accepted from either shape: a bare array of finding objects, an object
 * carrying a `findings` array, or (for a JSONL stream where each line is one
 * finding) a bare finding object itself. Every candidate JSON value —
 * however it parsed — is scanned; nothing is dropped for landing on line 2
 * instead of line 1. …and only when NEITHER shape reads does it fall back to
 * extraction: every ```-fenced block's body first, then every balanced
 * top-level `[...]`/`{...}` span, each still handed to `JSON.parse`. A
 * chat-tuned core that narrates its tool calls before printing the array it
 * was asked for is the ordinary case, not the exotic one — reading that as
 * zero findings turned a `high` finding into a silent pass.
 *
 * **Trust boundaries enforced here, each independently:**
 * - `severity` must be an exact member of the closed `Severity` union
 *   (`manifest/types.ts`). An unrecognized value — including a case
 *   mismatch like `"CRITICAL"` — drops the finding. This is deliberately
 *   different from `store/reviewFindings.ts`'s `parseSeverity`, which
 *   degrades an unreadable *row* to `'info'`: that function is guarding
 *   against a row corrupted after this one wrote it (fail open, since the
 *   writer is trusted); this one is guarding against a model that said
 *   something we do not understand (fail closed, since the writer is not).
 * - `file` must be a string with no control character, contain no `..` path
 *   segment, not be absolute, and resolve inside `ctx.worktreePath` once
 *   joined to it. A control character (including a newline or NUL) is
 *   rejected outright — unlike prose, a path containing one is not a path
 *   that could have been meant, and an unescaped newline would forge extra
 *   rows in any line-oriented rendering of `file`. Any rejection — traversal,
 *   an absolute path, a control character, a non-string value — does NOT
 *   drop the finding: the finding's text can still be true even when its
 *   claimed location cannot be trusted, so only the location is discarded
 *   (`file: null`). Rejections are counted, never logged one at a time, and
 *   folded into a single aggregate warning per `parseFindings` call — a
 *   hostile document that pads every finding with a bad `file` must not be
 *   able to turn one call into thousands of log lines.
 * - `line` must be a finite, positive integer. Anything else (0, negative,
 *   a float, a non-number) nulls the line — not the whole finding, for the
 *   same reason a bad `file` does not: a line number is refinement of a
 *   location, and a bad refinement should not erase good evidence. A line is
 *   also forced to null whenever its `file` was rejected — `line: null`
 *   means "whole file" everywhere else this schema is read, and a line
 *   number pointing at a location we just discarded has nothing left to
 *   refer to.
 * - `title`/`detail` are collapsed to one line and capped via
 *   `model/diagnosticText.ts`'s `collapseDiagnostic` — the same shared
 *   collapse-then-cap every other piece of untrusted CLI/model prose in this
 *   codebase goes through before reaching a rendered surface, which also
 *   strips control/ANSI/bidi-override characters before collapsing
 *   whitespace. A finding with no usable `title` is dropped (nothing to
 *   show); a missing `detail` defaults to `''` rather than dropping the
 *   finding, since a title alone can still be actionable.
 * - `repo` is NEVER read from the model's output. It is always `ctx.repo` —
 *   the target this invocation was scoped to. A model claiming its own
 *   finding belongs to a different repository would let one target's output
 *   attribute evidence to another target's ticket state.
 *
 * **Failure shape.** Unparseable input (prose, garbage, a truncated stream)
 * returns `[]` and never throws — a model that answered in prose instead of
 * JSON is an ordinary outcome for this boundary, not an exceptional one. But
 * it is logged as "nothing recognized", distinctly from the silent `[]` a
 * genuinely empty result (`[]`, `{"findings":[]}`) produces — the two must
 * not look identical in the logs, or a parse failure reads as "the model
 * found nothing" forever. The same distinction holds one layer deeper: a
 * document that parses as JSON but never carries a findings-shaped container
 * anywhere (findings nested an extra level, a provider's own output-format
 * envelope) also warns rather than silently returning `[]` — an explicit
 * empty container (`[]`, `{"findings":[]}`) stays silent, since that IS a
 * clean review.
 *
 * That log-level distinction used to be the only place it existed — every
 * caller still got back a bare `Finding[]`, so "the model answered `[]`, a
 * clean review" and "we could not read the model's answer at all" were the
 * same array to code that never looks at logs. That is exactly how a `high`
 * finding once rendered as "0 observations" and a review passed green on
 * nothing. `parseFindingsResult` makes the distinction load-bearing instead
 * of cosmetic, returning a `FindingsParseShape` alongside the array:
 * `'unreadable'` when no JSON was found at all, or JSON was found but no
 * findings-shaped container was ever recognized in it; `'empty'` when a
 * container WAS recognized and legitimately held nothing, OR held only
 * findings that failed validation (a model that answered badly is not a
 * model whose answer we could not read); `'parsed'` when at least one
 * finding survived. `parseFindings` stays a thin wrapper returning just the
 * `findings` array, unchanged, for callers that do not need the shape.
 * Exceeding `ctx.max` truncates and logs the drop count for
 * the same reason: a silent truncation reads as "that was all of them" — and
 * the kept `max` are chosen by severity (critical first, stable within a
 * rank), not by document order, so attacker-controlled ordering cannot push
 * a real `critical` past the cap by padding the document with low-severity
 * noise ahead of it.
 *
 * No filesystem or network I/O happens here (mirrors `cliFailure.ts` /
 * `tokenUsage.ts`): `ctx.worktreePath` is used only for lexical path
 * resolution (`node:path`), never `existsSync`/`readFileSync`/a `realpath`
 * call. A worktree path that is itself a symlink into somewhere unexpected,
 * or a `file` segment that names a symlink on disk once actually resolved,
 * is not something this function can see — see the task report for that
 * residual.
 */

import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { Severity } from '../../manifest/types.js';
import type { FindingInput, FindingSource } from '../../store/reviewFindings.js';
import { collapseDiagnostic } from '../../model/diagnosticText.js';

/** One finding as parsed — the exact shape `recordFindings`'s batch needs. */
export type Finding = FindingInput;

export interface ParseFindingsContext {
  /** The target this invocation was scoped to. Findings are ALWAYS attributed here — never to whatever the model's own output claims. */
  repo: string;
  /** The repo's own worktree root; `file` must resolve inside it. */
  worktreePath: string;
  /** Findings beyond this count are truncated (and the truncation logged). */
  max: number;
}

/** How a dropped/truncated event reaches the log. Defaults to `console.warn` — the real host binds this to its `Logger`. */
export type WarnFn = (message: string) => void;

const defaultWarn: WarnFn = (message) => console.warn(message);

/** Bound on a finding's `title` — short enough to render as a single line in a list. */
const TITLE_MAX = 200;

/** Bound on a finding's `detail`. Matches `model/diagnosticText.ts`'s shared bound for untrusted prose reaching a rendered surface. */
const DETAIL_MAX = 8_000;

const SEVERITIES: readonly Severity[] = ['critical', 'high', 'medium', 'low', 'info'];

const AGENT_SOURCE: FindingSource = 'agent';

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `JSON.parse`, sentinel-returning rather than throwing — `undefined` means "did not parse". */
function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * Every value that parsed as JSON out of `text`, trying the whole document
 * first and falling back to one-value-per-line — the same shape
 * `agent/tokenUsage.ts`'s `events()` and `agent/cliFailure.ts`'s
 * `extractStructured()` use, generalized to keep non-object JSON values
 * (arrays, bare strings, `null`) instead of discarding them, since a bare
 * array of findings is exactly the shape review's own `--output-format json`
 * prompt asks the agent for.
 */
/**
 * Bound on how much of a raw response the balanced scan will walk. A core that
 * streams tens of MB of tool narration must not turn one parse into a
 * quadratic scan; past this bound only the TAIL is scanned, because the report
 * a model is asked for is the last thing it writes.
 */
const SCAN_MAX_CHARS = 2_000_000;

/**
 * Bound on how many findings-shaped values the extraction fallback will keep
 * once a candidate has actually parsed via `JSON.parse`. This is the real
 * "nothing is dropped" budget: it is spent only on values that parsed, so
 * noise that never parses (prose fragments, tool-output fragments that merely
 * look bracketed) costs nothing against it and cannot push the real report
 * out of the window.
 */
const SCAN_MAX_CANDIDATES = 64;

/**
 * Safety bound on how many raw candidate substrings a single scan will ever
 * collect, independent of whether any of them parse. This exists only so a
 * pathological document (thousands of bracket-looking fragments) cannot grow
 * an unbounded array before `JSON.parse` even runs — it is not the "nothing
 * is dropped" budget; `SCAN_MAX_CANDIDATES` (spent on parsed values) is.
 */
const SCAN_MAX_SPANS = 10_000;

/**
 * Every ```-fenced block's body, in document order. A fence is the shape a
 * chat-tuned core reaches for even when told not to, and its body is exact —
 * so it is tried before the heuristic bracket scan below.
 */
function fencedBlocks(text: string): string[] {
  const blocks: string[] = [];
  const fence = /```[ \t]*[A-Za-z0-9_-]*[ \t]*\r?\n([\s\S]*?)```/g;
  for (const match of text.matchAll(fence)) {
    const body = match[1];
    if (body !== undefined) blocks.push(body);
    if (blocks.length >= SCAN_MAX_SPANS) break;
  }
  return blocks;
}

/**
 * Balanced `[...]` / `{...}` substrings of `text`, scanning top-level opens
 * only (a nested brace inside an accepted span is never a second candidate).
 * String literals and their escapes are tracked so a bracket inside a JSON
 * string never closes a span. This is a LEXICAL scan, not a parser: every
 * candidate it yields is still handed to `JSON.parse`, and a candidate that
 * does not parse is simply skipped.
 */
function balancedSpans(text: string): string[] {
  const spans: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  let opener = '';
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      if (depth > 0) inString = true;
      continue;
    }
    if (ch === '[' || ch === '{') {
      if (depth === 0) {
        start = i;
        opener = ch;
      }
      depth += 1;
      continue;
    }
    if (ch === ']' || ch === '}') {
      if (depth === 0) continue;
      depth -= 1;
      if (depth === 0 && start >= 0) {
        const closesOpener = (opener === '[' && ch === ']') || (opener === '{' && ch === '}');
        if (closesOpener) spans.push(text.slice(start, i + 1));
        start = -1;
        if (spans.length >= SCAN_MAX_SPANS) break;
      }
    }
  }
  return spans;
}

function parseJsonEvents(text: string): unknown[] {
  const trimmed = text.trim();
  if (trimmed === '') return [];

  const whole = tryParseJson(trimmed);
  if (whole !== undefined) return [whole];

  const values: unknown[] = [];
  for (const line of trimmed.split(/\r?\n/)) {
    const lineTrimmed = line.trim();
    if (lineTrimmed === '') continue;
    const value = tryParseJson(lineTrimmed);
    if (value !== undefined) values.push(value);
  }
  if (values.length > 0) return values;

  // Neither shape read: the document is prose with JSON somewhere inside it —
  // the ordinary answer from a chat-tuned core that narrates its work before
  // printing the report it was asked for. Fences first (exact), then the
  // balanced scan (heuristic); every candidate still goes through JSON.parse.
  const scanned =
    trimmed.length > SCAN_MAX_CHARS ? trimmed.slice(trimmed.length - SCAN_MAX_CHARS) : trimmed;
  const candidates = [...fencedBlocks(scanned), ...balancedSpans(scanned)];
  const extracted: unknown[] = [];
  for (const candidate of candidates) {
    const value = tryParseJson(candidate.trim());
    if (value !== undefined) {
      extracted.push(value);
      if (extracted.length >= SCAN_MAX_CANDIDATES) break;
    }
  }
  return extracted;
}

/** One parsed JSON value's contribution: candidates, and whether a findings-shaped container was recognized at all (independent of whether it was empty). */
interface FindingCandidates {
  candidates: unknown[];
  /** True if this value WAS a findings-shaped container — a bare array, a `findings` array, or a bare finding object — even if it carried zero findings. False if the container shape itself was never recognized (e.g. findings nested one level deeper than expected, or a provider envelope). */
  recognized: boolean;
}

/**
 * The finding-shaped candidates carried by one parsed JSON value: a bare
 * array of findings, an object's `findings` array, or (a JSONL line that is
 * itself one finding) the object alone. Anything else — a number, a bare
 * string, `null`, an object with neither shape — contributes nothing, and is
 * reported as unrecognized so the caller can tell "found nothing" apart from
 * "couldn't find the findings".
 */
function findingCandidatesFrom(value: unknown): FindingCandidates {
  if (Array.isArray(value)) return { candidates: value, recognized: true };
  if (isPlainRecord(value)) {
    const nested = value['findings'];
    if (Array.isArray(nested)) return { candidates: nested, recognized: true };
    if ('severity' in value || 'title' in value) return { candidates: [value], recognized: true };
  }
  return { candidates: [], recognized: false };
}

function parseSeverityStrict(raw: unknown): Severity | null {
  return typeof raw === 'string' && (SEVERITIES as readonly string[]).includes(raw)
    ? (raw as Severity)
    : null;
}

/** A count is a finite, positive integer — 0, negative, a float, or a non-number is not a line. */
function parseLine(raw: unknown): number | null {
  return typeof raw === 'number' && Number.isFinite(raw) && Number.isInteger(raw) && raw > 0
    ? raw
    : null;
}

/** A rejected `file`, kept ONLY for the caller to fold into one aggregate warning — never logged individually (a hostile document can carry thousands of these). */
interface FileRejection {
  readonly sample: string;
}

/** `file` result: either a trusted in-worktree relative path, or a rejection sample the caller aggregates. */
type FileResolution = { readonly file: string; readonly rejection?: undefined } | { readonly file: null; readonly rejection?: FileRejection };

/**
 * C0 controls, DEL and the C1 range — a legal path segment never needs one, and
 * a newline in particular would forge extra rows in any line-oriented rendering
 * of `file`.
 *
 * C1 (0x80-0x9F) is included to match the range `model/diagnosticText.ts` strips
 * from `title`/`detail`: `file` is rendered beside them, so the narrower range
 * would have left one field accepting bytes its neighbours reject. NEL (0x85) is
 * a line break to some consumers, which is the same forging risk as `\n`.
 */
const CONTROL_CHAR = /[\x00-\x1f\x7f-\x9f]/;

/**
 * Validate a reported `file`. `undefined`/`null`/`''` is "not file-scoped" —
 * an ordinary, unlogged outcome. Anything present but untrustworthy (a
 * non-string, an absolute path, a `..` segment, a control character, a path
 * that resolves outside `ctx.worktreePath` once joined to it) is rejected —
 * reported back as a `rejection` for the caller to aggregate into one
 * warning, and the finding is kept with `file: null` rather than dropped.
 */
function resolveFileField(raw: unknown, ctx: ParseFindingsContext): FileResolution {
  if (raw === undefined || raw === null) return { file: null };

  const reject = (): FileResolution => ({
    file: null,
    rejection: {
      sample: typeof raw === 'string' ? collapseDiagnostic(raw, 200) : `(non-string: ${typeof raw})`,
    },
  });

  if (typeof raw !== 'string') return reject();
  if (CONTROL_CHAR.test(raw)) return reject();
  const candidate = raw.trim();
  if (candidate === '') return { file: null };
  if (isAbsolute(candidate)) return reject();

  const segments = candidate.split(/[/\\]+/);
  if (segments.some((segment) => segment === '..')) return reject();

  const root = resolve(ctx.worktreePath);
  const target = resolve(root, candidate);
  const rel = relative(root, target);
  const insideWorktree = rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
  if (!insideWorktree) return reject();

  return { file: rel };
}

/** One raw JSON value, validated into a `Finding` — or `null` if it cannot be trusted enough to keep at all. Any file rejection is returned, never logged here, so a hostile document cannot flood the log one line per finding. */
function parseOneFinding(
  item: unknown,
  ctx: ParseFindingsContext,
): { finding: Finding | null; fileRejection?: FileRejection } {
  if (!isPlainRecord(item)) return { finding: null };

  const severity = parseSeverityStrict(item['severity']);
  if (severity === null) return { finding: null };

  const rawTitle = item['title'];
  const title = typeof rawTitle === 'string' ? rawTitle.trim() : '';
  if (title === '') return { finding: null };

  const rawDetail = item['detail'];
  const detail = typeof rawDetail === 'string' ? rawDetail : '';

  const fileResolution = resolveFileField(item['file'], ctx);
  const line = fileResolution.file === null ? null : parseLine(item['line']);

  return {
    finding: {
      severity,
      repo: ctx.repo,
      file: fileResolution.file,
      line,
      title: collapseDiagnostic(title, TITLE_MAX),
      detail: collapseDiagnostic(detail, DETAIL_MAX),
      source: AGENT_SOURCE,
    },
    fileRejection: fileResolution.rejection,
  };
}

/** Rank for the truncation sort — lower survives a cut first. Not the display order; report order is preserved within a rank via a stable sort. */
const SEVERITY_RANK: Readonly<Record<Severity, number>> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  info: 4,
};

/**
 * Sort by severity (critical first), stable — ties keep their original
 * report order. Used ONLY when truncating: attacker-controlled ordering
 * must not decide which findings survive a `max` cut, or padding a document
 * with low-severity noise ahead of a real `critical` silently turns a
 * would-be `failed` review into a pass.
 */
function bySeverityStable(findings: readonly Finding[]): Finding[] {
  return findings
    .map((finding, index) => ({ finding, index }))
    .sort((a, b) => SEVERITY_RANK[a.finding.severity] - SEVERITY_RANK[b.finding.severity] || a.index - b.index)
    .map(({ finding }) => finding);
}

/** Which of the three shapes a parse landed on — see `FindingsParseResult`. */
export type FindingsParseShape = 'parsed' | 'empty' | 'unreadable';

/**
 * A parse's findings, plus the shape that produced them. `'unreadable'`
 * means the boundary could not make sense of the output at all (no JSON, or
 * JSON that never carried a findings-shaped container) — that is distinct
 * from `'empty'`, where a findings container WAS recognized and legitimately
 * held nothing (or held only findings that failed validation). Callers that
 * only need the array keep using `parseFindings`; callers that must not
 * conflate "the model said nothing is wrong" with "we could not read the
 * model's answer" use this.
 */
export interface FindingsParseResult {
  findings: Finding[];
  shape: FindingsParseShape;
}

/**
 * Parse one review invocation's raw output into findings ready for
 * `recordFindings`'s batch, plus the shape that produced them (see
 * `FindingsParseResult`). Never throws; unparseable input returns `[]` with
 * `shape: 'unreadable'` (logged as such, distinctly from a legitimate empty
 * result). See the module doc comment for the full boundary contract.
 */
export function parseFindingsResult(
  raw: string,
  ctx: ParseFindingsContext,
  warn: WarnFn = defaultWarn,
): FindingsParseResult {
  const events = parseJsonEvents(raw);
  if (events.length === 0) {
    warn(
      `review findings: ${ctx.repo}'s review output was not recognizable JSON or JSONL — treated as zero findings, not as an error.`,
    );
    return { findings: [], shape: 'unreadable' };
  }

  const eventCandidates = events.map((event) => findingCandidatesFrom(event));
  const candidates = eventCandidates.flatMap((c) => c.candidates);
  const anyRecognized = eventCandidates.some((c) => c.recognized);

  const parsed: Finding[] = [];
  const fileRejections: FileRejection[] = [];
  for (const candidate of candidates) {
    const { finding, fileRejection } = parseOneFinding(candidate, ctx);
    if (finding !== null) parsed.push(finding);
    if (fileRejection !== undefined) fileRejections.push(fileRejection);
  }

  if (!anyRecognized) {
    warn(
      `review findings: ${ctx.repo}'s output parsed as JSON but carried no findings-shaped content — treated as zero findings.`,
    );
  }

  if (fileRejections.length > 0) {
    warn(
      `review findings: ${ctx.repo} reported ${fileRejections.length} untrustworthy file location(s) — kept the findings, dropped the locations. First rejected value: ${fileRejections[0]?.sample}`,
    );
  }

  const shape: FindingsParseShape = !anyRecognized ? 'unreadable' : parsed.length > 0 ? 'parsed' : 'empty';

  const max = Math.max(0, Math.floor(ctx.max));
  if (parsed.length > max) {
    const dropped = parsed.length - max;
    warn(
      `review findings: ${ctx.repo} reported ${parsed.length} findings, above the max of ${max} — dropped ${dropped}, kept the first ${max} by severity.`,
    );
    return { findings: bySeverityStable(parsed).slice(0, max), shape };
  }

  return { findings: parsed, shape };
}

/**
 * Thin wrapper over `parseFindingsResult` for callers that only need the
 * array — the original signature and behavior, unchanged.
 */
export function parseFindings(
  raw: string,
  ctx: ParseFindingsContext,
  warn: WarnFn = defaultWarn,
): Finding[] {
  return parseFindingsResult(raw, ctx, warn).findings;
}
