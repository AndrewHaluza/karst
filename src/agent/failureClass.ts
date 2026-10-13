/**
 * Classify a thrown agent-call failure into one of five recovery classes by
 * inspecting the error's MESSAGE TEXT (K1) — except quota exhaustion, whose
 * typed `UsageLimitError` is also recognized by instance/name. Anything the
 * classifier does not recognise is `fatal` — no retry, today's exact behavior
 * preserved.
 *
 * The classes are intentionally small and the precedence is fixed:
 * `aborted` wins over everything, `model-rejected` wins over `usage-limited`,
 * which wins over `transient`, and the conservative default is `fatal`.
 */

import { HTTP_429, LIMIT_PHRASES, QUOTA_PHRASES, UsageLimitError } from './cliFailure.js';

export type FailureClass = 'aborted' | 'transient' | 'model-rejected' | 'usage-limited' | 'fatal';

/** A provider refusing the model id itself: the id is named in the refusal. */
const MODEL_REJECTED =
  /(unknown|invalid|unsupported|unrecognized|not supported|does not exist|no such|decommissioned|deprecated|retired)[\s\S]{0,40}model|model[\s\S]{0,40}(not found|not supported|unavailable|does not exist|is invalid|unknown)/i;

/** A 4xx that names a model, e.g. the opencode zen 400 that prompted this. */
const BAD_REQUEST_WITH_MODEL = /(?<![\w."])(400|404|422)(?![\w.:])/;
const MENTIONS_MODEL_KEY = /"model"\s*:|(?<![\w-])model(?![\w-])/i;

/** Transport-level blips worth another attempt. */
const TRANSIENT_NETWORK =
  /(ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|EAI_AGAIN|ENOTFOUND|socket hang up|network error|connection (reset|closed|refused)|fetch failed|stream (closed|ended) unexpectedly|premature close)/i;

/** Server-side faults: a 5xx is the provider's problem, not the request's. */
const TRANSIENT_STATUS = /(?<![\w.:])(500|502|503|504|529)(?![\w.:])/;

/** Provider prose for "try again". */
const TRANSIENT_PHRASES =
  /(overloaded|temporarily unavailable|service unavailable|try again|please retry|internal server error|upstream error|bad gateway|gateway timeout)/i;

/** A hung core (K3) — explicitly NOT transient. */
const TIMED_OUT = /headless agent run timed out after/i;

/** Authentication/authorization — retrying cannot help. */
const AUTH = /(?<![\w.:])(401|403)(?![\w.:])|(unauthorized|forbidden|invalid api key|authentication failed|not authenticated|no credentials)/i;

/**
 * The text a classifier judges: the message, plus the `cause` chain's
 * messages when present. Bounded to 8 KB — the opencode error blob is JSON
 * and can be large, and an unbounded regex scan is a hazard on the extension
 * host's event loop.
 */
export function failureText(error: unknown): string {
  if (!(error instanceof Error)) return String(error).slice(0, 8192);

  const parts: string[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let current: any = error;
  let depth = 0;
  while (current !== undefined && depth < 5) {
    if (current instanceof Error && typeof current.message === 'string') {
      parts.push(current.message);
    } else if (typeof current === 'string') {
      parts.push(current);
    }
    current = current.cause;
    depth++;
  }
  return parts.join('\n').slice(0, 8192);
}

/**
 * Whether a thrown agent-call failure is the headless spawner's deadline
 * (`headlessSpawn.ts` names it `TimeoutError`) or carries its sentence in a
 * wrapped message. The ONE timeout test: `classifyFailure` and every lane that
 * salvages a cut run (the UAT Tester, T663) read this instead of matching the
 * spawner's prose themselves.
 */
export function isTimedOutFailure(error: unknown): boolean {
  if (error instanceof Error && error.name === 'TimeoutError') return true;
  return TIMED_OUT.test(failureText(error));
}

/**
 * Classify a thrown agent-call failure into exactly one recovery class.
 * The precedence order is fixed and deliberate — do not rearrange.
 */
export function classifyFailure(error: unknown): FailureClass {
  // 1. Abort (K2): checked on the object, before any text.
  if (error instanceof Error && error.name === 'AbortError') return 'aborted';

  const text = failureText(error);

  // 2. Timeout (K3): explicitly NOT transient.
  if (isTimedOutFailure(error)) return 'fatal';

  // 3. Authentication.
  if (AUTH.test(text)) return 'fatal';

  // 4. Model refused by provider.
  if (MODEL_REJECTED.test(text)) return 'model-rejected';

  // 5. A 4xx/422 whose body names the model — the exact shape of the incident.
  if (BAD_REQUEST_WITH_MODEL.test(text) && MENTIONS_MODEL_KEY.test(text)) {
    return 'model-rejected';
  }

  // 6. Quota exhaustion (K11) — the account, not the request. Checked BEFORE
  // the rate-limit rule so a quota phrase never reads as retryable: a typed
  // `UsageLimitError` is authoritative, and a bare quota phrase in the text
  // (a core that wrapped it as a plain Error) is caught the same way. A bare
  // 429 / `rate limit` / `too many requests` with NO quota wording falls
  // through to rule 7 and stays transient.
  if (
    error instanceof UsageLimitError ||
    (error instanceof Error && error.name === 'UsageLimitError') ||
    QUOTA_PHRASES.test(text)
  ) {
    return 'usage-limited';
  }

  // 7. Rate limit / usage limit (K5).
  if (HTTP_429.test(text) || LIMIT_PHRASES.test(text)) return 'transient';

  // 8. Network / server-side / provider prose.
  if (
    TRANSIENT_NETWORK.test(text) ||
    TRANSIENT_STATUS.test(text) ||
    TRANSIENT_PHRASES.test(text)
  ) {
    return 'transient';
  }

  // 9. Conservative default: fatal (no retry).
  return 'fatal';
}
