/**
 * The UNIFIED agent identity picker element (agent core + model + effort/variant).
 *
 * Every surface that asks a user to choose an agent — Settings-general (the
 * global default implementation agent), Settings-approaches graph profiles,
 * the ticket dashboard's agent switch, the ticket form's per-ticket pick —
 * renders the SAME component, delivered by marker injection exactly like
 * [[agentIdentity]]/[[designSystem]] (a self-contained webview cannot import
 * TS). One component, four hosts; a pick made anywhere looks and behaves the
 * same everywhere.
 *
 * The component is `mountAgentPicker(root, opts)`:
 *
 *   mountAgentPicker(root, {
 *     cores,            // [{id, label}] — implemented cores offered
 *     catalog,          // { provider: [ModelOption] } with model `efforts`
 *     recent,           // { provider: [modelId] } recently used, newest first (≤5)
 *     value,            // { core, model, effort } current selection
 *     inherit,          // { core?, model?, effort? } labels for "Inherit (settings: X)"
 *     disabled,         // lock the whole picker (session-open)
 *     showEffort,       // false = never render the effort/variant field
 *     onChange,         // ({ core, model, effort }) => void
 *   })
 *
 * `recent` feeds the model menu's "Last used" group (design § model UX): a
 * provider with a long catalog (opencode) buries a user's habitual pick, so the
 * models they actually used recently are pinned to the top of the list, newest
 * first, up to 5, rendered in the SAME group shape as the "saved" rows. Only
 * recent models still present in the catalog render — a recently used id that
 * left the catalog is not a dead option. The host computes the list from the
 * append-only `token_usage` ledger (`store/tokenUsage.ts`
 * `listRecentlyUsedModels`), so every surface that mounts the picker gets the
 * same "last used" group by passing the same shape.
 *
 * Effort is model-capability-aware (design § Execution policy resolution): the
 * effort/variant field renders ONLY when the selected model advertises efforts
 * in the LIVE catalog — an explicit effort for a model that advertises none is
 * a configuration error the host reports at Save, never something this field
 * silently offers. The field's options are exactly the model's advertised
 * efforts plus the inherit/none row. A saved effort that left the catalog stays
 * visible and selected so it is never silently rewritten.
 *
 * Model rows also render the model's advertised capability tags (`multimodal`,
 * `text-only`, `audio`, `vision`) as small chips under the model name, so a
 * user can tell at a glance what a model accepts. Tags may come from curated
 * catalog entries or be overlaid by `loadModelCatalog` for discovered models
 * whose id matches a curated entry; the picker renders whatever the host
 * supplies — there is no tag vocabulary in this file.
 *
 * CSS + JS are emitted as plain statements swapped into each webview's markers
 * (`KARST_AGENT_PICKER_CSS` / `KARST_AGENT_PICKER_JS`), before
 * `injectCsp` nonces the document. The runtime is a plain-JS string (no
 * bundler touches it), and its correctness is held by evaluating THIS TEXT in
 * `agentPicker.test.ts` — never a TypeScript twin.
 */

import type { AgentProvider } from '../manifest/types.js';
import type { ModelOption } from '../agent/modelCatalog.js';

/** Placeholder swapped for the picker CSS; sits inside each webview's `<style>`. */
export const AGENT_PICKER_CSS_MARKER = '/*KARST_AGENT_PICKER_CSS*/';

/** Placeholder swapped for the picker JS; sits inside each webview's `<script>`. */
export const AGENT_PICKER_JS_MARKER = '/*KARST_AGENT_PICKER_JS*/';

/** The model catalog shape the picker reads (mirrors `ModelCatalog`). */
export type AgentPickerCatalog = Readonly<
  Partial<Record<AgentProvider, readonly ModelOption[]>>
>;

/**
 * The `.ap-*` stylesheet for the unified picker. Self-contained so a surface
 * does not need its own picker CSS; sized with design tokens (UI-R04/R05).
 */
export function agentPickerCss(): string {
  return `
.ap{display:grid;gap:var(--k-space-5)}
.ap-field{display:flex;flex-direction:column;gap:var(--k-space-2);min-width:0}
.ap-label{font-size:var(--k-text-xs);color:var(--k-text-dim)}
.ap-shell{position:relative;min-width:0}
.ap-trigger{
  width:100%;min-height:var(--k-control-h-lg);
  display:flex;align-items:center;gap:var(--k-space-3);
  background:var(--k-surface);color:var(--k-text);
  border:var(--k-border-w) solid var(--k-border);border-radius:var(--k-radius-sm);
  padding:var(--k-space-2) var(--k-space-4);font-family:inherit;font-size:var(--k-text-md);
  cursor:pointer;text-align:left;position:relative}
.ap-trigger:hover{border-color:var(--k-border-strong)}
.ap-trigger:focus-visible{outline:var(--k-focus-w) solid var(--k-focus);outline-offset:var(--k-focus-offset)}
.ap-trigger:disabled{opacity:.45;cursor:default}
.ap-trigger .ap-trigger-label{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:flex;align-items:center;gap:var(--k-space-2)}
.ap-trigger .chev{flex:none;width:var(--k-space-6);height:var(--k-space-6);margin-left:auto;
  background:var(--chevron) no-repeat center/var(--k-space-6)}
.ap-menu{
  position:absolute;top:calc(100% + var(--k-space-2));left:0;right:0;z-index:var(--k-z-drawer);
  background:var(--vscode-dropdown-background,var(--k-bg));
  border:var(--k-border-w) solid var(--vscode-dropdown-border,var(--vscode-panel-border));
  border-radius:var(--k-radius-md);box-shadow:var(--k-elev-2);padding:var(--k-space-2)}
.ap-menu[hidden]{display:none}
.ap-opt{display:flex;align-items:center;gap:var(--k-space-3);padding:var(--k-space-3) var(--k-space-4);
  border-radius:var(--k-radius-sm);cursor:pointer;font-size:var(--k-text-base)}
.ap-opt:hover{background:var(--k-surface-hover);color:var(--k-text)}
.ap-opt.active,.ap-opt[aria-selected="true"]{background:var(--vscode-list-activeSelectionBackground,var(--k-surface-hover));
  color:var(--vscode-list-activeSelectionForeground,var(--k-text))}
.ap-opt:focus-visible{outline:var(--k-focus-w) solid var(--k-focus);outline-offset:var(--k-focus-offset)}
.ap-opt[aria-disabled="true"]{opacity:.5;cursor:not-allowed}
.ap-search{padding:var(--k-space-3);border-bottom:var(--k-border-w) solid var(--k-border)}
.ap-search input{width:100%}
.ap-scroll{max-height:calc(var(--k-space-8) * 14);overflow:auto}
.ap-group-label{padding:var(--k-space-2) var(--k-space-4);color:var(--k-text-faint);font-size:var(--k-text-2xs)}
.ap-model-item{display:flex;align-items:center;justify-content:space-between;gap:var(--k-space-3);
  padding:var(--k-space-3) var(--k-space-4);border-radius:var(--k-radius-sm);cursor:pointer;font-size:var(--k-text-base)}
.ap-model-item:hover{background:var(--k-surface-hover);color:var(--k-text)}
.ap-model-item.active,.ap-model-item[aria-selected="true"]{background:var(--k-surface-hover);color:var(--k-text)}
.ap-model-item .ap-model-name{font-weight:500;font-size:var(--k-text-base)}
.ap-model-item .ap-model-sub{font-size:var(--k-text-xs);color:var(--k-text-dim);margin-top:var(--k-space-1)}
.ap-model-item .ap-model-tag{font-size:var(--k-text-2xs);color:var(--k-text-faint);flex:0 0 auto}
.ap-model-tags{display:flex;flex-wrap:wrap;gap:var(--k-space-1);margin-top:var(--k-space-2)}
.ap-tag{font-size:var(--k-text-2xs);line-height:1;color:var(--k-text-dim);border:var(--k-border-w) solid var(--k-border);border-radius:var(--k-radius-sm);padding:var(--k-space-1) var(--k-space-2);white-space:nowrap}
.ap-empty{padding:var(--k-space-4);color:var(--k-text-faint);font-size:var(--k-text-sm);text-align:center}
.ap-effort-field[hidden]{display:none}
.ap-effort{width:100%;min-height:var(--k-control-h-lg);
  background:var(--k-surface);color:var(--k-text);
  border:var(--k-border-w) solid var(--k-border);border-radius:var(--k-radius-sm);
  padding:var(--k-space-2) var(--k-space-4);font-family:inherit;font-size:var(--k-text-md)}
.ap-effort:disabled{opacity:.45;cursor:default}
`.trim();
}

/**
 * The picker runtime. Emitted as plain statements (no wrapping `<script>` tag)
 * so it can be injected as the first lines of an existing block and picked up
 * by `injectCsp`'s nonce pass — the same contract as `agentIdentityJs`.
 */
export function agentPickerJs(): string {
  return `
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
`.trim();
}

/** Replace the picker CSS/JS markers; no-op per marker if absent. */
export function injectAgentPicker(html: string): string {
  return html
    .replace(AGENT_PICKER_CSS_MARKER, () => agentPickerCss())
    .replace(AGENT_PICKER_JS_MARKER, () => agentPickerJs());
}
