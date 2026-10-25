/**
 * The shared context window: ONE fixed popup (never an in-flow block), rebuilt
 * per open and positioned at its trigger, so the list's scroll container can
 * never clip it. Shared by the ticket "⋯" trigger and the Planning tree's own
 * context menu. An outside click closes it; Escape closes it returning focus to
 * the trigger.
 */
import { useEffect, useLayoutEffect, useRef } from 'react';
import { ActButton } from './action.js';
import { Icon } from './Icon.js';
import { useSidebar } from './SidebarContext.js';

/** Position the window at the trigger (flipping above when it would overflow the bottom). */
function placeAt(menu: HTMLElement, trigger: HTMLElement): void {
  const r = trigger.getBoundingClientRect();
  const w = menu.offsetWidth || 176;
  const left = Math.min(r.left, Math.max(8, window.innerWidth - w - 8));
  const bottom = window.innerHeight - r.bottom;
  menu.style.left = `${left}px`;
  menu.style.top = `${bottom > 240 ? r.bottom + 4 : Math.max(8, r.top - menu.offsetHeight - 4)}px`;
}

export function ContextMenu() {
  const { menu, closeMenu } = useSidebar();
  const ref = useRef<HTMLDivElement | null>(null);

  // Hand focus to the first item once the window is placed.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!menu || !el) return;
    placeAt(el, menu.trigger);
    const first = el.querySelector<HTMLElement>('.ctxitem');
    if (first && typeof first.focus === 'function') first.focus();
  }, [menu]);

  const isOpen = menu !== null;
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
        <ActButton
          key={item.key}
          spec={item.spec}
          className={item.danger ? 'ctxitem danger' : 'ctxitem'}
          role="menuitem"
          title={item.title}
          beforeFire={() => closeMenu(false)}
        >
          {item.icon ? <Icon name={item.icon} /> : null} {item.label}
        </ActButton>
      ))}
    </div>
  );
}
