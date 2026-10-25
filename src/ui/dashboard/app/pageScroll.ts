/** The document's scroll position: the one thing the artifact view's scroll memory (spec §9) saves and restores. */
import type { ScrollPort } from './overlayStack.js';

const root = (): HTMLElement => document.documentElement || document.body;

export const pageScroll: ScrollPort = {
  read: () => (typeof root().scrollTop === 'number' ? root().scrollTop : 0),
  write: (top) => {
    root().scrollTop = top;
  },
};
