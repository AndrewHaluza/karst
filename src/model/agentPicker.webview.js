// ── Karst unified agent picker (agent core + model + effort/variant) ─────────
var AP_MENU_STACK = [];

function apEsc(s) {
  return String(s === null || s === undefined ? '' : s)
    .replace(/[&<>"]/g, function (c) {
      return { '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c];
    });
}

/** Advertised efforts of a model in the live catalog; undefined = none. */
function apEfforts(catalog, provider, modelId) {
  if (!modelId) return undefined;
  var list = (catalog && catalog[provider]) || [];
  for (var i = 0; i < list.length; i++) {
    if (list[i].id === modelId) return list[i].efforts;
  }
  return undefined;
}

/** Advertised capability tags of a model in the live catalog; undefined = none. */
function apTags(catalog, provider, modelId) {
  if (!modelId) return undefined;
  var list = (catalog && catalog[provider]) || [];
  for (var i = 0; i < list.length; i++) {
    if (list[i].id === modelId) return list[i].tags;
  }
  return undefined;
}

// ── model id parsing (design § model menu: routes, vendors, free) ────────────
/**
 * Split a model id into the parts the picker renders (pure, no DOM):
 * `opencode/<m>` → route `opencode`; `openrouter/<vendor>/<m>` → route +
 * vendor; a `#variant` or `:variant` suffix → variant; `:free`/`-free` → free.
 * A curated catalog label that is more than the raw id wins as the model name.
 */
function apParseModelId(id, label) {
  var raw = String(id === null || id === undefined ? '' : id);
  var seg = raw.split('/');
  var out;
  if (seg.length < 2) {
    out = { id: id, route: '', vendor: '', model: label || id || '', free: false, variant: '' };
  } else {
    var last = seg[seg.length - 1];
    var variant = '';
    var free = false;
    var h = last.indexOf('#');
    if (h >= 0) { variant = last.slice(h + 1); last = last.slice(0, h); }
    var c = last.indexOf(':');
    if (c >= 0) {
      var suf = last.slice(c + 1);
      last = last.slice(0, c);
      if (suf === 'free') free = true; else variant = suf;
    }
    if (/-free$/.test(last)) free = true;
    out = {
      id: id, route: seg[0], vendor: seg.slice(1, -1).join('/'),
      model: last, free: free, variant: variant,
    };
  }
  if (label && label !== id) out.model = label;
  return out;
}

/** The host-supplied route meta for a parsed route, or null. */
function apRouteMeta(routes, route) {
  if (!route || !routes || !Object.prototype.hasOwnProperty.call(routes, route)) return null;
  return routes[route] || null;
}

/** The route's display name; the raw id for an unknown route. */
function apRouteName(routes, route) {
  var meta = apRouteMeta(routes, route);
  return meta && meta.name ? meta.name : (route || '');
}

/**
 * The model's display name. A curated catalog label often repeats its gateway
 * ("OpenCode Go · MiMo v2.5"); under the route heading that prefix is noise, so
 * a leading "<route name> · " (or "<route id> · ") is dropped. Any other label
 * — and every raw id — renders unchanged.
 */
function apModelName(parsed, routes) {
  var name = parsed.model || '';
  var prefixes = [apRouteName(routes, parsed.route), parsed.route];
  for (var i = 0; i < prefixes.length; i++) {
    var prefix = prefixes[i];
    if (prefix && name.indexOf(prefix + ' \u00b7 ') === 0) return name.slice(prefix.length + 3);
  }
  return name;
}

/** Stable hue (0-359) for a route's monogram — same id, same colour, always. */
function apRouteHue(route) {
  var s = String(route || '');
  var h = 0;
  for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
  return h;
}

/**
 * The 16px route mark: the host icon plus its subscription badge, or — for an
 * unknown route, or a known one whose asset is missing — a letter monogram on a
 * hue derived from the id. `ui:ICONS-05` item 4 records both as approved.
 */
function apRouteIconHtml(route, routes) {
  if (!route) return '';
  var meta = apRouteMeta(routes, route);
  var icon = meta && meta.iconSvg ? meta.iconSvg : '';
  var mark = icon || ('<span class="ap-mono">' + apEsc(String(route).charAt(0).toUpperCase()) + '</span>');
  var badge = meta && meta.badge ? '<span class="ap-route-badge">' + apEsc(meta.badge) + '</span>' : '';
  var hue = icon ? '' : ' style="--ap-hue:' + apRouteHue(route) + '"';
  return '<span class="ap-route" title="' + apEsc(apRouteName(routes, route)) + '"' + hue
    + ' aria-hidden="true">' + mark + badge + '</span>';
}

/**
 * The two-line model stack: the model name (with its variant) over the gateway
 * vendor. Both lines clip with an ellipsis and point at the trigger, whose
 * accessible name carries the full text (UI-R44).
 */
function apModelStackHtml(parsed, triggerId, routes) {
  var variant = parsed.variant ? '<span class="ap-variant"> ' + apEsc(parsed.variant) + '</span>' : '';
  var vendor = parsed.vendor
    ? '<span class="ap-mvendor" aria-describedby="' + apEsc(triggerId) + '">' + apEsc(parsed.vendor) + '</span>'
    : '';
  return '<span class="ap-mstack">'
    + '<span class="ap-mname" aria-describedby="' + apEsc(triggerId) + '">'
    + apEsc(apModelName(parsed, routes)) + variant + '</span>'
    + vendor
    + '</span>';
}

/** The trigger's accessible name for a routed model: model, vendor, route, full id. */
function apRoutedTriggerName(caption, parsed, routes) {
  var name = apModelName(parsed, routes);
  var via = ' via ' + apRouteName(routes, parsed.route);
  var who = parsed.vendor ? name + ', ' + parsed.vendor + via : name + via;
  return caption + ': ' + who + ' \u2014 ' + parsed.id + (parsed.free ? ', free' : '');
}

/** One row of capability-tag chips; empty when the model advertises none. */
function apModelTagsHtml(tags) {
  if (!tags || tags.length === 0) return '';
  var out = '<div class="ap-model-tags">';
  for (var i = 0; i < tags.length; i++) {
    out += '<span class="ap-tag">' + apEsc(tags[i]) + '</span>';
  }
  return out + '</div>';
}

/** How the Effort field presents: a select, a compact-only disabled "\u2014", or nothing. */
function apEffortMode(efforts, saved, compact) {
  if ((efforts && efforts.length > 0) || saved) return 'select';
  return compact ? 'placeholder' : 'hidden';
}

/** Accessible name / tooltip of the model trigger: label plus the full id. */
function apModelTriggerName(label, id, fallback) {
  if (!label && !id) return fallback;
  if (!id || label === id) return label || id;
  return label + ' \u2014 ' + id;
}

/** The effort options HTML for a model: inherit/none row + advertised efforts. */
function apEffortOptions(catalog, provider, modelId, saved, inheritLabel) {
  var efforts = apEfforts(catalog, provider, modelId);
  if (efforts === undefined || efforts.length === 0) {
    // No model or no advertised efforts: only "inherit/none" is legal. A saved
    // effort is kept so a catalog change never silently drops a configured value.
    return { html: '', efforts: null, savedVisible: saved || '' };
  }
  var out = '<option value=""' + (saved ? '' : ' selected') + '>'
    + apEsc(inheritLabel || 'No effort (agent picks)') + '</option>';
  var seen = false;
  for (var i = 0; i < efforts.length; i++) {
    var v = efforts[i];
    var selected = v === saved ? ' selected' : '';
    if (v === saved) seen = true;
    out += '<option value="' + apEsc(v) + '"' + selected + '>' + apEsc(v) + '</option>';
  }
  if (saved && !seen) {
    out += '<option value="' + apEsc(saved) + '" selected>Saved: ' + apEsc(saved) + '</option>';
  }
  return { html: out, efforts: efforts, savedVisible: '' };
}

/** Core options: inherit row (when labeled) then the offered cores. */
function apCoreOptionsHtml(cores, current, inheritLabel) {
  var out = '';
  if (inheritLabel) {
    out += '<div class="ap-opt' + (current ? '' : ' active') + '" role="option" tabindex="0"'
      + ' data-ap-core="" aria-selected="' + (current ? 'false' : 'true') + '">'
      + apEsc(inheritLabel) + '</div>';
  }
  for (var i = 0; i < cores.length; i++) {
    var c = cores[i];
    var sel = c.id === current;
    out += '<div class="ap-opt' + (sel ? ' active' : '') + '" role="option" tabindex="0"'
      + ' data-ap-core="' + apEsc(c.id) + '" aria-selected="' + (sel ? 'true' : 'false') + '">'
      + (typeof agentBadgeHtml === 'function' ? agentBadgeHtml(c.id) : apEsc(c.label || c.id))
      + '</div>';
  }
  return out;
}

/** One model row: name + variant, capability chips, free tag, saved tag. */
function apModelItemHtml(m, saved, tags, routes) {
  var sel = m.id === saved;
  var p = apParseModelId(m.id, m.label);
  var variant = p.variant ? '<span class="ap-variant"> ' + apEsc(p.variant) + '</span>' : '';
  var free = p.free ? '<span class="ap-free">free</span>' : '';
  // The full id lives in the row's title and data attribute (UI-R44) — the old
  // second line repeated the name the user had just read.
  return '<div class="ap-model-item' + (sel ? ' active' : '') + '" role="option" tabindex="0"'
    + ' data-ap-model="' + apEsc(m.id) + '" aria-selected="' + (sel ? 'true' : 'false') + '"'
    + ' data-ap-full="' + apEsc(m.id) + '" title="' + apEsc(m.id) + '">'
    + '<div class="ap-model-main"><div class="ap-model-name">' + apEsc(apModelName(p, routes)) + variant + '</div>'
    + apModelTagsHtml(tags)
    + '</div>'
    + free
    + (sel ? '<span class="ap-model-tag">saved</span>' : '')
    + '</div>';
}

/** Group models by route, then by vendor — first-appearance order, stable. */
function apModelGroups(models) {
  var groups = [];
  var byRoute = {};
  for (var i = 0; i < models.length; i++) {
    var p = apParseModelId(models[i].id, models[i].label);
    var rk = 'r:' + (p.route || '');
    var g = byRoute[rk];
    if (!g) {
      g = { route: p.route || '', vendors: [], byVendor: {} };
      byRoute[rk] = g;
      groups.push(g);
    }
    var vk = 'v:' + (p.vendor || '');
    var v = g.byVendor[vk];
    if (!v) { v = { vendor: p.vendor || '', models: [] }; g.byVendor[vk] = v; g.vendors.push(v); }
    v.models.push(models[i]);
  }
  return groups;
}

/**
 * The rows a set of models contributes, grouped route → vendor. `skip` drops ids
 * already shown (the "Last used" group). Groups whose every row is skipped are
 * dropped BEFORE their heading is emitted — a heading with no rows under it is
 * noise, not structure.
 */
function apModelListHtml(models, saved, routes, skip, tagsOf) {
  var groups = apModelGroups(models);
  var visible = [];
  for (var gi = 0; gi < groups.length; gi++) {
    var g = groups[gi];
    var vendors = [];
    for (var vi = 0; vi < g.vendors.length; vi++) {
      var v = g.vendors[vi];
      var rows = [];
      for (var mi = 0; mi < v.models.length; mi++) {
        var m = v.models[mi];
        if (skip && skip[m.id]) continue;
        rows.push(m);
      }
      if (rows.length) vendors.push({ vendor: v.vendor, models: rows });
    }
    if (vendors.length) visible.push({ route: g.route, vendors: vendors });
  }
  var named = visible.length > 1 || (visible.length === 1 && visible[0].route !== '');
  var out = '';
  for (var i = 0; i < visible.length; i++) {
    var group = visible[i];
    // A route-less group (plain ids like `claude-opus-5`) has no heading to name:
    // rendering one would leave an empty label sitting over its rows.
    if (named && group.route) {
      out += '<div class="ap-group-label" role="presentation">'
        + apRouteIconHtml(group.route, routes)
        + '<span>' + apEsc(apRouteName(routes, group.route)) + '</span></div>';
    }
    for (var j = 0; j < group.vendors.length; j++) {
      var vg = group.vendors[j];
      if (vg.vendor) out += '<div class="ap-group-sub" role="presentation">' + apEsc(vg.vendor) + '</div>';
      for (var k = 0; k < vg.models.length; k++) {
        out += apModelItemHtml(vg.models[k], saved, tagsOf ? tagsOf(vg.models[k].id) : undefined, routes);
      }
    }
  }
  return out;
}

/** The catalog rows a search query keeps: model, vendor, route id, route name, full id. */
function apFilterModels(models, routes, q) {
  var out = [];
  for (var i = 0; i < models.length; i++) {
    var p = apParseModelId(models[i].id, models[i].label);
    var hay = (String(models[i].label || '') + ' ' + String(models[i].id || '') + ' '
      + p.route + ' ' + p.vendor + ' ' + apRouteName(routes, p.route)).toLowerCase();
    if (hay.indexOf(q) >= 0) out.push(models[i]);
  }
  return out;
}

/** Model options for the selected core: inherit row (when labeled) then models. */
function apModelOptionsHtml(catalog, provider, saved, inheritLabel, recentIds, routes, query) {
  var list = (catalog && catalog[provider]) || [];
  var q = String(query === null || query === undefined ? '' : query).trim().toLowerCase();
  var tagsOf = function (id) { return apTags(catalog, provider, id); };
  if (q) {
    var hits = apFilterModels(list, routes, q);
    if (!hits.length) {
      return list.length
        ? '<div class="ap-empty">No models match "' + apEsc(query) + '".</div>'
        : '<div class="ap-empty">No models listed for this core.</div>';
    }
    return apModelListHtml(hits, saved, routes, {}, tagsOf);
  }
  var out = '';
  if (inheritLabel) {
    out += '<div class="ap-model-item' + (saved ? '' : ' active') + '" role="option" tabindex="0"'
      + ' data-ap-model="" aria-selected="' + (saved ? 'false' : 'true') + '">'
      + '<div class="ap-model-main"><div class="ap-model-name">' + apEsc(inheritLabel) + '</div></div></div>';
  }
  if (list.length === 0) {
    out += '<div class="ap-empty">No models listed for this core.</div>';
  } else {
    // The "Last used" group: models the user actually used recently, newest
    // first, up to 5, rendered BEFORE the full list. Only ids still in the
    // catalog render — a recent id that left the catalog is not a dead option.
    // When the recent set already covers the WHOLE catalog, the header is omitted.
    var recent = [];
    var recentSet = {};
    var recentList = recentIds || [];
    for (var r = 0; r < recentList.length && recent.length < 5; r++) {
      var rid = recentList[r];
      if (recentSet[rid]) continue;
      for (var i = 0; i < list.length; i++) {
        if (list[i].id === rid) {
          recent.push(list[i]);
          recentSet[rid] = true;
          break;
        }
      }
    }
    if (recent.length > 0 && recent.length < list.length) {
      out += '<div class="ap-group-label" role="presentation">Last used</div>';
    }
    for (var k = 0; k < recent.length; k++) {
      out += apModelItemHtml(recent[k], saved, tagsOf(recent[k].id), routes);
    }
    out += apModelListHtml(list, saved, routes, recentSet, tagsOf);
  }
  if (saved && list.length > 0 && !list.some(function (m) { return m.id === saved; })) {
    out += '<div class="ap-group-label" role="presentation">Saved model (unavailable)</div>'
      + '<div class="ap-model-item active" role="option" tabindex="0" data-ap-model="'
      + apEsc(saved) + '" aria-selected="true" data-ap-full="' + apEsc(saved)
      + '" title="' + apEsc(saved) + '"><div class="ap-model-main"><div class="ap-model-name">'
      + apEsc(saved) + '</div></div></div>';
  }
  return out;
}


/**
 * A clipping trigger label points at its trigger (UI-R44). The describedby exists to satisfy
 * layout check (d): a clipped element must carry aria-describedby. The real accessible full
 * text is the trigger's aria-label.
 */
function apTriggerLabelHtml(inner, triggerId) {
  return '<span class="ap-trigger-label" aria-describedby="' + apEsc(triggerId) + '">' + inner + '</span>';
}

/** Compact core trigger name: caption plus the full core label. */
function apCoreTriggerName(caption, coreName) {
  return coreName ? caption + ': ' + coreName : caption;
}

/** The model menu's chrome: search, scroll area, and the full-id footer (UI-R44). */
function apModelMenuHtml() {
  return '<div class="ap-search"><input type="text" placeholder="Search models…"'
    + ' aria-label="Search models" data-ap-search /></div>'
    + '<div class="ap-scroll" data-ap-list="model"></div>'
    + '<div class="ap-menu-foot" aria-live="polite" data-ap-foot></div>';
}

/** The open menu's active row, if any. */
function apActiveOption(shell) {
  return shell ? shell.querySelector('[role="option"].active') : null;
}

/**
 * The row a key or focus event came from, if it came from one of this shell's
 * options. Rows are tabbable, so DOM focus can sit on a row the highlight does
 * not cover; the key must answer from its own row, never from the highlight
 * left somewhere else in the list.
 */
function apOptionAt(shell, target) {
  var row = target && target.closest ? target.closest('[role="option"]') : null;
  return row && shell && shell.contains && shell.contains(row) ? row : null;
}

/**
 * Where keyboard focus sat inside an open menu, if anywhere: the search box or
 * one of the rows. Captured before a re-render replaces the menu's HTML, so a
 * host re-mount can hand focus back — without it focus falls to the document
 * body and the open menu stops answering keys.
 */
function apMenuFocus(menu, doc) {
  var active = doc && doc.activeElement;
  if (!active || !menu || !menu.contains || !menu.contains(active)) return null;
  if (active.hasAttribute && active.hasAttribute('data-ap-search')) return { search: true, model: '' };
  var row = active.closest ? active.closest('[role="option"]') : null;
  return row ? { search: false, model: row.getAttribute('data-ap-model') || '' } : null;
}

/** The rebuilt row matching a captured model id ('' is the inherit row). */
function apMenuFocusRow(list, focus) {
  if (!list || !focus || focus.search) return null;
  var opts = list.querySelectorAll('[role="option"]');
  for (var i = 0; i < opts.length; i++) {
    if ((opts[i].getAttribute('data-ap-model') || '') === focus.model) return opts[i];
  }
  return null;
}

/**
 * The open menu shell that belongs to `root`, if any. The stack is page-global
 * (only one picker menu is open anywhere on the page), but a key pressed in one
 * picker must never move or choose a row in another picker's menu.
 */
function apMenuShellFor(root, stack) {
  var list = stack || [];
  for (var i = list.length - 1; i >= 0; i--) {
    if (root && root.contains && root.contains(list[i])) return list[i];
  }
  return null;
}

/**
 * True when a key event belongs to this shell's open menu: its own rows or the
 * search box (inside the menu), or the trigger that owns it. A key pressed on
 * any OTHER control of the picker (the effort select, the other trigger) must
 * keep its default behaviour instead of choosing the open menu's row.
 */
function apKeyOwnedBy(shell, target) {
  if (!shell || !target || !shell.querySelector) return false;
  var menu = shell.querySelector('[data-ap-menu]');
  var trigger = shell.querySelector('[data-ap-trigger]');
  return !!((menu && menu.contains && menu.contains(target)) || (trigger && trigger === target));
}

/**
 * Mark exactly one row active (index -1 marks none). Every highlight goes
 * through here: adding the class without clearing its predecessor is what left
 * two rows highlighted when a menu was re-opened.
 */
function apMarkActive(items, index) {
  for (var i = 0; i < items.length; i++) {
    items[i].classList.toggle('active', i === index);
  }
}

/** Per-page counter for unique picker trigger ids. */
var AP_SEQ = 0;

/** The identity the core trigger shows: full pattern when a model is set. */
function apCoreTriggerLabel(provider, modelLabel) {
  if (typeof agentIdentityHtml === 'function') {
    return agentIdentityHtml(provider, modelLabel, true);
  }
  return apEsc(provider || '');
}

/**
 * A core switch never carries provider-specific model/effort state across: the
 * new core starts from ITS OWN last used model (the newest recent id still in
 * the catalog), and no effort — an effort belongs to the model that advertises
 * it. With no usable recent model the pick stays empty (inherit / agent picks).
 */
function apCoreSelection(current, core, recentIds, catalog) {
  var nextCore = core || '';
  if (nextCore === current.core) return current;
  return { core: nextCore, model: apLastUsedModel(catalog, nextCore, recentIds), effort: '' };
}

/** The newest recently used model of a core that is still cataloged; '' if none. */
function apLastUsedModel(catalog, provider, recentIds) {
  var list = (catalog && catalog[provider]) || [];
  var recent = recentIds || [];
  for (var r = 0; r < recent.length; r++) {
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === recent[r]) return list[i].id;
    }
  }
  return '';
}

/**
 * The inherit labels that apply to the CURRENT core. A model/effort inherited
 * from settings belongs to the core that was configured there — offering
 * "Inherit (settings: Sonnet 5)" under a different core would inherit a value
 * that core can never use. The core row's own inherit label always stands; the
 * model/effort ones are dropped once an explicitly picked core differs from the
 * inherited one. A host that declares no `inheritCore` keeps every label.
 */
function apInheritLabels(inherit, inheritCore, core) {
  var i = inherit || {};
  var mismatch = !!inheritCore && !!core && inheritCore !== core;
  return {
    core: i.core || '',
    model: mismatch ? '' : (i.model || ''),
    effort: mismatch ? '' : (i.effort || ''),
  };
}

/** presetMode opening tab: the preset tab when a preset is selected, else core + model. */
function apInitialMode(pm) {
  return pm && pm.selected ? 'preset' : 'core';
}

/** Segmented Preset | Core + model control (ui:UI-R26 radiogroup, aria-checked). */
function apModeBarHtml(mode) {
  function btn(id, label) {
    return '<button type="button" role="radio" class="k-btn k-btn--secondary k-btn--sm ap-seg-btn" data-ap-mode="'
      + id + '" aria-checked="' + (mode === id ? 'true' : 'false') + '">' + label + '</button>';
  }
  return '<div class="ap-seg" role="radiogroup" aria-label="Agent source">'
    + btn('preset', 'Preset') + btn('core', 'Core + model') + '</div>';
}

/** Preset select options: the inherit row, every name, and a saved name that left `names`. */
function apPresetOptionsHtml(pm, sel) {
  var names = (pm && pm.names) || [];
  var out = ['<option value=""' + (sel ? '' : ' selected') + '>' + apEsc(pm && pm.inheritLabel) + '</option>'];
  for (var i = 0; i < names.length; i++) {
    out.push('<option value="' + apEsc(names[i]) + '"' + (names[i] === sel ? ' selected' : '') + '>' + apEsc(names[i]) + '</option>');
  }
  if (sel && names.indexOf(sel) < 0) {
    out.push('<option value="' + apEsc(sel) + '" selected>' + apEsc(sel) + '</option>');
  }
  return out.join('');
}

/** Render the whole picker into the given root. Returns the live value object. */
function mountAgentPicker(root, opts) {
  if (!root) return null;
  var o = opts || {};
  // Idempotent re-mount: the surfaces re-render on every state push, so calling
  // mount again on an already-mounted root updates its options/state in place
  // instead of rebuilding the DOM (and duplicating document listeners).
  if (root.__apInstance) {
    root.__apInstance._configure(o);
    root.__apInstance.setValue(o.value || {});
    return root.__apInstance;
  }
  var cores = o.cores || [];
  var catalog = o.catalog || {};
  var recent = o.recent || {};
  // Route identity (routeIdentity.ts, emitted as AP_ROUTES): route id → name,
  // badge, icon. Absent = the pre-route look (no icon, no vendor line).
  var routes = o.routes || {};
  var value = o.value || {};
  var inherit = o.inherit || {};
  // The core the inherit labels came from (settings / the parent level). The
  // model + effort inherit rows are offered only while the picked core is that
  // core — see apInheritLabels.
  var inheritCore = o.inheritCore || '';
  var showEffort = o.showEffort !== false;
  var disabled = !!o.disabled;
  // compact: captions become screen-reader-only and the core trigger shows the
  // provider alone (the Model field beside it already says which model).
  var compact = !!o.compact;
  var onChange = o.onChange;
  var state = {
    core: value.core || '',
    model: value.model || '',
    effort: value.effort || '',
  };
  // presetMode (opt-in): a Preset | Core + model switch. Absent = the markup
  // and the onChange payload stay exactly as before.
  var pm = o.presetMode || null;
  var mode = apInitialMode(pm);
  var preset = pm && pm.selected ? pm.selected : '';
  var presetSeen = preset;
  var labelModel = o.labels && o.labels.model ? o.labels.model : 'Model';
  var labelEffort = o.labels && o.labels.effort ? o.labels.effort : 'Effort / variant';

  var apId = 'ap-' + (++AP_SEQ);
  root.innerHTML = '<div class="ap' + (compact ? ' ap-compact' : '') + '">'
    + (pm
      ? apModeBarHtml(mode)
        + '<div class="ap-field" data-ap-preset-field><label class="ap-label">Preset</label>'
        + '<select class="ap-effort" data-ap-preset aria-label="Preset"></select>'
        + '<div class="ap-warn" data-ap-preset-warn role="alert" hidden></div></div>'
      : '')
    + '<div class="ap-field" data-ap-core-field>'
    + '<label class="ap-label">' + (o.labels && o.labels.core ? apEsc(o.labels.core) : 'Agent core') + '</label>'
    + '<div class="ap-shell" data-ap-shell="core">'
    + '<button type="button" class="ap-trigger" id="' + apId + '-core" data-ap-trigger="core"' + (compact ? ' aria-label="' + apEsc(o.labels && o.labels.core ? o.labels.core : 'Agent core') + '"' : '') + ' aria-haspopup="listbox" aria-expanded="false"></button>'
    + '<div class="ap-menu" data-ap-menu="core" role="listbox" hidden></div>'
    + '</div></div>'
    + '<div class="ap-field">'
    + '<label class="ap-label">' + apEsc(labelModel) + '</label>'
    + '<div class="ap-shell" data-ap-shell="model">'
    + '<button type="button" class="ap-trigger" id="' + apId + '-model" data-ap-trigger="model"' + (compact ? ' aria-label="' + apEsc(labelModel) + '"' : '') + ' aria-haspopup="listbox" aria-expanded="false"></button>'
    + '<div class="ap-menu" data-ap-menu="model" role="listbox" hidden>'
    + apModelMenuHtml()
    + '</div></div></div>'
    + '<div class="ap-field ap-effort-field" data-ap-effort-field hidden>'
    + '<label class="ap-label">' + apEsc(labelEffort) + '</label>'
    + '<select class="ap-effort" data-ap-effort aria-label="' + apEsc(labelEffort) + '"></select>'
    + '</div>'
    + '</div>';

  var $ = function (sel) { return root.querySelector(sel); };

  /** The inherit labels legal for the CURRENTLY selected core. */
  function labels() { return apInheritLabels(inherit, inheritCore, state.core); }

  function render() {
    var coreMenu = $('[data-ap-menu="core"]');
    coreMenu.innerHTML = apCoreOptionsHtml(cores, state.core, labels().core);
    renderModel();
    renderMode();
  }

  /** presetMode only: tab state, which fields show, the preset select + missing warning. */
  function renderMode() {
    if (!pm) return;
    var bars = root.querySelectorAll('[data-ap-mode]');
    for (var i = 0; i < bars.length; i++) {
      bars[i].setAttribute('aria-checked', bars[i].getAttribute('data-ap-mode') === mode ? 'true' : 'false');
    }
    var inPreset = mode === 'preset';
    $('[data-ap-preset-field]').hidden = !inPreset;
    $('[data-ap-shell="core"]').parentNode.hidden = inPreset;
    $('[data-ap-shell="model"]').parentNode.hidden = inPreset;
    var sel = $('[data-ap-preset]');
    sel.innerHTML = apPresetOptionsHtml(pm, preset);
    sel.disabled = disabled;
    var missing = !!preset && (pm.names || []).indexOf(preset) < 0;
    var warn = $('[data-ap-preset-warn]');
    warn.hidden = !missing;
    warn.textContent = missing ? 'Preset ' + preset + ' not found' : '';
    renderEffort();
  }

  function setMode(next, quiet) {
    if (!pm || (next !== 'preset' && next !== 'core') || next === mode) return;
    mode = next;
    renderMode();
    if (!quiet) emit();
  }

  function modelLabel() {
    var list = (catalog && catalog[state.core]) || [];
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === state.model) return list[i].label;
    }
    return state.model;
  }

  function renderModel() {
    var modelTrigger = $('[data-ap-trigger="model"]');
    var modelMenu = $('[data-ap-menu="model"]');
    // Hosts re-mount onto this root on every state push, which re-renders this
    // menu in place. An open menu must survive the rebuild with its focus: the
    // replaced search box would otherwise drop focus to the body and the
    // keydown listener would never see another key.
    var wasOpen = !!(modelMenu && !modelMenu.hidden);
    var focused = wasOpen ? apMenuFocus(modelMenu, document) : null;
    modelMenu.innerHTML = apModelMenuHtml();
    $('[data-ap-list="model"]').innerHTML = apModelOptionsHtml(
      catalog, state.core, state.model, labels().model, recent[state.core], routes,
    );
    var coreLabel = modelLabel();
    var coreTrigger = $('[data-ap-trigger="core"]');
    coreTrigger.innerHTML =
      apTriggerLabelHtml(apCoreTriggerLabel(state.core, compact ? '' : (coreLabel || '')), apId + '-core')
      + '<span class="chev" aria-hidden="true"></span>';
    if (compact) {
      coreTrigger.setAttribute('aria-label', apCoreTriggerName(
        o.labels && o.labels.core ? o.labels.core : 'Agent core', (coreTrigger.textContent || '').trim()));
    }
    // A routed model (opencode/…, openrouter/…) renders the route mark, then the
    // model name over its gateway vendor. An unrouted id renders exactly as before.
    var parsed = apParseModelId(state.model, coreLabel);
    if (parsed.route) {
      modelTrigger.innerHTML = apRouteIconHtml(parsed.route, routes)
        + apModelStackHtml(parsed, apId + '-model', routes)
        + (parsed.free ? '<span class="ap-free">free</span>' : '')
        + '<span class="chev" aria-hidden="true"></span>';
      var stackName = apRoutedTriggerName(labelModel, parsed, routes);
      modelTrigger.title = stackName;
      modelTrigger.setAttribute('aria-label', stackName);
    } else {
      modelTrigger.innerHTML =
        apTriggerLabelHtml(apEsc(coreLabel || labels().model || 'No model (agent picks)'), apId + '-model')
        + '<span class="chev" aria-hidden="true"></span>';
      var triggerName = apModelTriggerName(coreLabel, state.model, labels().model || 'No model (agent picks)');
      modelTrigger.title = triggerName;
      if (compact) modelTrigger.setAttribute('aria-label', labelModel + ': ' + triggerName);
      else modelTrigger.removeAttribute('aria-label');
    }
    if (wasOpen) {
      var modelShell = $('[data-ap-shell="model"]');
      var back = focused && focused.search
        ? modelMenu.querySelector('[data-ap-search]')
        : apMenuFocusRow($('[data-ap-list="model"]'), focused);
      if (back && back.focus) back.focus();
      syncMenuFoot(modelShell);
    }
    renderEffort();
  }

  function renderEffort() {
    var field = $('[data-ap-effort-field]');
    var sel = $('[data-ap-effort]');
    if (!showEffort || (pm && mode === 'preset')) { field.hidden = true; return; }
    var efforts = apEfforts(catalog, state.core, state.model);
    var effortMode = apEffortMode(efforts, state.effort, compact);
    if (effortMode === 'placeholder') {
      // Compact only: the model advertises no efforts and none is saved. Keep the
      // field in the grid with a disabled, dashed "—" so Core/Model/Effort stay aligned.
      field.hidden = false;
      sel.disabled = true;
      sel.classList.add('ap-effort--na');
      sel.innerHTML = '<option value="" selected>\u2014</option>';
      sel.setAttribute('aria-label', apEsc(labelEffort) + ': not available for this model');
      state.effort = '';
      return;
    }
    sel.classList.remove('ap-effort--na');
    sel.disabled = disabled;
    if (effortMode === 'hidden') {
      field.hidden = true;
      state.effort = '';
      return;
    }
    field.hidden = false;
    var effortInherit = labels().effort || (compact ? 'No effort' : '');
    var built = apEffortOptions(catalog, state.core, state.model, state.effort, effortInherit);
    sel.innerHTML = built.html || '<option value="" selected>' + apEsc(effortInherit || 'No effort (agent picks)') + '</option>';
  }

  function emit() {
    if (typeof onChange !== 'function') return;
    if (!pm) { onChange({ core: state.core, model: state.model, effort: state.effort }); return; }
    // presetMode: one source at a time — a preset clears the identity trio, the
    // core tab clears the preset.
    onChange(mode === 'preset'
      ? { mode: mode, preset: preset, core: '', model: '', effort: '' }
      : { mode: mode, preset: '', core: state.core, model: state.model, effort: state.effort });
  }

  /** Point the footer at the keyboard-active row's full id (UI-R44). */
  function syncMenuFoot(shell) {
    if (!shell) return;
    var foot = shell.querySelector('[data-ap-foot]');
    if (!foot) return;
    var active = apActiveOption(shell);
    foot.textContent = active ? (active.getAttribute('data-ap-full') || '') : '';
  }

  /** Move the keyboard-active row by one; headings are not options, so they are skipped. */
  function moveActive(shell, delta, target) {
    var items = shell.querySelectorAll('[role="option"]');
    if (!items.length) return;
    // A row carries DOM focus when the user tabbed into the list; moving the
    // highlight away from it would leave Enter answering the old row.
    var focused = apOptionAt(shell, target);
    var current = focused || apActiveOption(shell);
    var idx = -1;
    for (var i = 0; i < items.length; i++) if (items[i] === current) { idx = i; break; }
    var next = idx < 0 ? (delta > 0 ? 0 : items.length - 1) : idx + delta;
    if (next < 0) next = 0;
    if (next > items.length - 1) next = items.length - 1;
    apMarkActive(items, next);
    if (focused && items[next].focus) items[next].focus();
    if (items[next].scrollIntoView) items[next].scrollIntoView({ block: 'nearest' });
    syncMenuFoot(shell);
  }

  function setDisabled(on) {
    disabled = !!on;
    var triggers = root.querySelectorAll('[data-ap-trigger]');
    for (var i = 0; i < triggers.length; i++) triggers[i].disabled = disabled;
    var effort = $('[data-ap-effort]');
    if (effort) effort.disabled = disabled || effort.classList.contains('ap-effort--na');
    if (pm) {
      var presetSel = $('[data-ap-preset]');
      if (presetSel) presetSel.disabled = disabled;
      var segs = root.querySelectorAll('[data-ap-mode]');
      for (var s = 0; s < segs.length; s++) segs[s].disabled = disabled;
    }
  }

  function openMenu(kind) {
    AP_MENU_STACK.forEach(function (sh) { closeMenu(sh, false); });
    var shell = $('[data-ap-shell="' + kind + '"]');
    var menu = $('[data-ap-menu="' + kind + '"]');
    var trigger = $('[data-ap-trigger="' + kind + '"]');
    if (!shell || !menu) return;
    AP_MENU_STACK.push(shell);
    shell.classList.add('is-open');
    menu.hidden = false;
    trigger.setAttribute('aria-expanded', 'true');
    if (kind === 'core') renderCoreActive();
    if (kind === 'model') {
      var list = $('[data-ap-list="model"]');
      var opts = list ? list.querySelectorAll('[role="option"]') : [];
      var selected = list ? list.querySelector('[role="option"][aria-selected="true"]') : null;
      var index = 0;
      for (var i = 0; i < opts.length; i++) if (opts[i] === selected) { index = i; break; }
      apMarkActive(opts, opts.length ? index : -1);
      var search = menu.querySelector('[data-ap-search]');
      if (search && search.focus) search.focus();
      syncMenuFoot(shell);
    }
  }

  function closeMenu(shell, returnFocus) {
    var idx = AP_MENU_STACK.indexOf(shell);
    if (idx >= 0) AP_MENU_STACK.splice(idx, 1);
    shell.classList.remove('is-open');
    var menu = shell.querySelector('[data-ap-menu]');
    if (menu) menu.hidden = true;
    var trigger = shell.querySelector('[data-ap-trigger]');
    if (trigger) trigger.setAttribute('aria-expanded', 'false');
    if (returnFocus && trigger && trigger.focus) trigger.focus();
  }

  function renderCoreActive() {
    var menu = $('[data-ap-menu="core"]');
    var items = menu.querySelectorAll('[role="option"]');
    for (var i = 0; i < items.length; i++) {
      var on = items[i].getAttribute('data-ap-core') === state.core;
      items[i].classList.toggle('active', on);
      items[i].setAttribute('aria-selected', on ? 'true' : 'false');
    }
  }

  root.addEventListener('click', function (e) {
    var t = e.target;
    var modeBtn = t.closest ? t.closest('[data-ap-mode]') : null;
    if (modeBtn) {
      if (!disabled) setMode(modeBtn.getAttribute('data-ap-mode'));
      return;
    }
    var coreOpt = t.closest ? t.closest('[data-ap-core]') : null;
    if (coreOpt) {
      var nextCore = coreOpt.getAttribute('data-ap-core') || '';
      state = apCoreSelection(state, nextCore, recent[nextCore], catalog);
      var shell = $('[data-ap-shell="core"]');
      closeMenu(shell, false);
      render();
      emit();
      return;
    }
    var modelOpt = t.closest ? t.closest('[data-ap-model]') : null;
    if (modelOpt) {
      state.model = modelOpt.getAttribute('data-ap-model');
      state.effort = '';
      var ms = $('[data-ap-shell="model"]');
      closeMenu(ms, false);
      renderModel();
      emit();
      return;
    }
    var trigger = t.closest ? t.closest('[data-ap-trigger]') : null;
    if (trigger) {
      var kind = trigger.getAttribute('data-ap-trigger');
      var sh = $('[data-ap-shell="' + kind + '"]');
      if (AP_MENU_STACK.indexOf(sh) >= 0) closeMenu(sh, true);
      else openMenu(kind);
      return;
    }
  });

  root.addEventListener('change', function (e) {
    if (e.target && e.target.getAttribute && e.target.getAttribute('data-ap-preset') !== null) {
      preset = e.target.value || '';
      renderMode();
      emit();
      return;
    }
    var effort = e.target && e.target.getAttribute && e.target.getAttribute('data-ap-effort');
    if (effort !== null) {
      state.effort = e.target.value || '';
      // opencode: effort IS the model variant — picking one must drop the
      // other, same rule model-select already applies in reverse (line ~479).
      if (state.effort && state.core === 'opencode') {
        state.model = '';
        renderModel();
      }
      emit();
    }
  });

  root.addEventListener('input', function (e) {
    var search = e.target && e.target.getAttribute && e.target.getAttribute('data-ap-search');
    if (search === null) return;
    var listEl = $('[data-ap-list="model"]');
    if (!listEl) return;
    listEl.innerHTML = apModelOptionsHtml(
      catalog, state.core, state.model, labels().model, recent[state.core], routes, e.target.value,
    );
    var items = listEl.querySelectorAll('[role="option"]');
    apMarkActive(items, items.length ? 0 : -1);
    syncMenuFoot($('[data-ap-shell="model"]'));
  });

  // Tabbing into the list lands on a row: the highlight and the footer must
  // follow focus, so the row under the keyboard is the one Enter answers.
  root.addEventListener('focusin', function (e) {
    var shell = apMenuShellFor(root, AP_MENU_STACK);
    var row = apOptionAt(shell, e.target);
    if (!row) return;
    var items = shell.querySelectorAll('[role="option"]');
    for (var i = 0; i < items.length; i++) {
      if (items[i] === row) {
        apMarkActive(items, i);
        syncMenuFoot(shell);
        return;
      }
    }
  });

  root.addEventListener('keydown', function (e) {
    // Another picker's menu can sit on top of the page-global stack; only this
    // root's own menu may answer this picker's keys.
    var shell = apMenuShellFor(root, AP_MENU_STACK);
    if (!shell) return;
    // Escape dismisses this picker's open menu from anywhere inside the picker;
    // the action keys stay scoped to the menu itself.
    if (e.key === 'Escape') {
      closeMenu(shell, true);
      return;
    }
    if (!apKeyOwnedBy(shell, e.target)) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      moveActive(shell, e.key === 'ArrowDown' ? 1 : -1, e.target);
      return;
    }
    if (e.key === 'Enter') {
      // The focused row wins: a key pressed on a row that is not highlighted
      // must choose that row, not the highlight (review finding, round 4).
      var row = apOptionAt(shell, e.target) || apActiveOption(shell);
      if (!row) return;
      e.preventDefault();
      row.click();
    }
  });

  document.addEventListener('click', function (e) {
    if (AP_MENU_STACK.length && !(e.target.closest && e.target.closest('.ap'))) {
      while (AP_MENU_STACK.length) closeMenu(AP_MENU_STACK[AP_MENU_STACK.length - 1], false);
    }
  });

  setDisabled(disabled);
  render();
  var instance = {
    getValue: function () { return { core: state.core, model: state.model, effort: state.effort }; },
    setValue: function (v) {
      state.core = (v && v.core) || '';
      state.model = (v && v.model) || '';
      state.effort = (v && v.effort) || '';
      render();
    },
    setDisabled: setDisabled,
    setMode: setMode,
    // Reconfigure the option source + callbacks without rebuilding the DOM —
    // the re-mount path on a state push.
    _configure: function (next) {
      cores = (next && next.cores) || [];
      catalog = (next && next.catalog) || {};
      recent = (next && next.recent) || {};
      routes = (next && next.routes) || {};
      inherit = (next && next.inherit) || {};
      inheritCore = (next && next.inheritCore) || '';
      showEffort = next ? next.showEffort !== false : true;
      disabled = !!(next && next.disabled);
      onChange = next && next.onChange;
      if (pm && next && next.presetMode) {
        // The host's selected preset drives the tab only when IT changed; a tab
        // the user flipped by hand survives a same-value state push.
        pm = next.presetMode;
        var nextSel = pm.selected || '';
        if (nextSel !== presetSeen) {
          presetSeen = nextSel;
          preset = nextSel;
          mode = apInitialMode(pm);
        }
      }
      setDisabled(disabled);
    },
  };
  root.__apInstance = instance;
  return instance;
}
