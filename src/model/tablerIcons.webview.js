// ── Karst Tabler icon runtime (docs/ui/ICONS.md §3) ──────────────────────────
var KARST_TABLER_ICONS = __TABLER_ICONS_JSON__;

/**
 * Full inline svg for a catalog glyph. size is CSS px (default 16); cls is an
 * optional extra class beside .k-icon. Unknown name → '' — never a throw.
 */
function karstIcon(name, size, cls) {
  var paths = KARST_TABLER_ICONS[name];
  if (!paths) return '';
  size = size || __TABLER_ICON_SIZE__;
  var k = 'k-icon' + (cls ? ' ' + cls : '');
  return '<svg class="' + k + '" width="' + size + '" height="' + size
    + '" viewBox="0 0 __TABLER_VIEWBOX__ __TABLER_VIEWBOX__" aria-hidden="true" focusable="false">'
    + paths + '</svg>';
}
