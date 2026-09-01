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
 * instead of line 1. …and whenever that read produces NO findings-shaped
 * container (not merely when nothing parsed at all) it falls back to
 * extraction: every ```-fenced block's body first, then every balanced
 * top-level `[...]`/`{...}` span, each still handed to `JSON.parse`, run over
 * the raw text and over the string leaves of whatever did parse. A chat-tuned
 * core that narrates its tool calls before printing the array it was asked for
 * is the ordinary case, not the exotic one — reading that as zero findings
 * turned a `high` finding into a silent pass. Gating extraction on "something
 * parsed" rather than "findings were recognized" re-opens exactly that bug two
 * ways: one narration line that is a bare JSON scalar (`100`, `true`,
 * `"done"`) satisfies the JSONL read, and a provider's own output envelope
 * (`{"result":"…prose with a fenced findings block…"}`) satisfies the
 * whole-document read — in both cases the real report is still sitting in the
 * text, unread. "Findings-shaped" has exactly one definition here,
 * `findingCandidatesFrom`, and the gate reuses it.
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
 * Bound on how deep `balancedSpans`' bracket stack is allowed to grow. Exists
 * only so a pathological run of opener characters (no matching closers) can't
 * grow the stack unbounded before end of text; a closer beyond this depth
 * simply finds no frame to pop and is treated as stray — safe degradation,
 * not a correctness requirement (real JSON never nests this deep).
 */
const SCAN_MAX_DEPTH = 1_000;

/**
 * Balanced `[...]` / `{...}` substrings of `text`, using a stack so that a
 * SINGLE unmatched opener elsewhere in the surrounding prose (interval
 * notation like `[0, 1)`, a truncated `[3` reference, a stray `{`) cannot
 * swallow every subsequent close and make the real report look permanently
 * unbalanced (`i - start` never returning to zero) — confirmed by review as a
 * real defect: one dangling opener, and depth never returns to 0 for the rest
 * of the document, so nothing is ever emitted.
 *
 * Each successful pop that empties the stack is a genuine top-level span,
 * pushed immediately as before. A pop that leaves the stack NON-EMPTY — at
 * ANY residual depth — is kept as a single fallback candidate, unconditionally
 * overwritten on every such pop so only the LAST one before end of text
 * survives (the report a model is asked for is the last thing it writes,
 * matching `SCAN_MAX_CHARS`'s tail-scan rationale). This is deliberately not
 * restricted to a fixed residual depth: prose can accumulate more than one
 * dangling opener (two separate interval-notation asides before the real
 * report, say), and a fixed depth would then never see the real report's own
 * close. Recency alone is the correct signal — within one group, an outer
 * span's close always happens strictly after its inner content's close (a
 * single left-to-right pass), so the overwrite naturally lands on the most
 * complete candidate of the most recent group. The fallback is used only when
 * the scan found no genuine top-level span at all, so a document that closes
 * normally never gets an extra, possibly duplicate, candidate.
 *
 * A closer whose type doesn't match the top of the stack is a stray
 * character (prose, not JSON) — the stack is left untouched and the
 * character is skipped. String literals and their escapes are tracked so a
 * bracket inside a JSON string never opens or closes a span. This is a
 * LEXICAL scan, not a parser: every candidate it yields is still handed to
 * `JSON.parse`, and a candidate that does not parse is simply skipped.
 */
function balancedSpans(text: string): string[] {
  const spans: string[] = [];
  const stack: { opener: string; pos: number }[] = [];
  let inString = false;
  let escaped = false;
  let fallback: string | undefined;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      if (stack.length > 0) inString = true;
      continue;
    }
    if (ch === '[' || ch === '{') {
      if (stack.length < SCAN_MAX_DEPTH) stack.push({ opener: ch, pos: i });
      continue;
    }
    if (ch === ']' || ch === '}') {
      const top = stack[stack.length - 1];
      if (top === undefined) continue; // stray closer, no matching opener at all
      const matches = (top.opener === '[' && ch === ']') || (top.opener === '{' && ch === '}');
      if (!matches) continue; // mismatched type — stray closer, leave the stack as-is
      stack.pop();
      if (stack.length === 0) {
        spans.push(text.slice(top.pos, i + 1));
        if (spans.length >= SCAN_MAX_SPANS) break;
      } else {
        fallback = text.slice(top.pos, i + 1);
      }
    }
  }
  if (spans.length === 0 && fallback !== undefined) spans.push(fallback);
  return spans;
}

/**
 * The primary read: the whole trimmed document as one JSON value, else one
 * value per line. No extraction — that is a separate, separately-gated step
 * (`extractedJsonValues`), because "something parsed" is NOT the same question
 * as "a findings-shaped container was found".
 */
function primaryJsonValues(text: string): unknown[] {
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
  return values;
}

/** Bound on how many string leaves of an already-parsed value are re-scanned as text, and how deep the walk goes. A provider envelope is shallow; this is only ever meant to reach the one prose/report field it carries. */
const SCAN_MAX_STRING_LEAVES = 64;
const SCAN_MAX_LEAF_DEPTH = 8;

/**
 * Every string leaf of an already-parsed JSON value that could plausibly
 * contain an embedded JSON document. This is what lets extraction see through
 * a provider's own output envelope (`{"result":"…prose with a fenced findings
 * block…"}`): the envelope parsed, so the balanced scan over the RAW text only
 * ever re-yields the envelope, and the model's real answer lives inside a JSON
 * string where the fence's newlines are escaped. Bounded in both breadth and
 * depth; no I/O.
 */
function stringLeaves(value: unknown, out: string[], depth = 0): void {
  if (out.length >= SCAN_MAX_STRING_LEAVES || depth > SCAN_MAX_LEAF_DEPTH) return;
  if (typeof value === 'string') {
    if (value.includes('[') || value.includes('{')) out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) stringLeaves(item, out, depth + 1);
    return;
  }
  if (isPlainRecord(value)) {
    for (const item of Object.values(value)) stringLeaves(item, out, depth + 1);
  }
}

/**
 * How far before the naive tail cut to look for a `` ``` `` fence marker to
 * cut at instead, so the slice never starts strictly inside an opening
 * fence's marker (`` ``` `` plus its optional language tag). A model that
 * writes a huge tool-narration transcript before its fenced report can have
 * that report's opening fence land exactly at the `SCAN_MAX_CHARS` boundary;
 * without this, the slice could sever the marker itself and `fencedBlocks`
 * would never recognize the (still-complete) body that follows.
 */
const FENCE_LOOKBACK_CHARS = 200;

/**
 * The extraction fallback: every ```-fenced block's body first (exact), then
 * every balanced top-level `[...]`/`{...}` span (heuristic), each still handed
 * to `JSON.parse`. Run over each source in turn, sharing one
 * `SCAN_MAX_CANDIDATES` budget; each source is capped to its TAIL at
 * `SCAN_MAX_CHARS`, because the report a model is asked for is the last thing
 * it writes — biased backward, within `FENCE_LOOKBACK_CHARS`, to the nearest
 * preceding fence marker so the cut cannot land inside one. Purely lexical —
 * no filesystem or network I/O.
 *
 * Identical parsed values are kept once: the SAME array is routinely yielded
 * twice (once as a fence body, once as the balanced span inside that fence),
 * and counting it twice would double every finding in a fenced report. This
 * drops nothing — a repeat contributes no information — and it also keeps the
 * `SCAN_MAX_CANDIDATES` budget spent on distinct values.
 */
function extractedJsonValues(sources: readonly string[]): unknown[] {
  const extracted: unknown[] = [];
  const seen = new Set<string>();
  for (const source of sources) {
    const trimmed = source.trim();
    if (trimmed === '') continue;
    let cutAt = trimmed.length > SCAN_MAX_CHARS ? trimmed.length - SCAN_MAX_CHARS : 0;
    if (cutAt > 0) {
      const lookbackFloor = Math.max(0, cutAt - FENCE_LOOKBACK_CHARS);
      const nearestFence = trimmed.lastIndexOf('```', cutAt);
      if (nearestFence >= lookbackFloor) cutAt = nearestFence;
    }
    const scanned = trimmed.slice(cutAt);
    for (const candidate of [...fencedBlocks(scanned), ...balancedSpans(scanned)]) {
      const value = tryParseJson(candidate.trim());
      if (value === undefined) continue;
      const key = JSON.stringify(value) ?? 'undefined';
      if (seen.has(key)) continue;
      seen.add(key);
      extracted.push(value);
      if (extracted.length >= SCAN_MAX_CANDIDATES) return extracted;
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

/** The string leaves of every primary-parsed value, as extra text for the scan to read. */
function leafSources(values: readonly unknown[]): string[] {
  const leaves: string[] = [];
  for (const value of values) stringLeaves(value, leaves);
  return leaves;
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
  // The extraction fallback is gated on "no findings-shaped container was
  // recognized", NOT on "nothing parsed at all". A single narration line that
  // happens to be a bare JSON scalar (`100`, `true`, `"done"`) populates the
  // JSONL read, and a provider envelope parses as a whole document — either one
  // would otherwise suppress extraction entirely and turn a pretty-printed
  // `high` finding into a silent zero-findings pass. `findingCandidatesFrom` is
  // the single notion of "findings-shaped"; this reuses it rather than
  // inventing a second one.
  const primary = primaryJsonValues(raw);
  const events = primary.some((value) => findingCandidatesFrom(value).recognized)
    ? primary
    : [...primary, ...extractedJsonValues([raw, ...leafSources(primary)])];

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
