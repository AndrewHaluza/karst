/**
 * The one announcement surface for the settings React app (UI-R27 / NDL-126
 * §9.2). `AnnouncerProvider` owns the message; `LiveRegion` renders exactly one
 * polite status region for the whole view, and `useAnnounce()` is the only way
 * a component can post to it.
 *
 * "One coordinated polite status region per webview" is a structural guarantee
 * here, not a convention: the provider is mounted once at the app root and the
 * region is rendered once beside it, so a component that wants to announce has
 * nothing to mount — it calls `announce()`.
 *
 * The visually-hidden styling for `.k-live-region` arrives with the webview
 * shell in phase 4 (NDL-126 §8.4); until the app is wired into the shipped
 * chain it is built and tested but never rendered.
 */
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

interface AnnouncerContextValue {
  readonly message: string;
  announce(message: string): void;
}

const AnnouncerContext = createContext<AnnouncerContextValue | null>(null);

const noop = (): void => {};

/** Mount once at the app root; the single owner of the announcement text. */
export function AnnouncerProvider({ children }: { children: ReactNode }) {
  const [message, setMessage] = useState('');
  const announce = useCallback((next: string) => setMessage(next), []);
  const value = useMemo<AnnouncerContextValue>(
    () => ({ message, announce }),
    [message, announce],
  );
  return <AnnouncerContext.Provider value={value}>{children}</AnnouncerContext.Provider>;
}

/**
 * The announcer for the nearest provider, or a no-op when there is none. The
 * no-op keeps a primitive usable in isolation (a COMPONENT test) without
 * forcing every call site to mount the provider.
 */
export function useAnnounce(): (message: string) => void {
  return useContext(AnnouncerContext)?.announce ?? noop;
}

/**
 * The single polite status region. `role="status"` implies `aria-live="polite"`
 * and `aria-atomic="true"`; both are stated explicitly so the contract does not
 * depend on a reader's inference.
 */
export function LiveRegion() {
  const message = useContext(AnnouncerContext)?.message ?? '';
  return (
    <span className="k-live-region" role="status" aria-live="polite" aria-atomic="true">
      {message}
    </span>
  );
}