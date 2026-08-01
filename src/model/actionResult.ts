/**
 * The host half of the async-action contract (§ `docs/ui/DESIGN-SYSTEM.md` §5.3,
 * UI-R13) — how a webview control learns that the thing it asked for happened.
 *
 * Before this, no webview had a general way to be told anything. `dashboard`'s
 * host-message union was four variants, none of them a result; `sidebar` and
 * `usage` had exactly one (`state`). So `archive`, `delete`, `spin`,
 * `save-agent-file`, `install-approach` and two dozen others were
 * fire-and-forget: the host either did the work or threw, and the user saw the
 * same nothing either way. The three controls that DID show pending each rolled
 * their own boolean and cleared it on the next unconditional `state` push —
 * which is why a merge that was refused and a merge that succeeded left the
 * button looking identical.
 *
 * The seam is deliberately ONE per webview. Every webview already routes through
 * a single `routeAction(msg, actions)` dispatch, so wrapping that one call
 * reports ~90 controls; adding a post at each call site would be ~90 chances to
 * forget one. `reportAction` is that wrapper.
 *
 * Two design points worth keeping:
 *
 *  - **A `void` return acks; a promise reports.** Action interfaces widen from
 *    `() => void` to `() => void | Promise<void>` — a TYPE WIDENING, so every
 *    existing implementation still satisfies it and one that keeps returning
 *    `void` keeps its exact current semantics. An ack is the weaker, honest
 *    claim ("the host accepted this"), and it is still enough to take a control
 *    out of pending rather than leave it there until the watchdog fires. An
 *    implementation opts into a real outcome by returning its promise.
 *  - **Reporting may never break what it observes.** A disposed panel throws on
 *    `postMessage`; the action still has to run, and the failure to report must
 *    not surface as a failure of the action. Same direction of dependency as
 *    `diagnostics/` — observation never reaches back.
 */

/** Hard cap on failure prose reaching a toast. Matches the runtime's own cap. */
export const MAX_RESULT_MESSAGE_CHARS = 240;

/** Longest `requestId` accepted from a webview. Ids are `k<n>-<n36>`; this is slack. */
const MAX_REQUEST_ID_CHARS = 64;

/**
 * Host → webview, once per request.
 *
 * `ok` is `true` (succeeded or accepted) or `false` (failed). The webview
 * runtime also knows a third state, `null` — unknown — but only IT can produce
 * that, from its own watchdog: "unknown" means the host never answered, so by
 * construction the host cannot be the one to say it.
 */
export interface ActionResultMessage {
  type: 'action-result';
  requestId: string;
  ok: boolean;
  message?: string;
}

/** One capped line, or undefined when there is nothing worth saying. */
function oneLine(value: unknown): string | undefined {
  const raw = value instanceof Error ? value.message : value;
  const text = String(raw ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return undefined;
  return text.length > MAX_RESULT_MESSAGE_CHARS
    ? `${text.slice(0, MAX_RESULT_MESSAGE_CHARS - 1)}…`
    : text;
}

/**
 * Pull the `requestId` off a RAW webview message, before it is narrowed.
 *
 * It has to be read here rather than threaded through each `parse*Message`,
 * because those deliberately drop every field they do not model — that dropping
 * is the trust boundary and must not be widened to carry a correlation id into
 * the action layer, where nothing should be able to see it.
 *
 * The value is echoed straight back to the webview, so it is validated as a
 * short, single-token string. An object, a number, or a megabyte of prose is not
 * a request id.
 */
export function readRequestId(raw: unknown): string | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const id = (raw as Record<string, unknown>).requestId;
  if (typeof id !== 'string') return undefined;
  if (id.length === 0 || id.length > MAX_REQUEST_ID_CHARS) return undefined;
  return /^[\w.:-]+$/.test(id) ? id : undefined;
}

/**
 * Run one dispatched action and report its single terminal result.
 *
 * Awaited by callers that can await; safe to fire-and-forget from a `void`
 * message handler, because it never rejects.
 */
export async function reportAction(
  requestId: string | undefined,
  post: (message: ActionResultMessage) => void,
  run: () => void | Promise<void>,
): Promise<void> {
  const send = (ok: boolean, message?: string): void => {
    if (requestId === undefined) return;
    try {
      post({ type: 'action-result', requestId, ok, ...(message ? { message } : {}) });
    } catch {
      // A disposed panel. The action already ran; losing the receipt is not a
      // reason to surface an error the user cannot act on.
    }
  };

  try {
    const returned = run();
    if (returned && typeof (returned as PromiseLike<void>).then === 'function') {
      await returned;
    }
    send(true);
  } catch (err) {
    send(false, oneLine(err));
  }
}
