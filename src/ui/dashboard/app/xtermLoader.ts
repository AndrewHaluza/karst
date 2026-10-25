/**
 * The xterm bundle is NOT part of the dashboard document: over Remote-SSH the whole document crosses the network on
 * every panel open, and ~490 KB of it would be a library only the console uses. The first console open asks the host
 * for it (`xterm-request`); the answer runs as an inline script carrying the page's nonce, so the CSP stays
 * nonce-only. The library installs `Terminal` and `FitAddon` as globals.
 */

/** 'absent' -> 'loading' -> 'ready' | 'failed'. */
export type XtermState = 'absent' | 'loading' | 'ready' | 'failed';

export interface XtermTerminal {
  loadAddon(addon: unknown): void;
  open(host: HTMLElement): void;
  write(text: string): void;
  dispose(): void;
  scrollPages(pages: number): void;
  scrollToTop(): void;
  scrollToBottom(): void;
}

export interface XtermFit {
  fit(): void;
}

export interface XtermGlobals {
  Terminal?: new (options: Record<string, unknown>) => XtermTerminal;
  FitAddon?: { FitAddon: new () => XtermFit };
}

export const xtermGlobals = (): XtermGlobals => globalThis as unknown as XtermGlobals;

/** The library's globals are both there (a bundle that defines only one is as good as none). */
export const xtermPresent = (): boolean => typeof xtermGlobals().Terminal !== 'undefined' && typeof xtermGlobals().FitAddon !== 'undefined';

/** Where the loader starts: a page that already has the library needs no request. */
export const initialXtermState = (): XtermState => (typeof xtermGlobals().Terminal !== 'undefined' ? 'ready' : 'absent');

/** What the answer to `xterm-request` leaves behind: `ready` when the library is on the page, else `failed`. */
export const settledXtermState = (): XtermState => (typeof xtermGlobals().Terminal !== 'undefined' ? 'ready' : 'failed');

/** Runs the bundle under the page's own nonce, the only script the CSP lets run. */
export function runXtermBundle(js: string): void {
  const script = document.createElement('script');
  const tagged = Array.from(document.scripts).find((s) => s.nonce);
  script.nonce = tagged ? tagged.nonce : '';
  script.textContent = js;
  document.head.appendChild(script);
}
