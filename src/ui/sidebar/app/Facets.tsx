/**
 * The facet chips. Multi-select: any number of status chips can be lit at once
 * (their union); `all` is lit only when nothing else is. `aria-pressed` mirrors
 * the toggle and drives the chip's "on" look through the primitive's own
 * `[aria-pressed="true"]` rule. A click reports only WHICH chip was clicked.
 */
import { FACET_META } from './format.js';
import { useSidebar } from './SidebarContext.js';

export function Facets() {
  const { state, toggleFacet } = useSidebar();
  const selected = new Set(state.facets || ['all']);
  return (
    <div className="facets" id="facets">
      {FACET_META.map((f) => (
        <button
          type="button"
          className="k-chip"
          key={f.key}
          data-facet={f.key}
          aria-pressed={selected.has(f.key)}
          onClick={() => toggleFacet(f.key)}
        >
          {f.dotVariant ? <span className={`k-dot k-dot--${f.dotVariant}`} aria-hidden="true" /> : null}
          {f.label} <span className="n">{state.counts?.[f.key] ?? 0}</span>
        </button>
      ))}
    </div>
  );
}
