// ── Karst design system runtime (docs/ui/DESIGN-SYSTEM.md §5) ────────────────
var KARST_WATCHDOG_MS = __KARST_WATCHDOG_MS__;
var KARST_CONFIRM_MS = __KARST_CONFIRM_MS__;
var KARST_SPINNER_DELAY_MS = __KARST_SPINNER_DELAY_MS__;
var KARST_SPINNER_MIN_MS = __KARST_SPINNER_MIN_MS__;
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

/** HTML-escape untrusted text before it lands in an innerHTML template literal. */
var KARST_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
function karstEsc(value) {
  return String(value === null || value === undefined ? '' : value).replace(/[&<>"']/g, function (ch) {
    return KARST_ESCAPES[ch];
  });
}

function karstIsPending(el) {
  if (!el) return false;
  for (var id in karstPending) {
    if (Object.prototype.hasOwnProperty.call(karstPending, id) && karstPending[id].el === el) return true;
  }
  return false;
}

/** Region-level progress for the view tier: the nearest `[data-region]`, if any. */
function karstRegionOf(el) {
  return el && typeof el.closest === 'function' ? el.closest('[data-region]') : null;
}

/** aria-pressed of the control and its siblings, so a failed view action can put selection back. */
function karstSnapshotSelection(el) {
  var snap = [];
  var group = el && el.parentNode && el.parentNode.children ? Array.prototype.slice.call(el.parentNode.children) : [el];
  for (var i = 0; i < group.length; i++) {
    var n = group[i];
    if (n && typeof n.hasAttribute === 'function' && n.hasAttribute('aria-pressed')) {
      snap.push({ node: n, value: n.getAttribute('aria-pressed') });
    }
  }
  return snap;
}

/**
 * Enter pending. Three tiers (UI-R11), picked per action via opts.tier:
 *  - 'view'     press feedback; selection moves at once; never disabled.
 *  - 'mutation' (default) aria-busy + `disabled` re-trigger guard at 0ms.
 *  - 'confirm'  as mutation; its result is an in-place check (see karstSettle).
 * aria-busy is set at once in every tier. The VISIBLE spinner (`.is-spinning`,
 * or the region progress line for 'view') only appears after
 * KARST_SPINNER_DELAY_MS, so a fast reply never flashes one. The label is
 * deliberately untouched (UI-R18).
 */
function karstBeginPending(el, requestId, tier) {
  var wasDisabled = el ? !!el.disabled : false;
  var snapshot = null;
  if (el) {
    el.setAttribute('aria-busy', 'true');
    if (tier === 'view') {
      snapshot = karstSnapshotSelection(el);
      if (el.hasAttribute && el.hasAttribute('aria-pressed')) {
        for (var i = 0; i < snapshot.length; i++) snapshot[i].node.setAttribute('aria-pressed', 'false');
        el.setAttribute('aria-pressed', 'true');
      }
    } else {
      el.disabled = true;
    }
    if (el.classList) el.classList.add('is-pending');
  }
  var entry = {
    el: el,
    tier: tier,
    wasDisabled: wasDisabled,
    snapshot: snapshot,
    spinning: false,
    minElapsed: true,
    finish: null,
    showTimer: null,
    minTimer: null,
    timer: setTimeout(function () {
      // Unknown, not failed: the host may simply never reply.
      karstSettle(requestId, null);
    }, KARST_WATCHDOG_MS),
  };
  entry.showTimer = setTimeout(function () {
    entry.showTimer = null;
    if (!el || !el.classList) return;
    var region = tier === 'view' ? karstRegionOf(el) : null;
    entry.spinning = true;
    entry.minElapsed = false;
    if (region) region.classList.add('is-loading');
    else el.classList.add('is-spinning');
    entry.minTimer = setTimeout(function () {
      entry.minTimer = null;
      entry.minElapsed = true;
      if (entry.finish) entry.finish();
    }, KARST_SPINNER_MIN_MS);
  }, KARST_SPINNER_DELAY_MS);
  karstPending[requestId] = entry;
}

/**
 * Terminal result for one request. `ok` is true (succeeded), false (failed), or
 * null (unknown — the watchdog fired). A control disabled BEFORE the action
 * stays disabled: settling must not turn "unavailable" into "available".
 * Success has no presentation of its own: the result is the changed domain
 * state (UI-R13). Only the 'confirm' tier shows an in-place check, and a
 * failure never passes through it (UI-R15).
 */
function karstSettle(requestId, ok, message) {
  var entry = karstPending[requestId];
  if (!entry) return;
  delete karstPending[requestId];
  if (entry.timer !== undefined && entry.timer !== null) clearTimeout(entry.timer);
  if (entry.showTimer !== null) clearTimeout(entry.showTimer);

  var el = entry.el;
  var cleanup = function () {
    entry.finish = null;
    if (!el) return;
    el.removeAttribute('aria-busy');
    el.disabled = entry.wasDisabled;
    if (el.classList) {
      el.classList.remove('is-pending');
      el.classList.remove('is-spinning');
    }
    var region = entry.tier === 'view' ? karstRegionOf(el) : null;
    if (region && region.classList) region.classList.remove('is-loading');
  };
  if (el && entry.tier === 'view' && ok === false && entry.snapshot) {
    for (var i = 0; i < entry.snapshot.length; i++) {
      entry.snapshot[i].node.setAttribute('aria-pressed', entry.snapshot[i].value);
    }
  }
  if (entry.minElapsed) cleanup();
  else entry.finish = cleanup; // a shown spinner stays >= KARST_SPINNER_MIN_MS

  if (el && ok === true && entry.tier === 'confirm' && el.classList) {
    el.classList.add('is-success');
    setTimeout(function () {
      if (el.classList) el.classList.remove('is-success');
    }, KARST_CONFIRM_MS);
  }

  if (ok === false) {
    karstToast('error', karstOneLine(message) || 'That action failed.');
  } else if (ok === null) {
    karstToast('warning', karstOneLine(message) || 'Still running — the result is unknown.');
  } else if (entry.tier === 'confirm') {
    karstToast('success', karstOneLine(message) || 'Done');
  } else if (message) {
    karstToast('success', karstOneLine(message));
  }
}

/**
 * Bind a control to an async action. `send` receives the requestId and is
 * responsible for posting it to the host; the host replies once with
 * { type: 'action-result', requestId, ok, message } and the webview's message
 * handler calls karstSettle. opts.tier is 'view' | 'mutation' | 'confirm';
 * mutation is the default, so a quiet tier is always an explicit opt-in.
 */
function karstAction(el, send, opts) {
  if (!el) return;
  var options = opts || {};
  var tier = options.tier === 'view' || options.tier === 'confirm' ? options.tier : 'mutation';
  if (tier !== 'view' && el.classList && el.classList.contains('k-btn')) el.classList.add('k-btn--slot');
  el.addEventListener('click', function (ev) {
    if (karstIsPending(el)) {
      // Dropped, not queued (UI-R12).
      if (ev && ev.preventDefault) ev.preventDefault();
      return;
    }
    if (el.disabled) return;
    var requestId = karstRequestId();
    karstBeginPending(el, requestId, tier);
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
