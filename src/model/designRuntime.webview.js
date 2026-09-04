// ── Karst design system runtime (docs/ui/DESIGN-SYSTEM.md §5) ────────────────
var KARST_WATCHDOG_MS = __KARST_WATCHDOG_MS__;
var KARST_FLASH_DONE_MS = __KARST_FLASH_DONE_MS__;
var KARST_TOAST_SUCCESS_MS = __KARST_TOAST_SUCCESS_MS__;
var KARST_MAX_TOAST_CHARS = __KARST_MAX_TOAST_CHARS__;

/** requestId -> { el, timer, wasDisabled }. The single source of "what is in flight". */
var karstPending = {};
var karstReqSeq = 0;

function karstRequestId() {
  karstReqSeq = karstReqSeq + 1;
  return 'k' + karstReqSeq + '-' + karstReqSeq.toString(36);
}

/** Untrusted prose (CLI output, model output, git stderr) collapsed to one capped line. */
function karstOneLine(value) {
  var s = String(value === null || value === undefined ? '' : value).replace(/\s+/g, ' ').trim();
  return s.length > KARST_MAX_TOAST_CHARS ? s.slice(0, KARST_MAX_TOAST_CHARS - 1) + '…' : s;
}

function karstIsPending(el) {
  if (!el) return false;
  for (var id in karstPending) {
    if (Object.prototype.hasOwnProperty.call(karstPending, id) && karstPending[id].el === el) return true;
  }
  return false;
}

/**
 * Enter pending. aria-busy is the accessible signal, `disabled` is the
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
 * Terminal result for one request. `ok` is true (succeeded), false (failed), or
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
    karstToast('warning', karstOneLine(message) || 'Still running — the result is unknown.');
  } else if (message) {
    karstToast('success', karstOneLine(message));
  }
}

/**
 * Bind a control to an async action. `send` receives the requestId and is
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
