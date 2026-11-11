/**
 * The shared context window: ONE fixed popup (never an in-flow block), rebuilt
 * per open and positioned at its trigger, so the list's scroll container can
 * never clip it. Shared by the ticket "⋯" trigger and the Planning tree's own
 * context menu. An outside click closes it; Escape closes it returning focus to
 * the trigger.
 */
import { Fragment, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ActButton } from './action.js';
import { attachAnchoredPopover } from '../../shared/anchoredPopover.js';
import { Icon } from './Icon.js';
import { useSidebar, type MenuItem } from './SidebarContext.js';

/** An entry that opens a nested list (e.g. "Priority ▸"); Right opens it and Left folds it back; it expands inline because the window scrolls and would clip a flyout. */
function SubMenu({ item, open, onToggle, onPick }: {
  readonly item: MenuItem;
  readonly open: boolean;
  readonly onToggle: (open: boolean) => void;
  readonly onPick: () => void;
}) {
  return (
    <div className="ctxsub-wrap">
      <button
        type="button"
        className="ctxitem"
        role="menuitem"
        aria-haspopup="menu"
        aria-expanded={open}
        title={item.title}
        onClick={() => onToggle(!open)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowRight') onToggle(true);
          else if (e.key === 'ArrowLeft' && open) {
            e.stopPropagation();
            onToggle(false);
          }
        }}
      >
        {item.icon ? <Icon name={item.icon} /> : null} {item.label}
        <span className="ctxsub-arrow" aria-hidden="true"><Icon name="chevron-right" /></span>
      </button>
      {open ? (
        <div className="ctxsub" role="menu" aria-label={item.label}>
          {(item.submenu ?? []).map((sub) => (
            <Fragment key={sub.key}>
              {sub.divider ? <div className="ctxdivider" role="separator" /> : null}
              <ActButton spec={sub.spec} className="ctxitem" role="menuitemradio" aria-checked={sub.checked === true} title={sub.title} beforeFire={onPick}>
                {sub.label}
              </ActButton>
            </Fragment>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function ContextMenu() {
  const { menu, closeMenu } = useSidebar();
  const ref = useRef<HTMLDivElement | null>(null);
  // The entry whose nested list is open (view state only; it resets on every open).
  const [sub, setSub] = useState<string | null>(null);

  // Hand focus to the first item once the window is placed.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!menu || !el) return;
    setSub(null);
    const first = el.querySelector<HTMLElement>('.ctxitem');
    if (first && typeof first.focus === 'function') first.focus();
  }, [menu]);

  const isOpen = menu !== null;
  const trigger = menu?.trigger ?? null;
  // Follow the trigger on scroll/resize; close (focus stays put) once it is out of view.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !trigger) return undefined;
    return attachAnchoredPopover({ popover: el, trigger, onTriggerHidden: () => closeMenu(false) });
  }, [trigger, closeMenu]);
  useEffect(() => {
    if (!isOpen) return undefined;
    const onClick = (e: MouseEvent): void => {
      const t = e.target as Element | null;
      if (t && t.closest && (t.closest('#ctxMenu') || t.closest('[data-menu]'))) return;
      closeMenu(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') closeMenu(true);
    };
    document.addEventListener('click', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('click', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [isOpen, closeMenu]);

  return (
    <div className={menu ? 'ctxmenu open' : 'ctxmenu'} id="ctxMenu" role="menu" ref={ref}>
      {menu?.items.map((item) => (
        <Fragment key={item.key}>
          {item.divider ? <div className="ctxdivider" role="separator" /> : null}
          {item.submenu ? (
            <SubMenu item={item} open={sub === item.key} onToggle={(o) => setSub(o ? item.key : null)} onPick={() => closeMenu(false)} />
          ) : (
          <ActButton
            spec={item.spec}
            className={item.danger ? 'ctxitem danger' : 'ctxitem'}
            role="menuitem"
            title={item.title}
            beforeFire={() => closeMenu(false)}
          >
            {item.icon ? <Icon name={item.icon} /> : null} {item.label}
          </ActButton>
          )}
        </Fragment>
      ))}
    </div>
  );
}
