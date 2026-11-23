/**
 * One filter menu for the Tickets funnel and the Activity level (SB-9, SB-17):
 * a menu button offering a single-select list (menuitemradio). A dot marks any
 * choice other than the unfiltered one. Opening moves focus to the checked item;
 * arrows/Home/End move, Escape closes returning focus to the trigger, an outside
 * click or Tab closes. The caller owns the option list and what a choice means.
 */
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useAnchoredPopover } from '../../shared/useAnchoredPopover.js';
import { ToolbarGlyph } from './Icon.js';

const FUNNEL = ['M4 4h16v2.172a2 2 0 0 1 -.586 1.414l-4.414 4.414v7l-6 2v-8.5l-4.48 -4.928a2 2 0 0 1 -.52 -1.345v-2.227'];

export interface FilterOption {
  readonly id: string;
  readonly label: string;
}

export interface FilterMenuProps {
  readonly options: readonly FilterOption[];
  /** The checked option, or null when no option names the current filter. */
  readonly value: string | null;
  /** Whether anything is filtered: draws the dot and names the choice. */
  readonly filtered: boolean;
  readonly onChange: (id: string) => void;
  /** The trigger's name when unfiltered ("Filter tickets"). */
  readonly label: string;
  readonly menuLabel: string;
  /** The `data-*` hook on the trigger, its options and its dot. */
  readonly triggerAttr: string;
  readonly optionAttr: string;
  readonly dotAttr: string;
}

export function FilterMenu({ options, value, filtered, onChange, label, menuLabel, triggerAttr, optionAttr, dotAttr }: FilterMenuProps) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLSpanElement | null>(null);
  const button = useRef<HTMLButtonElement | null>(null);
  const pop = useRef<HTMLDivElement | null>(null);
  useAnchoredPopover(open, pop, button, () => setOpen(false));
  const current = options.find((o) => o.id === value) ?? null;

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
  const choose = (id: string): void => {
    close(true);
    onChange(id);
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

  const name = `${label}${filtered ? `: ${current?.label ?? 'custom'}` : ''}`;
  return (
    <span className="filter-menu" ref={wrap}>
      <button
        type="button"
        className="k-iconbtn"
        {...{ [triggerAttr]: '1' }}
        ref={button}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={name}
        title={name}
        onClick={() => setOpen((o) => !o)}
      >
        <ToolbarGlyph paths={FUNNEL} />
        {filtered ? <span className="filter-dot" {...{ [dotAttr]: '1' }} aria-hidden="true" /> : null}
      </button>
      {open ? (
        <div className="filter-pop" ref={pop} role="menu" aria-label={menuLabel} onKeyDown={onKeyDown}>
          {options.map((o) => (
            <button
              type="button"
              key={o.id}
              className="ctxitem"
              role="menuitemradio"
              aria-checked={value === o.id}
              {...{ [optionAttr]: o.id }}
              tabIndex={-1}
              onClick={() => choose(o.id)}
            >
              {o.label}
            </button>
          ))}
        </div>
      ) : null}
    </span>
  );
}
