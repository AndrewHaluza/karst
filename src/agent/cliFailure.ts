/**
 * One human sentence for a failed headless agent-CLI run — shared by every
 * agent core (Claude, Codex, Antigravity).
 *
 * Every adapter used to throw `<bin> exited <code>: <stdout||stderr>`, and for
 * the case that produced this module (a 429) the CLI's stdout is a ~2 KB JSON
 * envelope whose only human part is one `result` string. That blob was written
 * verbatim onto the `ship` stage verdict and rendered twice in the panel, so a
 * plain "you are out of quota" read as an internal crash (869ea499g).
 *
 * So: unwrap the envelope, name the limit when the CLI reported one, and keep
 * the raw text ONLY when nothing structured could be read — a failure mode we
 * cannot recognize must still be debuggable, just bounded.
 *
 * The diagnostic text is untrusted CLI prose (it can even be model output), so
 * it is collapsed to one line and length-capped before it reaches a stage
 * verdict, a log line, or a notification. The collapse-and-cap itself
 * (`oneLine`/`cap`) lives in `model/diagnosticText.ts`, shared with
 * `model/stepper.ts` — the same shape applies wherever untrusted CLI/git
 * prose reaches a rendered surface, not just here.
 */

import { cap, MAX_DIAGNOSTIC_CHARS, oneLine } from '../model/diagnosticText.js';

/** Bound on the human sentence pulled out of a structured envelope. */
const MAX_LIMIT_DETAIL_CHARS = 400;

/**
 * A standalone 429, not `foo.ts:429:12`. The lookarounds reject a number that
 * is part of a path, a version, or a longer number — a file:line is the common
 * false positive in CLI stderr, and mislabeling a parse error as "out of quota"
 * sends the user to a billing page for a bug.
 */
export const HTTP_429 = /(?<![\w.:])429(?![\w.:])/;

/** Phrases every provider uses for "you are out of allowance". */
export const LIMIT_PHRASES =
  /(rate[-_ ]?limit|usage limit|spend limit|limit reached|quota[-_ ]?exceeded|quota exceeded|resource[-_ ]?exhausted|too many requests|out of credits?|insufficient[_ ]quota)/i;

/**
 * The QUOTA subset of `LIMIT_PHRASES`: the wording that means the ACCOUNT is
 * out of allowance for a while — the user must raise a limit, buy credit or
 * wait for a reset. Deliberately excludes `429`, `rate limit` and `too many
 * requests`, which are the transient, retryable forms of the same status: a
 * bare 429 with no quota wording is worth one more attempt, an exhausted quota
 * is not. `LIMIT_PHRASES` stays the union of both (it drives the human sentence
 * in `describeHeadlessFailure`); this narrower regex is what the classifier and
 * `headlessFailureError` key off.
 */
export const QUOTA_PHRASES =
  /(quota[-_ ]?exceeded|usage limit|spend limit|limit reached|out of credits?|insufficient[_ ]quota|resource[-_ ]?exhausted)/i;

export interface HeadlessFailure {
  /** Display name of the agent core, e.g. `Claude`. */
  tool: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  /** The core's provider id (`claude` | `codex` | …), when known. */
  provider?: string;
  /** The model the failed run was launched with, when known. */
  model?: string;
}

/** What could be read out of a JSON / JSONL envelope. */
interface Structured {
  message?: string;
  status?: number;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function firstString(record: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return undefined;
}

function firstNumber(record: Record<string, unknown>, keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return undefined;
}

/** The human-readable part of one parsed event, wherever the CLI puts it. */
function readEvent(record: Record<string, unknown>): Structured {
  const nested = asRecord(record['error']);
  const message =
    firstString(record, ['result', 'message', 'msg', 'detail']) ??
    (typeof record['error'] === 'string' ? String(record['error']).trim() : undefined) ??
    (nested ? firstString(nested, ['message', 'detail']) : undefined);
  const status =
    firstNumber(record, ['api_error_status', 'status', 'statusCode', 'status_code']) ??
    (nested ? firstNumber(nested, ['status', 'statusCode', 'status_code', 'code']) : undefined);
  return { ...(message ? { message } : {}), ...(status !== undefined ? { status } : {}) };
}

/**
 * Read whatever structure the output has: a whole-document JSON envelope
 * (`claude -p --output-format json`) or JSONL (`codex exec --json`), where the
 * interesting event is rarely the first line.
 */
function extractStructured(text: string): Structured {
  const trimmed = text.trim();
  if (trimmed === '') return {};

  const candidates: Record<string, unknown>[] = [];
  try {
    const whole = asRecord(JSON.parse(trimmed));
    if (whole) candidates.push(whole);
  } catch {
    for (const line of trimmed.split(/\r?\n/)) {
      if (line.trim() === '') continue;
      try {
        const event = asRecord(JSON.parse(line));
        if (event) candidates.push(event);
      } catch {
        // Not JSONL — the raw-text path covers it.
      }
    }
  }

  const found: Structured = {};
  for (const candidate of candidates) {
    const event = readEvent(candidate);
    if (found.message === undefined && event.message !== undefined) found.message = event.message;
    if (found.status === undefined && event.status !== undefined) found.status = event.status;
  }
  return found;
}

function endSentence(text: string): string {
  return /[.!?…]$/.test(text) ? text : `${text}.`;
}

/** The first line that actually mentions the limit, not the whole dump. */
function limitLine(text: string): string | undefined {
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    if (LIMIT_PHRASES.test(trimmed) || HTTP_429.test(trimmed)) return trimmed;
  }
  return undefined;
}

interface Analysis {
  limited: boolean;
  /** The account is out of quota/allowance — a subset of `limited`. */
  quota: boolean;
  status?: number;
  detail?: string;
  raw: string;
}

function analyze(failure: HeadlessFailure): Analysis {
  const stderr = failure.stderr.trim();
  const stdout = failure.stdout.trim();
  // stderr first (that is where a CLI reports a fault), stdout as the fallback
  // — claude prints its whole error envelope on stdout.
  const fromErr = extractStructured(stderr);
  const fromOut = extractStructured(stdout);
  const message = fromErr.message ?? fromOut.message;
  const statusCode = fromErr.status ?? fromOut.status;
  const structured: Structured = {
    ...(message !== undefined ? { message } : {}),
    ...(statusCode !== undefined ? { status: statusCode } : {}),
  };

  const raw = stderr || stdout;
  const limited =
    structured.status === 429 ||
    (structured.message !== undefined && LIMIT_PHRASES.test(structured.message)) ||
    (structured.message === undefined && (LIMIT_PHRASES.test(raw) || HTTP_429.test(raw)));

  // Quota is the subset of `limited` whose wording means the account ran out —
  // never a bare status. Checked against the structured message when there is
  // one, and against the raw text as well so a quota phrase in a stream the
  // envelope did not surface is still caught.
  const quota =
    (structured.message !== undefined && QUOTA_PHRASES.test(structured.message)) ||
    QUOTA_PHRASES.test(raw);

  const detail = structured.message ?? (limited ? limitLine(raw) : raw || undefined);

  return {
    limited,
    quota,
    ...(structured.status !== undefined ? { status: structured.status } : {}),
    ...(detail !== undefined ? { detail } : {}),
    raw,
  };
}

/** True when the CLI refused because the user is out of quota / rate limited. */
export function isUsageLimitFailure(failure: HeadlessFailure): boolean {
  return analyze(failure).limited;
}

/**
 * The message an adapter throws when a headless run fails. Never includes the
 * envelope's machinery (session ids, token counts, cost) — only what a person
 * can act on.
 */
export function describeHeadlessFailure(failure: HeadlessFailure): string {
  const { limited, status, detail, raw } = analyze(failure);
  const next = 'Retry once the limit resets, or switch the ticket to another model or agent core.';

  if (limited) {
    const said = detail ? cap(oneLine(detail), MAX_LIMIT_DETAIL_CHARS) : '';
    if (said === '') {
      const code = status !== undefined ? ` (HTTP ${status})` : '';
      return `${failure.tool} usage limit reached${code}. ${next}`;
    }
    return `${failure.tool} usage limit reached — ${endSentence(said)} ${next}`;
  }

  const said = detail ? cap(oneLine(detail), MAX_DIAGNOSTIC_CHARS) : '';
  return `${failure.tool} failed (exit ${failure.exitCode}): ${said || (raw ? cap(oneLine(raw), MAX_DIAGNOSTIC_CHARS) : 'no output.')}`;
}

/**
 * True when the CLI refused because the ACCOUNT is out of quota/allowance (a
 * subset of `isUsageLimitFailure`) — the case a retry cannot clear and the user
 * must resolve. A bare 429 or `rate limit`/`too many requests` wording without a
 * quota phrase is NOT exhaustion and stays retryable.
 */
export function isQuotaExhausted(failure: HeadlessFailure): boolean {
  return analyze(failure).quota;
}

/**
 * A headless run that died because the account is out of quota/allowance
 * (K11). Typed so `classifyFailure` never has to guess from prose, and so the
 * provider/model that exhausted is available to the park that records it.
 *
 * The message is exactly `describeHeadlessFailure`'s sentence, so every surface
 * that renders a failed run reads the same words as before; the class identity
 * is what changed.
 */
export class UsageLimitError extends Error {
  readonly tool: string;
  readonly provider: string | undefined;
  readonly model: string | undefined;
  readonly status: number | undefined;
  readonly detail: string | undefined;

  constructor(
    message: string,
    fields: {
      tool: string;
      provider?: string | undefined;
      model?: string | undefined;
      status?: number | undefined;
      detail?: string | undefined;
    },
  ) {
    super(message);
    this.name = 'UsageLimitError';
    this.tool = fields.tool;
    this.provider = fields.provider;
    this.model = fields.model;
    this.status = fields.status;
    this.detail = fields.detail;
  }
}

/**
 * The ONE error an adapter throws for a failed headless run. Quota exhaustion
 * becomes a typed `UsageLimitError` (so the resilience layer fails fast); every
 * other failure is the same plain `Error` whose message `describeHeadlessFailure`
 * already produced.
 */
export function headlessFailureError(failure: HeadlessFailure): Error {
  const analysis = analyze(failure);
  if (analysis.quota) {
    return new UsageLimitError(describeHeadlessFailure(failure), {
      tool: failure.tool,
      provider: failure.provider,
      model: failure.model,
      status: analysis.status,
      detail: analysis.detail,
    });
  }
  return new Error(describeHeadlessFailure(failure));
}

/** agy's global settings file — the only place its permission allow-rules live. */
const AGY_SETTINGS_HINT = '~/.gemini/antigravity-cli/settings.json';

/**
 * Headless agy cannot prompt, so it auto-denies a tool that needs approval and
 * still exits 0 with only that notice — which a caller would read as an
 * unreadable answer. Both phrases must be present so a model that merely
 * mentions headless mode is not mistaken for a denial.
 */
const HEADLESS_DENIAL = /headless mode cannot prompt for[\s\S]*auto-denied/i;
const DENIED_PERMISSION = /required the "([^"]{1,40})" permission/i;

/**
 * The failure sentence for a headless run that was auto-denied a permission, or
 * null when `output` is not that notice. Names the permission and the fix.
 */
export function describePermissionDenial(tool: string, output: string): string | null {
  if (!HEADLESS_DENIAL.test(output)) return null;
  const permission = DENIED_PERMISSION.exec(output)?.[1];
  const named = permission ? `the "${permission}" permission` : 'a tool permission';
  return (
    `${tool} headless run was auto-denied ${named} (headless mode cannot prompt). ` +
    `Add an allow-rule under permissions.allow in ${AGY_SETTINGS_HINT} (e.g. command(git diff)), ` +
    `or run review/UAT on another agent core.`
  );
}

/**
 * The stable phrase of `describePermissionDenial`'s sentence — what makes a
 * STORED failure detail recognizable as a permission denial at render time,
 * where the raw CLI notice is no longer present. Kept beside the sentence it
 * matches so the two cannot drift.
 */
const DENIAL_SENTENCE = /headless run was auto-denied/i;

/**
 * True when a stored failure detail is the agy headless permission-denial
 * sentence. The Tester/Review process detail uses it to add the `karst doctor`
 * pointer (`tools.agy-permissions`) — the one case with a concrete next step
 * beyond retrying.
 */
export function isPermissionDenialDetail(detail: string): boolean {
  return DENIAL_SENTENCE.test(detail);
}
