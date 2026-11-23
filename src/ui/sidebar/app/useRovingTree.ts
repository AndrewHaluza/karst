/**
 * The roving-tabindex tree shared by the Planning and Tickets panes
 * (@ui:UI-R09). One treeitem is a tab stop; arrows move focus, Right reaches an
 * expandable item's children or the item's own tools, Left collapses or walks to
 * the parent, Enter runs the primary action and Shift+F10 opens the context
 * menu. Focus is pure view state: the hook never posts.
 */
import { useRef, type KeyboardEvent, type RefObject } from 'react';

const itemsOf = (root: HTMLElement): HTMLElement[] => [...root.querySelectorAll<HTMLElement>('[role="treeitem"]')];

export interface RovingTreeOptions {
  /** The node ids in document order: the tab stop falls back to the first. */
  readonly nodes: readonly string[];
  readonly focus: string | null;
  readonly setFocus: (node: string | null) => void;
  /** Shift+F10 / the ContextMenu key on an item. */
  readonly onMenu: (item: HTMLElement) => void;
  /** Enter on an item. */
  readonly onPrimary?: (item: HTMLElement) => void;
  /** Right/Left on an item carrying `aria-expanded`. */
  readonly onExpand?: (item: HTMLElement, open: boolean) => void;
}

export interface RovingTree {
  readonly tree: RefObject<HTMLDivElement | null>;
  /** The node that holds the one tab stop, or null for an empty tree. */
  readonly stop: string | null;
  readonly focusItem: (item: HTMLElement | null | undefined) => void;
  readonly onKeyDown: (e: KeyboardEvent<HTMLDivElement>) => void;
}

/** A control that owns its keys (Enter, Space, arrows): the tree must not take them. */
const CONTROL = 'button, a[href], input, select, textarea, [role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"]';

/** The first control inside an item: the row tools a Right Arrow reaches on a leaf. */
const firstTool = (item: HTMLElement): HTMLElement | null => item.querySelector<HTMLElement>('button');

export function useRovingTree({ nodes, focus, setFocus, onMenu, onPrimary, onExpand }: RovingTreeOptions): RovingTree {
  const tree = useRef<HTMLDivElement | null>(null);
  // The tab stop is the focused node while it is still on screen, else the first.
  const stop = focus !== null && nodes.includes(focus) ? focus : (nodes[0] ?? null);

  const focusItem = (item: HTMLElement | null | undefined): void => {
    if (!item) return;
    setFocus(item.dataset.node ?? null);
    item.focus();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    const item = (e.target as HTMLElement).closest<HTMLElement>('[role="treeitem"]');
    if (!item || !tree.current?.contains(item)) return;
    const control = (e.target as HTMLElement).closest<HTMLElement>(CONTROL);
    if (control && control !== item && item.contains(control)) {
      // A tool inside the row keeps Enter, Space and the arrows. Left returns to the row, the menu keys still work.
      if ((e.key === 'F10' && e.shiftKey) || e.key === 'ContextMenu') onMenu(item);
      else if (e.key === 'ArrowLeft' && control.tagName === 'BUTTON') focusItem(item);
      else return;
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    const items = itemsOf(tree.current);
    const at = items.indexOf(item);
    const level = item.getAttribute('aria-level');
    const exp = item.getAttribute('aria-expanded');
    let handled = true;
    if ((e.key === 'F10' && e.shiftKey) || e.key === 'ContextMenu') onMenu(item);
    else if (e.key === 'ArrowDown') focusItem(items[at + 1]);
    else if (e.key === 'ArrowUp') focusItem(items[at - 1]);
    else if (e.key === 'Home') focusItem(items[0]);
    else if (e.key === 'End') focusItem(items[items.length - 1]);
    else if (e.key === 'ArrowRight') {
      if (exp === 'false') onExpand?.(item, true);
      else {
        const child = item.querySelector<HTMLElement>('[role="treeitem"]');
        focusItem(child ?? firstTool(item));
      }
    } else if (e.key === 'ArrowLeft') {
      if (exp === 'true') onExpand?.(item, false);
      else if (level === '2') focusItem(item.parentElement?.closest<HTMLElement>('[role="treeitem"]'));
    } else if (e.key === 'Enter') onPrimary?.(item);
    else handled = false;
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  };

  return { tree, stop, focusItem, onKeyDown };
}
