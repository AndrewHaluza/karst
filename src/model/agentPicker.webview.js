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

/** One row of capability-tag chips; empty when the model advertises none. */
function apModelTagsHtml(tags) {
  if (!tags || tags.length === 0) return '';
  var out = '<div class="ap-model-tags">';
  for (var i = 0; i < tags.length; i++) {
    out += '<span class="ap-tag">' + apEsc(tags[i]) + '</span>';
  }
  return out + '</div>';
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

/** The identity the core trigger shows: full pattern when a model is set. */
function apCoreTriggerLabel(provider, modelLabel) {
  if (typeof agentIdentityHtml === 'function') {
    return agentIdentityHtml(provider, modelLabel, true);
  }
  return apEsc(provider || '');
}

/** A core switch never carries provider-specific model/effort state across. */
function apCoreSelection(current, core) {
  var nextCore = core || '';
  if (nextCore === current.core) return current;
  return { core: nextCore, model: '', effort: '' };
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
  var value = o.value || {};
  var inherit = o.inherit || {};
  var showEffort = o.showEffort !== false;
  var disabled = !!o.disabled;
  var onChange = o.onChange;
  var state = {
    core: value.core || '',
    model: value.model || '',
    effort: value.effort || '',
  };
  var labelModel = o.labels && o.labels.model ? o.labels.model : 'Model';
  var labelEffort = o.labels && o.labels.effort ? o.labels.effort : 'Effort / variant';

  root.innerHTML = '<div class="ap">'
    + '<div class="ap-field">'
    + '<label class="ap-label">' + (o.labels && o.labels.core ? apEsc(o.labels.core) : 'Agent core') + '</label>'
    + '<div class="ap-shell" data-ap-shell="core">'
    + '<button type="button" class="ap-trigger" data-ap-trigger="core" aria-haspopup="listbox" aria-expanded="false"></button>'
    + '<div class="ap-menu" data-ap-menu="core" role="listbox" hidden></div>'
    + '</div></div>'
    + '<div class="ap-field">'
    + '<label class="ap-label">' + apEsc(labelModel) + '</label>'
    + '<div class="ap-shell" data-ap-shell="model">'
    + '<button type="button" class="ap-trigger" data-ap-trigger="model" aria-haspopup="listbox" aria-expanded="false"></button>'
    + '<div class="ap-menu" data-ap-menu="model" role="listbox" hidden>'
    + '<div class="ap-search"><input type="text" placeholder="Search models…" aria-label="Search models" data-ap-search /></div>'
    + '<div class="ap-scroll" data-ap-list="model"></div>'
    + '</div></div></div>'
    + '<div class="ap-field ap-effort-field" data-ap-effort-field hidden>'
    + '<label class="ap-label">' + apEsc(labelEffort) + '</label>'
    + '<select class="ap-effort" data-ap-effort></select>'
    + '</div>'
    + '</div>';

  var $ = function (sel) { return root.querySelector(sel); };

  function render() {
    var coreMenu = $('[data-ap-menu="core"]');
    coreMenu.innerHTML = apCoreOptionsHtml(cores, state.core, inherit.core || '');
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
      catalog, state.core, state.model, inherit.model || '', recent[state.core],
    );
    var coreLabel = modelLabel();
    $('[data-ap-trigger="core"]').innerHTML =
      '<span class="ap-trigger-label">' + apCoreTriggerLabel(state.core, coreLabel || '') + '</span>'
      + '<span class="chev" aria-hidden="true"></span>';
    modelTrigger.innerHTML = coreLabel
      ? '<span class="ap-trigger-label">' + apEsc(coreLabel) + '</span><span class="chev" aria-hidden="true"></span>'
      : '<span class="ap-trigger-label">' + apEsc(inherit.model || 'No model (agent picks)') + '</span>'
        + '<span class="chev" aria-hidden="true"></span>';
    renderEffort();
  }

  function renderEffort() {
    var field = $('[data-ap-effort-field]');
    if (!showEffort) { field.hidden = true; return; }
    var efforts = apEfforts(catalog, state.core, state.model);
    var show = efforts !== undefined && efforts.length > 0;
    if (show || state.effort) {
      field.hidden = false;
      var sel = $('[data-ap-effort]');
      var built = apEffortOptions(catalog, state.core, state.model, state.effort, inherit.effort || '');
      sel.innerHTML = built.html || '<option value="" selected>' + apEsc(inherit.effort || 'No effort (agent picks)') + '</option>';
      if (built.efforts === null && !state.effort) {
        // No advertised efforts and nothing saved — keep a single none row.
        sel.innerHTML = '<option value="" selected>' + apEsc(inherit.effort || 'No effort (agent picks)') + '</option>';
      }
    } else {
      field.hidden = true;
      state.effort = '';
    }
  }

  function emit() { if (typeof onChange === 'function') onChange({ core: state.core, model: state.model, effort: state.effort }); }

  function setDisabled(on) {
    disabled = !!on;
    var triggers = root.querySelectorAll('[data-ap-trigger]');
    for (var i = 0; i < triggers.length; i++) triggers[i].disabled = disabled;
    var effort = $('[data-ap-effort]');
    if (effort) effort.disabled = disabled;
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
      state = apCoreSelection(state, coreOpt.getAttribute('data-ap-core'));
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
    if (!q) { listEl.innerHTML = apModelOptionsHtml(catalog, state.core, state.model, inherit.model || '', recent[state.core]); return; }
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
      inherit = (next && next.inherit) || {};
      showEffort = next ? next.showEffort !== false : true;
      disabled = !!(next && next.disabled);
      onChange = next && next.onChange;
      setDisabled(disabled);
    },
  };
  root.__apInstance = instance;
  return instance;
}
