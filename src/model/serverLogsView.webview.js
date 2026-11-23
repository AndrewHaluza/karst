// ── Karst shared server-logs surface ────────────────────────────────────────
//
// Search, run scoping, clear and ANSI rendering for the combined server-logs
// view — ONE implementation both webviews include (the in-dashboard surface and
// the standalone panel), delivered by marker injection exactly like the agent
// picker (`agentPicker.webview.js`): a self-contained webview cannot import TS.
//
//   window.createServerLogsView({ post, detached, onClose })
//
// returns `{ open, close, clear, handleInitial, handleOutput, handleMatchText,
// handleNewText, render, focusSearch, lineCount }`.
//
//   post       sends a webview-to-host message. This runtime posts exactly four
//              kinds: `server-logs-detach`, `server-logs-close`,
//              `server-logs-match-count` (the search hit count) and
//              `server-logs-new-count` (the Follow-off new-line count). Every
//              finished COUNT TEXT is the host's (`logMatchText`,
//              `logNewLinesText`, @arch:NTF-07) — this file holds no plural.
//   drillHead  true replaces the title and Close with an empty #logsDrillHead slot (the dashboard fills it with its
//              shared DrillHeader; Back is the way out)
//   detached   true omits the "Open in Window" control and the Close button — the
//              standalone panel has no second window to open and is closed by
//              closing its editor tab (LG-3).
//   onClose    lets the host clear its own open flag and stop tailing when the
//              surface closes; when absent, `close()` posts `server-logs-close`
//              itself.
//
// The line helpers below are a VERBATIM mirror of
// `src/ui/dashboard/logLine.ts` (plus `RUN_MARKER_PREFIX`/`isRunMarker` from
// `src/runtime/serverLog.ts`), exported as `KARST_SERVER_LOGLINE` — the
// mirrored-constants pattern in `docs/ui/UI-INVARIANTS.md`. The TS module stays
// the tested source of truth: `ui/dashboard/serverLogsSurface.test.ts` pins the
// two decoders together,
// so a drift fails the build rather than showing one thing and rendering
// another.

var KARST_SERVER_LOGLINE = (function () {
  /** A complete CSI sequence, e.g. `\u001b[32m` or `\u001b[2K`. */
  var ANSI_RE = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
  /** A CSI sequence cut off before its final byte (a 2 MiB read cap artifact). */
  var INCOMPLETE_TAIL_RE = /\u001b\[[0-9;?]*[ -/]*$/;
  var LONE_ESC_RE = /\u001b/g;
  var TIMESTAMP_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?)/;

  var COLOR_NAMES = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white'];

  /** Mirrored from `src/runtime/serverLog.ts` — do not edit one without the other. */
  var RUN_MARKER_PREFIX = '=== karst run ';

  function isRunMarker(line) {
    return line.indexOf(RUN_MARKER_PREFIX) === 0 && line.replace(/\s+$/, '').slice(-4) === ' ===';
  }

  function emptyState() {
    return { bold: false, dim: false, italic: false, underline: false, fg: null, bg: null };
  }

  function reset(state) {
    state.bold = false;
    state.dim = false;
    state.italic = false;
    state.underline = false;
    state.fg = null;
    state.bg = null;
  }

  /** Snapshot the current state as a canonical, ordered class list. */
  function classList(state) {
    var classes = [];
    if (state.bold) classes.push('k-ansi-bold');
    if (state.dim) classes.push('k-ansi-dim');
    if (state.italic) classes.push('k-ansi-italic');
    if (state.underline) classes.push('k-ansi-underline');
    if (state.fg) classes.push(state.fg);
    if (state.bg) classes.push(state.bg);
    return classes;
  }

  /** Apply one SGR (`m`-terminated) sequence's parameters to `state`. */
  function applySgr(state, raw) {
    var params = raw.split(';');
    for (var i = 0; i < params.length; i++) {
      var value = params[i] === '' ? 0 : Number(params[i]);
      if (!Number.isFinite(value)) continue;
      if (value === 0) {
        reset(state);
      } else if (value === 1) {
        state.bold = true;
      } else if (value === 2) {
        state.dim = true;
      } else if (value === 3) {
        state.italic = true;
      } else if (value === 4) {
        state.underline = true;
      } else if (value === 22) {
        state.bold = false;
        state.dim = false;
      } else if (value === 23) {
        state.italic = false;
      } else if (value === 24) {
        state.underline = false;
      } else if (value >= 30 && value <= 37) {
        var name = COLOR_NAMES[value - 30];
        if (name) state.fg = 'k-ansi-fg-' + name;
      } else if (value === 39) {
        state.fg = null;
      } else if (value >= 40 && value <= 47) {
        var bgName = COLOR_NAMES[value - 40];
        if (bgName) state.bg = 'k-ansi-bg-' + bgName;
      } else if (value === 49) {
        state.bg = null;
      } else if (value >= 90 && value <= 97) {
        var brightFg = COLOR_NAMES[value - 90];
        if (brightFg) state.fg = 'k-ansi-fg-bright-' + brightFg;
      } else if (value >= 100 && value <= 107) {
        var brightBg = COLOR_NAMES[value - 100];
        if (brightBg) state.bg = 'k-ansi-bg-bright-' + brightBg;
      } else if (value === 38 || value === 48) {
        return;
      }
    }
  }

  function sameClasses(a, b) {
    if (a.length !== b.length) return false;
    for (var i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }

  /** Remove every CSI sequence and every lone ESC from `text`. */
  function stripAnsi(text) {
    return text.replace(ANSI_RE, '').replace(INCOMPLETE_TAIL_RE, '').replace(LONE_ESC_RE, '');
  }

  /** Decode `text` into runs of characters sharing one SGR state. */
  function decodeAnsi(text) {
    var segments = [];
    var state = emptyState();

    var push = function (chunk) {
      if (chunk === '') return;
      var classes = classList(state);
      var last = segments[segments.length - 1];
      if (last && sameClasses(last.classes, classes)) {
        segments[segments.length - 1] = { text: last.text + chunk, classes: last.classes };
      } else {
        segments.push({ text: chunk, classes: classes });
      }
    };

    ANSI_RE.lastIndex = 0;
    var cursor = 0;
    var match;
    while ((match = ANSI_RE.exec(text)) !== null) {
      push(text.slice(cursor, match.index).replace(LONE_ESC_RE, ''));
      if (match[0].slice(-1) === 'm') applySgr(state, match[0].slice(2, -1));
      cursor = match.index + match[0].length;
    }
    push(text.slice(cursor).replace(INCOMPLETE_TAIL_RE, '').replace(LONE_ESC_RE, ''));

    return segments;
  }

  /** The ISO timestamp a line begins with, or null when it carries none. */
  function parseTimestamp(plain) {
    var match = TIMESTAMP_RE.exec(plain);
    return match ? match[1] : null;
  }

  /**
   * Drop the first `chars` VISIBLE characters from decoded segments: the `.ts`
   * span shows the stamp once, so the body must not repeat it (LG-2). The cut
   * can split a segment, or several when an escape sits inside the stamp.
   */
  function stripLeadingText(segments, chars) {
    var out = [];
    var left = chars;
    for (var i = 0; i < segments.length; i++) {
      var segment = segments[i];
      if (left <= 0) {
        out.push(segment);
      } else if (segment.text.length <= left) {
        left -= segment.text.length;
      } else {
        out.push({ text: segment.text.slice(left), classes: segment.classes });
        left = 0;
      }
    }
    return out;
  }

  /** A stored ISO stamp as the panel shows it: local `HH:mm:ss.SSS` (LG-13). */
  function formatLineTime(iso) {
    var when = new Date(iso);
    if (isNaN(when.getTime())) return iso;
    var pad = function (value, width) {
      var text = String(value);
      while (text.length < (width || 2)) text = '0' + text;
      return text;
    };
    return pad(when.getHours()) + ':' + pad(when.getMinutes()) + ':' + pad(when.getSeconds()) + '.' + pad(when.getMilliseconds(), 3);
  }

  /** Split raw log text into render-ready records, `seq` counting from `startSeq`. */
  function toLogLines(service, text, startSeq) {
    if (text === '') return [];
    var rawLines = text.split('\n');
    if (rawLines[rawLines.length - 1] === '') rawLines.pop();
    var lines = rawLines.map(function (raw, index) {
      var line = raw.slice(-1) === '\r' ? raw.slice(0, -1) : raw;
      var plain = stripAnsi(line);
      var ts = parseTimestamp(plain);
      var segments = decodeAnsi(line);
      return {
        service: service,
        ts: ts,
        seq: startSeq + index,
        plain: plain,
        segments: ts ? stripLeadingText(segments, ts.length) : segments,
        marker: isRunMarker(plain),
      };
    });
    // An unstamped line keeps the position it was written at: it orders with the
    // next stamped line (so a leading note stays first), else with the previous
    // one. Without this the "[Earlier output not shown: …]" marker sorted after
    // every stamped line and showed at the END of the log (T1317, LG-1).
    var upcoming = null;
    var next = [];
    var i;
    for (i = lines.length - 1; i >= 0; i--) {
      if (lines[i].ts !== null) upcoming = lines[i].ts;
      next[i] = upcoming;
    }
    var previous = null;
    for (i = 0; i < lines.length; i++) {
      if (lines[i].ts !== null) previous = lines[i].ts;
      lines[i].order = lines[i].ts !== null ? lines[i].ts : (next[i] !== null ? next[i] : previous);
    }
    return lines;
  }

  /** The lines from the last run marker onward, that marker included. */
  function currentRun(lines) {
    for (var i = lines.length - 1; i >= 0; i--) {
      if (lines[i].marker) return lines.slice(i);
    }
    return lines.slice();
  }

  /** Order by timestamp when both have one, else by the line's inherited key, else by sequence. */
  function compareLines(a, b) {
    var at = a.ts !== null ? a.ts : (a.order !== undefined ? a.order : null);
    var bt = b.ts !== null ? b.ts : (b.order !== undefined ? b.order : null);
    if (at !== null && bt !== null) return at < bt ? -1 : at > bt ? 1 : 0;
    if (at === null && bt === null) return a.seq - b.seq;
    return at === null ? 1 : -1;
  }

  /** Case-insensitive substring test against the stripped line. */
  function matchesQuery(line, query) {
    if (query.trim() === '') return true;
    return line.plain.toLowerCase().indexOf(query.toLowerCase()) !== -1;
  }

  return {
    stripAnsi: stripAnsi,
    decodeAnsi: decodeAnsi,
    parseTimestamp: parseTimestamp,
    formatLineTime: formatLineTime,
    toLogLines: toLogLines,
    currentRun: currentRun,
    compareLines: compareLines,
    matchesQuery: matchesQuery,
    isRunMarker: isRunMarker,
    RUN_MARKER_PREFIX: RUN_MARKER_PREFIX,
  };
})();

/**
 * Roving-focus arithmetic for the service tabs (LG-6): Left/Right wrap, Home/End
 * jump to an end. A pure function so the keyboard contract is testable without
 * a DOM; `-1` means "not a tab key".
 */
var KARST_SERVER_LOGS_TABS = {
  move: function (key, index, count) {
    if (count <= 0 || index < 0) return -1;
    if (key === 'ArrowLeft') return (index - 1 + count) % count;
    if (key === 'ArrowRight') return (index + 1) % count;
    if (key === 'Home') return 0;
    if (key === 'End') return count - 1;
    return -1;
  },
};

window.createServerLogsView = function (opts) {
  var o = opts || {};
  var post = typeof o.post === 'function' ? o.post : function () {};
  var detached = o.detached === true;
  var drillHead = o.drillHead === true;
  var onClose = typeof o.onClose === 'function' ? o.onClose : null;

  /** The render cap: older lines are dropped from the front (LG-5). */
  var MAX_LINES = 20000;
  var TRUNCATED_NOTE = 'Showing the newest output.';
  /**
   * The status shapes, MIRRORED from `SERVER_STATUS_MARK` in
   * `src/model/serverStatusText.ts` (this file cannot import TS; the dashboard's
   * `serverLogsSurface.test.ts` pins the two tables together). The WORD comes
   * from the host with each snapshot (LG-14), so no surface spells its own.
   */
  var STATUS_MARK = { 'Running': '●', 'Starting…': '◌', 'Stopping…': '◌', 'Stopped': '○', 'Failed': '✕', 'Missing': '?' };

  // ── state ────────────────────────────────────────────────────────────────
  // `lines` is a flat LogLine[] across every service; `services` is the tab
  // order, kept even through clear() so a cleared service still has a tab.
  var lines = [];
  var services = [];
  var activeTab = 'merged';
  var query = '';
  var filterOn = false;
  var currentRunOnly = false;
  var loading = false;
  var follow = true;
  var wrap = true;
  var titleKey = '';
  var truncatedServices = {};
  var stateMessage = {};
  // Each service's RS-17 status word, sent with the initial snapshot (LG-14).
  var statusWord = {};
  var droppedOldest = false;
  var pendingNew = 0;
  var newSeq = 0;
  var newText = '';
  var matchIndex = 0;
  var matchSeq = 0;
  var nextSeq = 0;
  var shownPlain = '';

  // What the last full render painted, so a live chunk can append instead of
  // rebuilding tens of thousands of nodes (LG-5).
  var renderedShown = null;
  var renderedHits = 0;
  var noteRendered = false;
  var renderQueued = false;
  var pendingFull = false;

  function doc() { return typeof document === 'undefined' ? null : document; }
  function box() { var d = doc(); return d ? d.getElementById('logsView') : null; }
  function host() { var d = doc(); return d ? d.getElementById('logsHost') : null; }
  function searchField() { var d = doc(); return d ? d.getElementById('logsSearch') : null; }
  function hasQuery() { return query.trim() !== ''; }
  function $(id) { var d = doc(); return d ? d.getElementById(id) : null; }

  function frame(fn) {
    if (typeof requestAnimationFrame === 'function') return requestAnimationFrame(fn);
    // The VM harness has no animation clock: run now, still once per request.
    fn();
    return 0;
  }

  function titleText() {
    return titleKey ? 'Server logs · ' + titleKey : 'Server logs';
  }

  function applyTitle() {
    var el = $('logsTitle');
    if (el) el.textContent = titleText();
  }

  function applyWrap() {
    var b = box();
    if (!b || !b.classList) return;
    if (wrap) b.classList.remove('nowrap');
    else b.classList.add('nowrap');
  }

  function queryOne(selector) {
    var d = doc();
    return d && typeof d.querySelector === 'function' ? d.querySelector(selector) : null;
  }

  function updateLatest() {
    var button = queryOne('[data-log-latest]');
    if (!button) return;
    var show = !follow && pendingNew > 0 && newText !== '';
    button.hidden = !show;
    if (show) button.textContent = newText + ' ↓';
  }

  function buildShell() {
    var b = box();
    if (!b) return;
    var detach = detached ? ''
      : '<button type="button" class="k-btn k-btn--ghost k-btn--sm" data-log-detach>Open in Window</button>';
    // The standalone panel is closed by its editor tab; the dashboard drill has
    // its own Back header. Neither gets a Close button that would leave an
    // empty tab behind (LG-3).
    var closeBtn = detached ? ''
      : '<span class="sp"><button type="button" class="k-btn k-btn--ghost k-btn--sm" data-log-close title="Close the logs view">Close</button></span>';
    b.innerHTML = (drillHead ? '<div id="logsDrillHead"></div>' : '')
      + '<div class="thead">'
      + (drillHead ? '' : '<span class="ttitle" id="logsTitle">' + esc(titleText()) + '</span>')
      + '<span class="logcontrols">'
      + '<input class="k-input" id="logsSearch" type="search" placeholder="Search logs" aria-label="Search logs">'
      + '<span id="logsMatches" role="status"></span>'
      + '<button type="button" class="k-btn k-btn--ghost k-btn--sm" data-log-prev aria-label="Previous match" title="Previous match">Prev</button>'
      + '<button type="button" class="k-btn k-btn--ghost k-btn--sm" data-log-next aria-label="Next match" title="Next match">Next</button>'
      + '<button type="button" class="k-btn k-btn--ghost k-btn--sm" data-log-follow aria-pressed="true" title="Follow new output">Follow</button>'
      + '<button type="button" class="k-btn k-btn--ghost k-btn--sm" data-log-latest hidden>Jump to latest ↓</button>'
      + '<label class="logcheck"><input type="checkbox" data-log-filter> Only matching lines</label>'
      + '<label class="logcheck"><input type="checkbox" data-log-current-run> Current run only</label>'
      + '<label class="logcheck"><input type="checkbox" data-log-wrap checked> Wrap</label>'
      + '<button type="button" class="k-btn k-btn--ghost k-btn--sm" data-log-copy title="Copy the lines shown">Copy</button>'
      + '<button type="button" class="k-btn k-btn--ghost k-btn--sm" data-log-clear title="Clear the view; tailing continues">Clear view</button>'
      + detach
      + '</span>'
      + (drillHead ? '' : closeBtn)
      + '</div>'
      + '<div class="tstatus" id="logsStatus" role="status"></div>'
      + '<div class="tabs k-tabs" id="logsTabs" role="tablist" aria-label="Server log tabs"></div>'
      + '<div id="logsHost" class="loghost" role="tabpanel" tabindex="0"></div>';
    bindShell(b);
    applyWrap();
  }

  function tabButton(tab, label, word) {
    var selected = activeTab === tab;
    var mark = word ? STATUS_MARK[word] : '';
    return '<button type="button" class="k-tab' + (selected ? ' active' : '') + '"'
      + ' role="tab" aria-selected="' + (selected ? 'true' : 'false') + '"'
      + ' tabindex="' + (selected ? '0' : '-1') + '"'
      + ' data-log-tab="' + esc(tab) + '">'
      + (mark ? '<span class="k-tab-mark" aria-hidden="true">' + esc(mark) + '</span> ' : '')
      + esc(label)
      + (word ? ' <span class="k-tab-status">· ' + esc(word) + '</span>' : '')
      + '</button>';
  }

  function selectTab(tab) {
    activeTab = tab || 'merged';
    matchIndex = 0;
    renderedShown = null;
    renderContent();
    focusTab(activeTab);
  }

  function tabElements() {
    var tabs = $('logsTabs');
    if (!tabs || !tabs.querySelectorAll) return [];
    return tabs.querySelectorAll('[data-log-tab]');
  }

  function focusTab(tab) {
    var all = tabElements();
    for (var i = 0; i < all.length; i++) {
      if (all[i].getAttribute('data-log-tab') === tab && typeof all[i].focus === 'function') all[i].focus();
    }
  }

  function bindShell(root) {
    root.addEventListener('click', function (e) {
      var target = e.target;
      if (!target || !target.closest) return;
      if (target.closest('[data-log-close]')) { close(); return; }
      var tab = target.closest('[data-log-tab]');
      if (tab) { selectTab(tab.getAttribute('data-log-tab')); return; }
      if (target.closest('[data-log-prev]')) { step(-1); return; }
      if (target.closest('[data-log-next]')) { step(1); return; }
      if (target.closest('[data-log-follow]')) { setFollow(!follow, false); return; }
      if (target.closest('[data-log-latest]')) { setFollow(true, true); return; }
      if (target.closest('[data-log-copy]')) { post({ type: 'server-logs-copy', text: shownPlain }); return; }
      if (target.closest('[data-log-clear]')) { clear(); return; }
      if (target.closest('[data-log-detach]')) { post({ type: 'server-logs-detach' }); return; }
    });

    root.addEventListener('input', function (e) {
      var target = e.target;
      if (target && target.id === 'logsSearch') {
        query = target.value || '';
        matchIndex = 0;
        renderedShown = null;
        renderContent();
      }
    });

    root.addEventListener('change', function (e) {
      var target = e.target;
      if (!target || !target.hasAttribute) return;
      if (target.hasAttribute('data-log-filter')) {
        filterOn = !!target.checked;
        matchIndex = 0;
        renderedShown = null;
        renderContent();
        return;
      }
      if (target.hasAttribute('data-log-current-run')) {
        currentRunOnly = !!target.checked;
        matchIndex = 0;
        renderedShown = null;
        renderContent();
        return;
      }
      if (target.hasAttribute('data-log-wrap')) {
        wrap = !!target.checked;
        applyWrap();
      }
    });

    root.addEventListener('keydown', function (e) {
      var field = searchField();
      if ((e.metaKey || e.ctrlKey) && e.key === 'f') {
        e.preventDefault();
        if (typeof e.stopPropagation === 'function') e.stopPropagation();
        focusSearch();
        return;
      }
      // Roving focus across the service tabs (LG-6).
      var target = e.target;
      if (target && target.closest) {
        var tab = target.closest('[data-log-tab]');
        if (tab) {
          var all = tabElements();
          var index = -1;
          for (var i = 0; i < all.length; i++) {
            if (all[i] === tab) index = i;
          }
          var next = KARST_SERVER_LOGS_TABS.move(e.key, index, all.length);
          if (next !== -1) {
            e.preventDefault();
            var picked = all[next];
            if (picked) selectTab(picked.getAttribute('data-log-tab'));
            return;
          }
        }
      }
      if (e.target !== field) return;
      if (e.key === 'Escape') {
        query = '';
        if (field) field.value = '';
        matchIndex = 0;
        renderedShown = null;
        e.preventDefault();
        if (typeof e.stopPropagation === 'function') e.stopPropagation();
        renderContent();
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        if (typeof e.stopPropagation === 'function') e.stopPropagation();
        step(e.shiftKey ? -1 : 1);
      }
    });
  }

  /**
   * Turn Follow on or off. Jump to latest also hands the caret to the log body,
   * so the keyboard keeps reading where the view now is.
   */
  function setFollow(on, focusBody) {
    follow = on;
    var button = queryOne('[data-log-follow]');
    if (button) button.setAttribute('aria-pressed', on ? 'true' : 'false');
    if (on) {
      pendingNew = 0;
      newText = '';
      var h = host();
      if (h) {
        h.scrollTop = h.scrollHeight;
        if (focusBody && typeof h.focus === 'function') h.focus();
      }
    }
    updateLatest();
  }

  /** Post the hit count; `current` is the 1-based match after Prev/Next (LG-10). */
  function setMatchCount(count, current) {
    if (!hasQuery()) {
      var el = $('logsMatches');
      if (el) el.textContent = '';
      return;
    }
    matchSeq += 1;
    var msg = { type: 'server-logs-match-count', count: count, seq: matchSeq };
    if (current !== undefined) msg.current = current;
    post(msg);
  }

  /** Ask the host for the Follow-off label ("12 new lines", @arch:NTF-07). */
  function requestNewText(count) {
    newSeq += 1;
    post({ type: 'server-logs-new-count', count: count, seq: newSeq });
  }

  /** The host's finished match text (@arch:NTF-07); a stale answer is dropped. */
  function handleMatchText(seq, text) {
    if (seq !== matchSeq || !hasQuery()) return;
    var el = $('logsMatches');
    if (el) el.textContent = typeof text === 'string' ? text : '';
  }

  /** The host's finished new-line text (@arch:NTF-07); a stale answer is dropped. */
  function handleNewText(seq, text) {
    if (seq !== newSeq) return;
    newText = typeof text === 'string' ? text : '';
    updateLatest();
  }

  /** Wrap every case-insensitive occurrence of the query in a `<mark>`. */
  function highlight(text) {
    var escaped = esc(text);
    var needle = esc(query);
    if (needle === '') return { html: escaped, hits: 0 };
    var lower = escaped.toLowerCase();
    var lowerNeedle = needle.toLowerCase();
    var html = '';
    var hits = 0;
    var at = 0;
    while (true) {
      var found = lower.indexOf(lowerNeedle, at);
      if (found === -1) { html += escaped.slice(at); break; }
      html += escaped.slice(at, found)
        + '<mark class="k-loghit">' + escaped.slice(found, found + lowerNeedle.length) + '</mark>';
      hits += 1;
      at = found + lowerNeedle.length;
    }
    return { html: html, hits: hits };
  }

  function lineHtml(line) {
    var hits = 0;
    var body = '';
    for (var i = 0; i < line.segments.length; i++) {
      var segment = line.segments[i];
      var inner = esc(segment.text);
      if (hasQuery()) {
        var marked = highlight(segment.text);
        inner = marked.html;
        hits += marked.hits;
      }
      var cls = segment.classes && segment.classes.length
        ? ' class="' + segment.classes.join(' ') + '"'
        : '';
      body += '<span' + cls + '>' + inner + '</span>';
    }
    var prefix = '<span class="service-prefix">[' + esc(line.service) + ']</span>';
    // The stamp reads locally, keeps the ISO value in the tooltip (LG-13), and
    // appears ONCE: the body had it stripped by toLogLines (LG-2).
    var ts = line.ts
      ? ' <span class="ts" title="' + esc(line.ts) + '">' + esc(KARST_SERVER_LOGLINE.formatLineTime(line.ts)) + '</span>'
      : '';
    return { html: '<div class="logline">' + prefix + ts + ' ' + body + '</div>', hits: hits };
  }

  function isTruncated() {
    if (droppedOldest) return true;
    if (activeTab !== 'merged') return !!truncatedServices[activeTab];
    for (var i = 0; i < services.length; i++) if (truncatedServices[services[i]]) return true;
    return false;
  }

  function emptyText(filtering) {
    if (filtering) return 'No lines match this search.';
    // The loading line lives in the BODY only; the status strip stays empty and
    // hides itself (LG-9).
    if (loading) return 'Loading server logs…';
    if (activeTab !== 'merged') {
      return stateMessage[activeTab] || ('No log output for ' + activeTab + '.');
    }
    var notes = [];
    for (var i = 0; i < services.length; i++) {
      if (stateMessage[services[i]]) notes.push(stateMessage[services[i]]);
    }
    return notes.length ? notes.join(' ') : 'No log output available.';
  }

  function renderTabs() {
    var tabsEl = $('logsTabs');
    if (!tabsEl) return;
    if (!services.length) { tabsEl.innerHTML = ''; return; }
    var html = tabButton('merged', 'Merged');
    for (var i = 0; i < services.length; i++) html += tabButton(services[i], services[i], statusWord[services[i]] || '');
    tabsEl.innerHTML = html;
  }

  /**
   * Paint the current match — by moving a class and scrolling, never by
   * re-rendering: a 2 MiB log is tens of thousands of nodes and a full repaint
   * per Enter would stall the webview.
   */
  function paintMatch(scrollTo) {
    var h = host();
    if (!h) return;
    var marks = h.querySelectorAll('.k-loghit');
    if (!marks.length) { matchIndex = 0; return; }
    if (matchIndex >= marks.length) matchIndex = 0;
    if (matchIndex < 0) matchIndex = marks.length - 1;
    for (var i = 0; i < marks.length; i++) marks[i].classList.remove('k-loghit--current');
    var current = marks[matchIndex];
    if (current) {
      current.classList.add('k-loghit--current');
      if (scrollTo && typeof current.scrollIntoView === 'function') {
        current.scrollIntoView({ block: 'center' });
      }
    }
  }

  function step(delta) {
    var h = host();
    if (!h) return;
    var marks = h.querySelectorAll('.k-loghit');
    if (!marks.length) return;
    matchIndex = (matchIndex + delta + marks.length) % marks.length;
    paintMatch(true);
    // The label follows the caret through the matches ("3 of 12", LG-10).
    setMatchCount(marks.length, matchIndex + 1);
  }

  /** The ordered lines the active tab shows, after run scope and search. */
  function computeShown() {
    var shown = activeTab === 'merged'
      ? lines.slice()
      : lines.filter(function (l) { return l.service === activeTab; });
    if (currentRunOnly) shown = KARST_SERVER_LOGLINE.currentRun(shown);
    shown.sort(KARST_SERVER_LOGLINE.compareLines);
    if (filterOn && hasQuery()) {
      shown = shown.filter(function (l) { return KARST_SERVER_LOGLINE.matchesQuery(l, query); });
    }
    return shown;
  }

  function plainOf(shown) {
    var parts = [];
    for (var i = 0; i < shown.length; i++) parts.push(shown[i].plain);
    return parts.join('\n');
  }

  function truncatedNoteHtml() {
    return isTruncated()
      ? '<div class="logtrunc" role="status">' + esc(TRUNCATED_NOTE) + '</div>'
      : '';
  }

  function renderContent() {
    var h = host();
    if (!h) return;
    if (activeTab !== 'merged' && services.indexOf(activeTab) === -1) activeTab = 'merged';
    renderTabs();
    noteRendered = isTruncated();
    // Loading is body text only (LG-9); the status strip never carries it.
    var statusEl = $('logsStatus');
    if (statusEl) statusEl.textContent = '';

    // Only auto-scroll when Follow is on and the reader was already at (or near)
    // the bottom — otherwise new output would yank them away from a line they
    // scrolled up to read (LG-4).
    var wasAtBottom = h.scrollHeight - h.scrollTop - h.clientHeight < 32;

    if (!services.length) {
      droppedOldest = false;
      renderedShown = [];
      renderedHits = 0;
      shownPlain = '';
      h.innerHTML = loading
        ? '<div class="blurb">Loading server logs…</div>'
        : '<div class="blurb k-empty">This ticket has no services.</div>';
      setMatchCount(0);
      return;
    }

    var shown = computeShown();
    var filtering = filterOn && hasQuery();

    if (shown.length === 0) {
      renderedShown = [];
      renderedHits = 0;
      shownPlain = '';
      // An empty body is the whole view's state (no output yet, unreadable);
      // a filtered result and the loading line are ordinary body text.
      var emptyCls = filtering || loading ? 'blurb' : 'blurb k-empty';
      h.innerHTML = truncatedNoteHtml() + '<div class="' + emptyCls + '">' + esc(emptyText(filtering)) + '</div>';
      setMatchCount(0);
      if (follow && wasAtBottom) h.scrollTop = h.scrollHeight;
      return;
    }

    var html = truncatedNoteHtml();
    var hits = 0;
    for (var i = 0; i < shown.length; i++) {
      var built = lineHtml(shown[i]);
      html += built.html;
      hits += built.hits;
    }
    h.innerHTML = html;
    renderedShown = shown;
    renderedHits = hits;
    shownPlain = plainOf(shown);
    setMatchCount(hits);
    paintMatch(false);
    if (follow && wasAtBottom) h.scrollTop = h.scrollHeight;
  }

  /** Append only the lines added since the last paint, when that is provably the same view (LG-5). */
  function tryAppend() {
    var h = host();
    if (!h || !renderedShown || hasQuery() || currentRunOnly || filterOn) return false;
    if (!services.length) return false;
    var shown = computeShown();
    if (shown.length < renderedShown.length) return false;
    for (var i = 0; i < renderedShown.length; i++) if (shown[i] !== renderedShown[i]) return false;
    var added = shown.slice(renderedShown.length);
    if (added.length === 0) return false;

    var wasAtBottom = h.scrollHeight - h.scrollTop - h.clientHeight < 32;
    var html = '';
    var hits = 0;
    for (var j = 0; j < added.length; j++) {
      var built = lineHtml(added[j]);
      html += built.html;
      hits += built.hits;
    }
    // A DOM-less harness cannot append; it repaints all instead (still once per
    // frame). In a webview the new nodes alone reach the page.
    if (typeof h.insertAdjacentHTML !== 'function') return false;
    // A note that appeared since the last paint needs the whole view again, so
    // it can sit above the first line rather than in the middle of the log.
    if (isTruncated() !== noteRendered) return false;
    // The first append replaces the empty-state blurb.
    if (!renderedShown.length) h.innerHTML = truncatedNoteHtml() + html;
    else h.insertAdjacentHTML('beforeend', html);
    renderedShown = shown;
    renderedHits += hits;
    shownPlain = plainOf(shown);
    setMatchCount(renderedHits);
    paintMatch(false);
    if (follow && wasAtBottom) h.scrollTop = h.scrollHeight;
    return true;
  }

  function scheduleRender(full) {
    if (full) pendingFull = true;
    if (renderQueued) return;
    renderQueued = true;
    frame(function () {
      renderQueued = false;
      var mustPaintAll = pendingFull;
      pendingFull = false;
      if (!mustPaintAll && tryAppend()) return;
      renderContent();
    });
  }

  function render() {
    if (!box()) return;
    if (!host()) buildShell();
    if (!host()) return;
    applyTitle();
    renderContent();
  }

  function open() {
    loading = true;
    renderedShown = null;
    var b = box();
    if (b) {
      b.classList.remove('hidden');
      if (doc() && doc().body && doc().body.classList) doc().body.classList.add('log-nav');
    }
    render();
  }

  function close() {
    var b = box();
    if (b) {
      b.classList.add('hidden');
      b.innerHTML = '';
    }
    if (doc() && doc().body && doc().body.classList) doc().body.classList.remove('log-nav');
    lines = [];
    services = [];
    activeTab = 'merged';
    query = '';
    filterOn = false;
    currentRunOnly = false;
    loading = false;
    follow = true;
    wrap = true;
    titleKey = '';
    truncatedServices = {};
    stateMessage = {};
    droppedOldest = false;
    pendingNew = 0;
    newSeq = 0;
    newText = '';
    matchIndex = 0;
    matchSeq = 0;
    nextSeq = 0;
    shownPlain = '';
    renderedShown = null;
    renderedHits = 0;
    if (onClose) onClose();
    else post({ type: 'server-logs-close' });
  }

  function clear() {
    lines = [];
    matchIndex = 0;
    renderedShown = null;
    renderedHits = 0;
    droppedOldest = false;
    shownPlain = '';
    renderContent();
  }

  /** Append parsed lines, dropping the oldest past MAX_LINES (LG-5). */
  function pushParsed(parsed) {
    for (var i = 0; i < parsed.length; i++) lines.push(parsed[i]);
    if (lines.length > MAX_LINES) {
      lines.splice(0, lines.length - MAX_LINES);
      droppedOldest = true;
    }
    return parsed.length;
  }

  function handleInitial(servers, key) {
    lines = [];
    services = [];
    truncatedServices = {};
    stateMessage = {};
    statusWord = {};
    droppedOldest = false;
    nextSeq = 0;
    titleKey = typeof key === 'string' ? key : '';
    renderedShown = null;
    var list = servers || [];
    for (var i = 0; i < list.length; i++) {
      var server = list[i] || {};
      var service = server.service || '';
      if (service && services.indexOf(service) === -1) services.push(service);
      if (service) {
        truncatedServices[service] = server.truncated === true;
        stateMessage[service] = server.state && server.state !== 'ok' ? (server.message || '') : '';
        if (typeof server.status === 'string' && server.status) statusWord[service] = server.status;
      }
      var parsed = KARST_SERVER_LOGLINE.toLogLines(service, server.content || '', nextSeq);
      nextSeq += parsed.length;
      pushParsed(parsed);
    }
    loading = false;
    render();
  }

  function handleOutput(service, text) {
    if (service && services.indexOf(service) === -1) services.push(service);
    var parsed = KARST_SERVER_LOGLINE.toLogLines(service, text || '', nextSeq);
    nextSeq += parsed.length;
    pushParsed(parsed);
    if (!follow) {
      pendingNew += parsed.length;
      requestNewText(pendingNew);
      updateLatest();
    }
    if (activeTab === service || activeTab === 'merged') scheduleRender(false);
  }

  function focusSearch() {
    var field = searchField();
    if (!field) return;
    if (typeof field.focus === 'function') field.focus();
    if (typeof field.select === 'function') field.select();
  }

  return {
    open: open,
    close: close,
    clear: clear,
    handleInitial: handleInitial,
    handleOutput: handleOutput,
    handleMatchText: handleMatchText,
    handleNewText: handleNewText,
    render: render,
    focusSearch: focusSearch,
    lineCount: function () { return lines.length; },
  };
};
