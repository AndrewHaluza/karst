/**
 * The design system's webview-side runtime (§ `docs/ui/DESIGN-SYSTEM.md` §5) —
 * the async-action lifecycle every control that posts to the host must go
 * through (UI-R11–R14, R18, R32).
 *
 * Before this existed, `aria-busy` appeared ZERO times in the entire UI. Of
 * roughly ninety controls, three had any pending state at all (`ship-ticket`,
 * `merge-pr`, `refresh-prs`) — each an ad-hoc local boolean set before the round
 * trip and cleared by the next unconditional `state` push, so a merge that was
 * refused and a merge that succeeded cleared the button identically. Two more
 * showed an OPTIMISTIC checkmark that never waited for the host at all. The rest
 * — archive, delete, spin, resume, save-agent, install, create-manifest — were
 * fire-and-forget: click a button that writes to disk and nothing anywhere
 * acknowledges the click.
 *
 * Four properties are structural here rather than left to per-control
 * discipline, because per-control discipline is what produced the above:
 *
 *  1. Pending is entered LOCALLY on click, never on the host's reply. The round
 *     trip is the thing being reported; waiting for it to report itself is how a
 *     button ends up looking dead for two seconds.
 *  2. Pending is keyed by CONTROL, so a second activation is dropped rather than
 *     queued. `welcome`'s "Create karst.yml" writes a file and was re-clickable
 *     throughout the await.
 *  3. A watchdog always arms. A control may never be stuck pending — and its
 *     expiry reports "unknown", which is a DIFFERENT claim from "failed" and
 *     must stay worded as one. The host may legitimately never reply (the panel
 *     closed, the action opened a modal the user abandoned).
 *  4. The label never changes. `Save` → `Saving…` → `Save` mutates the
 *     accessible name mid-action and reflows the control; the spinner carries
 *     the meaning instead, via `[aria-busy]` in [[designComponents]].
 *
 * Emitted as plain statements (no wrapping `<script>`), exactly like
 * [[providerIdentity]]'s JS blob, so it can be injected as the first lines of an
 * existing block and picked up by `injectCsp`'s nonce pass.
 *
 * `designRuntime.test.ts` evaluates THIS STRING against a fake DOM rather than
 * re-implementing it in TypeScript — a TS twin would be precisely the
 * mirror-drift this ticket exists to remove.
 */

/**
 * How long a control may stay pending before the runtime gives up on the host.
 * Long enough for a real `gh pr merge` or a worktree spin; short enough that a
 * dead panel does not look merely slow forever.
 */
export const PENDING_WATCHDOG_MS = 45_000;

/** Success flash dwell, in step with `--k-dur-flash-done`. */
const FLASH_DONE_MS = 2400;

/** Success toast dwell. Errors never auto-dismiss. */
const TOAST_SUCCESS_MS = 6000;

/** Hard cap on any message that reaches a toast — see UI-R32. */
const MAX_TOAST_CHARS = 240;

/** Placeholder swapped for the runtime; sits as the first statement in each webview's `<script>`. */
export const DS_JS_MARKER = '/*KARST_DS_JS*/';

/**
 * The runtime source. Written as a string rather than compiled from TS because
 * it ships into an HTML document that no bundler touches — the same trade
 * [[providerIdentity]] already makes. Its correctness is held by evaluating this
 * exact text in `designRuntime.test.ts`.
 */
export function designRuntimeJs(): string {
  return `
// ── Karst design system runtime (docs/ui/DESIGN-SYSTEM.md §5) ────────────────
var KARST_WATCHDOG_MS = ${PENDING_WATCHDOG_MS};
var KARST_FLASH_DONE_MS = ${FLASH_DONE_MS};
var KARST_TOAST_SUCCESS_MS = ${TOAST_SUCCESS_MS};
var KARST_MAX_TOAST_CHARS = ${MAX_TOAST_CHARS};

/** requestId -> { el, timer, wasDisabled }. The single source of "what is in flight". */
var karstPending = {};
var karstReqSeq = 0;

function karstRequestId() {
  karstReqSeq = karstReqSeq + 1;
  return 'k' + karstReqSeq + '-' + karstReqSeq.toString(36);
}

/** Untrusted prose (CLI output, model output, git stderr) collapsed to one capped line. */
function karstOneLine(value) {
  var s = String(value === null || value === undefined ? '' : value).replace(/\\s+/g, ' ').trim();
  return s.length > KARST_MAX_TOAST_CHARS ? s.slice(0, KARST_MAX_TOAST_CHARS - 1) + '\\u2026' : s;
}

function karstIsPending(el) {
  if (!el) return false;
  for (var id in karstPending) {
    if (Object.prototype.hasOwnProperty.call(karstPending, id) && karstPending[id].el === el) return true;
  }
  return false;
}

/**
 * Enter pending. aria-busy is the accessible signal, \`disabled\` is the
 * re-trigger guard, and the class is what [[designComponents]] hangs the spinner
 * on. The label is deliberately untouched (UI-R18).
 */
function karstBeginPending(el, requestId) {
  var wasDisabled = el ? !!el.disabled : false;
  if (el) {
    el.setAttribute('aria-busy', 'true');
    el.disabled = true;
    if (el.classList) el.classList.add('is-pending');
  }
  karstPending[requestId] = {
    el: el,
    wasDisabled: wasDisabled,
    timer: setTimeout(function () {
      // Unknown, not failed: the host may simply never reply.
      karstSettle(requestId, null);
    }, KARST_WATCHDOG_MS),
  };
}

/**
 * Terminal result for one request. \`ok\` is true (succeeded), false (failed), or
 * null (unknown — the watchdog fired). A control disabled BEFORE the action
 * stays disabled: settling must not turn "unavailable" into "available".
 */
function karstSettle(requestId, ok, message) {
  var entry = karstPending[requestId];
  if (!entry) return;
  delete karstPending[requestId];
  if (entry.timer !== undefined && entry.timer !== null) clearTimeout(entry.timer);

  var el = entry.el;
  if (el) {
    el.removeAttribute('aria-busy');
    el.disabled = entry.wasDisabled;
    if (el.classList) el.classList.remove('is-pending');
    if (ok === true && el.classList) {
      el.classList.add('is-success');
      setTimeout(function () {
        if (el.classList) el.classList.remove('is-success');
      }, KARST_FLASH_DONE_MS);
    }
  }

  if (ok === false) {
    karstToast('error', karstOneLine(message) || 'That action failed.');
  } else if (ok === null) {
    karstToast('warning', karstOneLine(message) || 'Still running \\u2014 the result is unknown.');
  } else if (message) {
    karstToast('success', karstOneLine(message));
  }
}

/**
 * Bind a control to an async action. \`send\` receives the requestId and is
 * responsible for posting it to the host; the host replies once with
 * { type: 'action-result', requestId, ok, message } and the webview's message
 * handler calls karstSettle.
 */
function karstAction(el, send, opts) {
  if (!el) return;
  var options = opts || {};
  el.addEventListener('click', function (ev) {
    if (karstIsPending(el)) {
      // Dropped, not queued (UI-R12).
      if (ev && ev.preventDefault) ev.preventDefault();
      return;
    }
    if (el.disabled) return;
    var requestId = karstRequestId();
    karstBeginPending(el, requestId);
    try {
      send(requestId, ev);
    } catch (err) {
      karstSettle(requestId, false, err && err.message ? err.message : String(err));
    }
    if (options.settle === 'immediate') karstSettle(requestId, true);
  });
}

/** The one polite live region per webview (UI-R27). Created on first use. */
function karstToastRoot() {
  var root = document.getElementById('k-toast-root');
  if (root) return root;
  root = document.createElement('div');
  root.setAttribute('id', 'k-toast-root');
  root.setAttribute('class', 'k-toast-root');
  root.setAttribute('role', 'status');
  root.setAttribute('aria-live', 'polite');
  document.body.appendChild(root);
  return root;
}

/**
 * Surface a terminal outcome. Success and warning self-dismiss; an ERROR never
 * does — a failure the user has not read yet is not a failure that has been
 * reported.
 */
function karstToast(kind, message) {
  var text = karstOneLine(message);
  if (!text) return null;
  var root = karstToastRoot();
  var node = document.createElement('div');
  node.classList.add('k-toast');
  node.classList.add('k-toast--' + kind);
  node.textContent = text;
  root.appendChild(node);
  if (kind !== 'error') {
    setTimeout(function () {
      try { root.removeChild(node); } catch (e) { /* already detached */ }
    }, KARST_TOAST_SUCCESS_MS);
  }
  return node;
}
`.trim();
}
