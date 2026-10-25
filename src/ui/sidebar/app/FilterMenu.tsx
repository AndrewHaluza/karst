/**
 * The funnel in the Tickets header: a menu button offering the single-select
 * presets (menuitemradio). A dot marks any preset other than All. Opening moves
 * focus to the checked item; arrows/Home/End move, Escape closes returning focus
 * to the funnel, an outside click or Tab closes. A choice reports through the
 * existing facet messages (SidebarContext.applyPreset).
 */
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { ToolbarGlyph } from './Icon.js';
import { activePreset, PRESETS, type PresetId } from './presets.js';
import { useSidebar } from './SidebarContext.js';

const FUNNEL = ['M4 4h16v2.172a2 2 0 0 1 -.586 1.414l-4.414 4.414v7l-6 2v-8.5l-4.48 -4.928a2 2 0 0 1 -.52 -1.345v-2.227'];

export function FilterMenu() {
  const { state, applyPreset } = useSidebar();
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLSpanElement | null>(null);
  const button = useRef<HTMLButtonElement | null>(null);
  const current = activePreset(state.facets || ['all']);
  const filtered = current?.id !== 'all';

  useLayoutEffect(() => {
    if (!open) return;
    const items = wrap.current?.querySelectorAll<HTMLElement>('[role="menuitemradio"]');
    const checked = [...(items ?? [])].find((i) => i.getAttribute('aria-checked') === 'true');
    (checked ?? items?.[0])?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    const onClick = (e: MouseEvent): void => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('click', onClick);
    return () => document.removeEventListener('click', onClick);
  }, [open]);

  const close = (returnFocus: boolean): void => {
    setOpen(false);
    if (returnFocus) button.current?.focus();
  };
  const choose = (id: PresetId): void => {
    close(true);
    applyPreset(id);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    const items = [...e.currentTarget.querySelectorAll<HTMLElement>('[role="menuitemradio"]')];
    const at = items.indexOf(e.target as HTMLElement);
    const go = (i: number): void => items[(i + items.length) % items.length]?.focus();
    if (e.key === 'ArrowDown') go(at + 1);
    else if (e.key === 'ArrowUp') go(at - 1);
    else if (e.key === 'Home') go(0);
    else if (e.key === 'End') go(items.length - 1);
    else if (e.key === 'Escape') close(true);
    else if (e.key === 'Tab') close(false);
    else return;
    if (e.key !== 'Tab') e.preventDefault();
    e.stopPropagation();
  };

  const label = `Filter tickets${filtered ? `: ${current?.label ?? 'custom'}` : ''}`;
  return (
    <span className="filter-menu" ref={wrap}>
      <button
        type="button"
        className="k-iconbtn"
        data-filter-menu="1"
        ref={button}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        title={label}
        onClick={() => setOpen((o) => !o)}
      >
        <ToolbarGlyph paths={FUNNEL} />
        {filtered ? <span className="filter-dot" data-filter-dot="1" aria-hidden="true" /> : null}
      </button>
      {open ? (
        <div className="filter-pop" role="menu" aria-label="Ticket filter" onKeyDown={onKeyDown}>
          {PRESETS.map((p) => (
            <button
              type="button"
              key={p.id}
              className="ctxitem"
              role="menuitemradio"
              aria-checked={current?.id === p.id}
              data-preset={p.id}
              tabIndex={-1}
              onClick={() => choose(p.id)}
            >
              {p.label}
            </button>
          ))}
        </div>
      ) : null}
    </span>
  );
}
