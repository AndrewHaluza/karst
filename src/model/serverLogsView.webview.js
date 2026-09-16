// ── Karst shared server-logs surface ────────────────────────────────────────
//
// Search, run scoping, clear and ANSI rendering for the combined server-logs
// view — ONE implementation both webviews include (the in-dashboard surface and
// the standalone panel), delivered by marker injection exactly like the agent
// picker (`agentPicker.webview.js`): a self-contained webview cannot import TS.
//
//   window.createServerLogsView({ post, detached, onClose })
//
// returns `{ open, close, clear, handleInitial, handleOutput, render,
// focusSearch }`.
//
//   post       sends a webview-to-host message (`server-logs-detach`).
//   detached   true omits the "Open in Window" control — the standalone panel
//              has no second window to open.
//   onClose    lets the host clear its own open flag and stop tailing when the
//              surface closes; when absent, `close()` posts `server-logs-close`
//              itself.
//
// The line helpers below are a VERBATIM mirror of
// `src/ui/dashboard/logLine.ts` (plus `RUN_MARKER_PREFIX`/`isRunMarker` from
// `src/runtime/serverLog.ts`), exported as `KARST_SERVER_LOGLINE` — the
// mirrored-constants pattern in `docs/ui/UI-INVARIANTS.md`. The TS module stays
// the tested source of truth: `webview.test.ts` pins the two decoders together,
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

  /** Split raw log text into render-ready records, `seq` counting from `startSeq`. */
  function toLogLines(service, text, startSeq) {
    if (text === '') return [];
    var rawLines = text.split('\n');
    if (rawLines[rawLines.length - 1] === '') rawLines.pop();
    return rawLines.map(function (raw, index) {
      var line = raw.slice(-1) === '\r' ? raw.slice(0, -1) : raw;
      var plain = stripAnsi(line);
      return {
        service: service,
        ts: parseTimestamp(plain),
        seq: startSeq + index,
        plain: plain,
        segments: decodeAnsi(line),
        marker: isRunMarker(plain),
      };
    });
  }

  /** The lines from the last run marker onward, that marker included. */
  function currentRun(lines) {
    for (var i = lines.length - 1; i >= 0; i--) {
      if (lines[i].marker) return lines.slice(i);
    }
    return lines.slice();
  }

  /** Order by timestamp when both have one, else by sequence. */
  function compareLines(a, b) {
    if (a.ts !== null && b.ts !== null) return a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0;
    if (a.ts === null && b.ts === null) return a.seq - b.seq;
    return a.ts === null ? 1 : -1;
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
    toLogLines: toLogLines,
    currentRun: currentRun,
    compareLines: compareLines,
    matchesQuery: matchesQuery,
    isRunMarker: isRunMarker,
    RUN_MARKER_PREFIX: RUN_MARKER_PREFIX,
  };
})();

window.createServerLogsView = function (opts) {
  var o = opts || {};
  var post = typeof o.post === 'function' ? o.post : function () {};
  var detached = o.detached === true;
  var onClose = typeof o.onClose === 'function' ? o.onClose : null;

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
  var matchIndex = 0;
  var nextSeq = 0;

  function doc() { return typeof document === 'undefined' ? null : document; }
  function box() { var d = doc(); return d ? d.getElementById('logsView') : null; }
  function host() { var d = doc(); return d ? d.getElementById('logsHost') : null; }
  function searchField() { var d = doc(); return d ? d.getElementById('logsSearch') : null; }
  function hasQuery() { return query.trim() !== ''; }

  function buildShell() {
    var b = box();
    if (!b) return;
    var detach = detached ? ''
      : '<button type="button" class="k-btn k-btn--ghost k-btn--sm" data-log-detach>Open in Window</button>';
    b.innerHTML = '<div class="thead">'
      + '<span class="ttitle">Server Logs</span>'
      + '<span class="logcontrols">'
      + '<input class="k-input" id="logsSearch" type="search" placeholder="Search logs" aria-label="Search logs">'
      + '<span id="logsMatches"></span>'
      + '<button type="button" class="k-btn k-btn--ghost k-btn--sm" data-log-prev aria-label="Previous match" title="Previous match">Prev</button>'
      + '<button type="button" class="k-btn k-btn--ghost k-btn--sm" data-log-next aria-label="Next match" title="Next match">Next</button>'
      + '<label class="logcheck"><input type="checkbox" data-log-filter> Filter</label>'
      + '<label class="logcheck"><input type="checkbox" data-log-current-run> Current run only</label>'
      + '<button type="button" class="k-btn k-btn--ghost k-btn--sm" data-log-clear>Clear</button>'
      + detach
      + '</span>'
      + '<span class="sp"><button type="button" class="k-btn k-btn--ghost k-btn--sm" data-log-close title="Close the logs view">Close</button></span>'
      + '</div>'
      + '<div class="tstatus" id="logsStatus" role="status"></div>'
      + '<div class="tabs" id="logsTabs"></div>'
      + '<div id="logsHost" class="loghost" tabindex="0"></div>';
    bindShell(b);
  }

  function tabButton(tab, label) {
    return '<button type="button" class="tab' + (activeTab === tab ? ' active' : '') + '"'
      + ' data-log-tab="' + esc(tab) + '">' + esc(label) + '</button>';
  }

  function bindShell(root) {
    root.addEventListener('click', function (e) {
      var target = e.target;
      if (!target || !target.closest) return;
      if (target.closest('[data-log-close]')) { close(); return; }
      var tab = target.closest('[data-log-tab]');
      if (tab) {
        activeTab = tab.getAttribute('data-log-tab') || 'merged';
        matchIndex = 0;
        renderContent();
        return;
      }
      if (target.closest('[data-log-prev]')) { step(-1); return; }
      if (target.closest('[data-log-next]')) { step(1); return; }
      if (target.closest('[data-log-clear]')) { clear(); return; }
      if (target.closest('[data-log-detach]')) { post({ type: 'server-logs-detach' }); return; }
    });

    root.addEventListener('input', function (e) {
      var target = e.target;
      if (target && target.id === 'logsSearch') {
        query = target.value || '';
        matchIndex = 0;
        renderContent();
      }
    });

    root.addEventListener('change', function (e) {
      var target = e.target;
      if (!target || !target.hasAttribute) return;
      if (target.hasAttribute('data-log-filter')) {
        filterOn = !!target.checked;
        matchIndex = 0;
        renderContent();
        return;
      }
      if (target.hasAttribute('data-log-current-run')) {
        currentRunOnly = !!target.checked;
        matchIndex = 0;
        renderContent();
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
      if (e.target !== field) return;
      if (e.key === 'Escape') {
        query = '';
        if (field) field.value = '';
        matchIndex = 0;
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

  function setMatchCount(count) {
    var el = doc() ? doc().getElementById('logsMatches') : null;
    if (!el) return;
    if (!hasQuery()) { el.textContent = ''; return; }
    el.textContent = count === 0 ? 'no matches' : count + ' matches';
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
    var ts = line.ts ? ' <span class="ts">' + esc(line.ts) + '</span>' : '';
    return { html: '<div class="logline">' + prefix + ts + ' ' + body + '</div>', hits: hits };
  }

  function emptyText(filtering) {
    if (filtering) return 'No lines match this search.';
    if (loading) return 'Loading…';
    return activeTab === 'merged' ? 'No log output available.' : 'No log output for this service.';
  }

  function renderTabs() {
    var tabsEl = doc() ? doc().getElementById('logsTabs') : null;
    if (!tabsEl) return;
    if (!services.length) { tabsEl.innerHTML = ''; return; }
    var html = tabButton('merged', 'Merged');
    for (var i = 0; i < services.length; i++) html += tabButton(services[i], services[i]);
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
  }

  function renderContent() {
    var h = host();
    if (!h) return;
    if (activeTab !== 'merged' && services.indexOf(activeTab) === -1) activeTab = 'merged';
    renderTabs();
    var statusEl = doc() ? doc().getElementById('logsStatus') : null;
    if (statusEl) statusEl.textContent = loading ? 'Loading server logs…' : '';

    // Only auto-scroll if the reader was already at (or near) the bottom —
    // otherwise new output would yank them away from a line they scrolled up to read.
    var wasAtBottom = h.scrollHeight - h.scrollTop - h.clientHeight < 32;

    // The pipeline, in order: tab filter, run scope, chronological sort, search.
    var shown = activeTab === 'merged'
      ? lines.slice()
      : lines.filter(function (l) { return l.service === activeTab; });
    if (currentRunOnly) shown = KARST_SERVER_LOGLINE.currentRun(shown);
    shown.sort(KARST_SERVER_LOGLINE.compareLines);
    var filtering = filterOn && hasQuery();
    if (filtering) {
      shown = shown.filter(function (l) { return KARST_SERVER_LOGLINE.matchesQuery(l, query); });
    }

    if (shown.length === 0) {
      h.innerHTML = '<div class="blurb">' + esc(emptyText(filtering)) + '</div>';
      setMatchCount(0);
      if (wasAtBottom) h.scrollTop = h.scrollHeight;
      return;
    }

    var html = '';
    var hits = 0;
    for (var i = 0; i < shown.length; i++) {
      var built = lineHtml(shown[i]);
      html += built.html;
      hits += built.hits;
    }
    h.innerHTML = html;
    setMatchCount(hits);
    paintMatch(false);
    if (wasAtBottom) h.scrollTop = h.scrollHeight;
  }

  function render() {
    if (!box()) return;
    if (!host()) buildShell();
    if (!host()) return;
    renderContent();
  }

  function open() {
    loading = true;
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
    matchIndex = 0;
    nextSeq = 0;
    if (onClose) onClose();
    else post({ type: 'server-logs-close' });
  }

  function clear() {
    lines = [];
    matchIndex = 0;
    renderContent();
  }

  function handleInitial(servers) {
    lines = [];
    services = [];
    nextSeq = 0;
    var list = servers || [];
    for (var i = 0; i < list.length; i++) {
      var server = list[i] || {};
      var service = server.service || '';
      if (service && services.indexOf(service) === -1) services.push(service);
      var parsed = KARST_SERVER_LOGLINE.toLogLines(service, server.content || '', nextSeq);
      nextSeq += parsed.length;
      for (var j = 0; j < parsed.length; j++) lines.push(parsed[j]);
    }
    loading = false;
    render();
  }

  function handleOutput(service, text) {
    if (service && services.indexOf(service) === -1) services.push(service);
    var parsed = KARST_SERVER_LOGLINE.toLogLines(service, text || '', nextSeq);
    nextSeq += parsed.length;
    for (var i = 0; i < parsed.length; i++) lines.push(parsed[i]);
    if (activeTab === service || activeTab === 'merged') renderContent();
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
    render: render,
    focusSearch: focusSearch,
  };
};
