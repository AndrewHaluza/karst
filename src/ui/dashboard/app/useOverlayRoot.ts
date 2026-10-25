/**
 * An overlay's static root in `webview.html` (`#artView`, `#termView`, `#envView`) starts `hidden` and is pinned by the
 * region parity snapshots without any data-* attribute, so React shows and hides it by toggling the class on the node
 * (never by rewriting `className`), together with the body class that swaps the dashboard out (`art-nav`, `term-nav`,
 * `env-nav`). Both are undone when the overlay unmounts.
 */
import { useLayoutEffect } from 'react';

export function useOverlayRoot(id: string, open: boolean, bodyClass: string): void {
  useLayoutEffect(() => {
    document.getElementById(id)?.classList.toggle('hidden', !open);
    document.body.classList.toggle(bodyClass, open);
    return () => {
      document.getElementById(id)?.classList.add('hidden');
      document.body.classList.remove(bodyClass);
    };
  }, [id, open, bodyClass]);
}
