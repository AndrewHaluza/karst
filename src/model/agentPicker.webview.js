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
function apModelStackHtml(parsed, triggerId) {
  var variant = parsed.variant ? '<span class="ap-variant"> ' + apEsc(parsed.variant) + '</span>' : '';
  var vendor = parsed.vendor
    ? '<span class="ap-mvendor" aria-describedby="' + apEsc(triggerId) + '">' + apEsc(parsed.vendor) + '</span>'
    : '';
  return '<span class="ap-mstack">'
    + '<span class="ap-mname" aria-describedby="' + apEsc(triggerId) + '">'
    + apEsc(parsed.model) + variant + '</span>'
    + vendor
    + '</span>';
}

/** The trigger's accessible name for a routed model: model, vendor, route, full id. */
function apRoutedTriggerName(caption, parsed, routes) {
  var via = ' via ' + apRouteName(routes, parsed.route);
  var who = parsed.vendor ? parsed.model + ', ' + parsed.vendor + via : parsed.model + via;
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

/** Model options for the selected core: inherit row (when labeled) then models. */
function apModelOptionsHtml(catalog, provider, saved, inheritLabel, recentIds) {
  var list = (catalog && catalog[provider]) || [];
  var out = '';
  if (inheritLabel) {
    out += '<div class="ap-model-item' + (saved ? '' : ' active') + '" role="option" tabindex="0"'
      + ' data-ap-model="" aria-selected="' + (saved ? 'false' : 'true') + '">'
      + '<div><div class="ap-model-name">' + apEsc(inheritLabel) + '</div></div></div>';
  }
  if (list.length === 0) {
    out += '<div class="ap-empty">No models listed for this core.</div>';
  } else {
    // The "Last used" group: models the user actually used recently, newest
    // first, up to 5, rendered BEFORE the full list. Only ids still in the
    // catalog render — a recent id that left the catalog is not a dead option.
    // A recently used model that IS the current selection draws its saved/active
    // tag inside the group, exactly like it would in the flat list. When the
    // recent set already covers the WHOLE catalog (a provider with few models),
    // the header is omitted — a "Last used" label over a list that is all one
    // group adds noise, not structure.
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
      out += '<div class="ap-group-label">Last used</div>';
    }
    for (var k = 0; k < recent.length; k++) {
      out += apModelItemHtml(recent[k], saved, apTags(catalog, provider, recent[k].id));
    }
    for (var j = 0; j < list.length; j++) {
      if (recentSet[list[j].id]) continue;
      var m = list[j];
      var sel = m.id === saved;
      var mTags = apTags(catalog, provider, m.id);
      out += '<div class="ap-model-item' + (sel ? ' active' : '') + '" role="option" tabindex="0"'
        + ' data-ap-model="' + apEsc(m.id) + '" aria-selected="' + (sel ? 'true' : 'false') + '">'
        + '<div><div class="ap-model-name">' + apEsc(m.label) + '</div>'
        + '<div class="ap-model-sub">' + apEsc(m.id) + '</div>'
        + apModelTagsHtml(mTags)
        + '</div>'
        + (sel ? '<span class="ap-model-tag">saved</span>' : '')
        + '</div>';
    }
  }
  if (saved && list.length > 0 && !list.some(function (m) { return m.id === saved; })) {
    out += '<div class="ap-group-label">Saved model (unavailable)</div>'
      + '<div class="ap-model-item active" role="option" tabindex="0" data-ap-model="'
      + apEsc(saved) + '" aria-selected="true"><div><div class="ap-model-name">'
      + apEsc(saved) + '</div></div></div>';
  }
  return out;
}

/** One model row — shared by the "Last used" group and the full list. */
function apModelItemHtml(m, saved, tags) {
  var sel = m.id === saved;
  return '<div class="ap-model-item' + (sel ? ' active' : '') + '" role="option" tabindex="0"'
    + ' data-ap-model="' + apEsc(m.id) + '" aria-selected="' + (sel ? 'true' : 'false') + '">'
    + '<div><div class="ap-model-name">' + apEsc(m.label) + '</div>'
    + '<div class="ap-model-sub">' + apEsc(m.id) + '</div>'
    + apModelTagsHtml(tags)
    + '</div>'
    + (sel ? '<span class="ap-model-tag">saved</span>' : '')
    + '</div>';
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
  var labelModel = o.labels && o.labels.model ? o.labels.model : 'Model';
  var labelEffort = o.labels && o.labels.effort ? o.labels.effort : 'Effort / variant';

  var apId = 'ap-' + (++AP_SEQ);
  root.innerHTML = '<div class="ap' + (compact ? ' ap-compact' : '') + '">'
    + '<div class="ap-field">'
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
    + '<div class="ap-search"><input type="text" placeholder="Search models…" aria-label="Search models" data-ap-search /></div>'
    + '<div class="ap-scroll" data-ap-list="model"></div>'
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
    modelMenu.innerHTML = '<div class="ap-search"><input type="text" placeholder="Search models…"'
      + ' aria-label="Search models" data-ap-search /></div>'
      + '<div class="ap-scroll" data-ap-list="model"></div>';
    $('[data-ap-list="model"]').innerHTML = apModelOptionsHtml(
      catalog, state.core, state.model, labels().model, recent[state.core],
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
        + apModelStackHtml(parsed, apId + '-model')
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
    renderEffort();
  }

  function renderEffort() {
    var field = $('[data-ap-effort-field]');
    var sel = $('[data-ap-effort]');
    if (!showEffort) { field.hidden = true; return; }
    var efforts = apEfforts(catalog, state.core, state.model);
    var mode = apEffortMode(efforts, state.effort, compact);
    if (mode === 'placeholder') {
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
    if (mode === 'hidden') {
      field.hidden = true;
      state.effort = '';
      return;
    }
    field.hidden = false;
    var effortInherit = labels().effort || (compact ? 'No effort' : '');
    var built = apEffortOptions(catalog, state.core, state.model, state.effort, effortInherit);
    sel.innerHTML = built.html || '<option value="" selected>' + apEsc(effortInherit || 'No effort (agent picks)') + '</option>';
  }

  function emit() { if (typeof onChange === 'function') onChange({ core: state.core, model: state.model, effort: state.effort }); }

  function setDisabled(on) {
    disabled = !!on;
    var triggers = root.querySelectorAll('[data-ap-trigger]');
    for (var i = 0; i < triggers.length; i++) triggers[i].disabled = disabled;
    var effort = $('[data-ap-effort]');
    if (effort) effort.disabled = disabled || effort.classList.contains('ap-effort--na');
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
      var first = list && list.querySelector('[role="option"]');
      if (first) first.classList.add('active');
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
    var q = (e.target.value || '').trim().toLowerCase();
    var listEl = $('[data-ap-list="model"]');
    if (!listEl) return;
    if (!q) { listEl.innerHTML = apModelOptionsHtml(catalog, state.core, state.model, labels().model, recent[state.core]); return; }
    var list = (catalog && catalog[state.core]) || [];
    var out = '';
    for (var i = 0; i < list.length; i++) {
      var hay = (list[i].label + ' ' + list[i].id).toLowerCase();
      if (hay.indexOf(q) >= 0) {
        out += '<div class="ap-model-item" role="option" tabindex="0" data-ap-model="'
          + apEsc(list[i].id) + '"><div><div class="ap-model-name">' + apEsc(list[i].label)
          + '</div><div class="ap-model-sub">' + apEsc(list[i].id) + '</div>'
          + apModelTagsHtml(apTags(catalog, state.core, list[i].id))
          + '</div></div>';
      }
    }
    if (!out) out = '<div class="ap-empty">No models match "' + apEsc(e.target.value) + '".</div>';
    listEl.innerHTML = out;
  });

  root.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    while (AP_MENU_STACK.length) closeMenu(AP_MENU_STACK[AP_MENU_STACK.length - 1], true);
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
      setDisabled(disabled);
    },
  };
  root.__apInstance = instance;
  return instance;
}
