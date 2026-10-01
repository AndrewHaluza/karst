/**
 * Root component for the settings React app (NDL-126 §1, phase 1 shell).
 *
 * Owns three things and nothing else:
 *
 * - the one-per-webview announcement surface (UI-R27 / NDL-126 §9.2): the
 *   `AnnouncerProvider` is mounted once here and `LiveRegion` renders exactly
 *   one polite status region for the whole view;
 * - the state container (`SettingsAppProvider`), the single store every section
 *   reads and writes through;
 * - the `data-karst-ready` flag, set from an effect AFTER React's first commit
 *   (NDL-126 §4). `createRoot().render()` has no completion callback in React
 *   19, so the flag cannot be set from the entry; `renderWebviewReady` waits on
 *   it to avoid sweeping an empty `#root`.
 *
 * The app is wired into `WEBVIEW_CHAINS.settings` through `injectSettingsApp`,
 * but that injector is a no-op while `webview.html` has no
 * `/*KARST_SETTINGS_APP*\/` marker — it returns the HTML unchanged, so the
 * vanilla script stays the live implementation until the phase 4 switch-over
 * (NDL-126 §7 rollback).
 */
import { useEffect, type ReactNode } from 'react';
import { AnnouncerProvider, LiveRegion } from './primitives/LiveRegion.js';
import { SettingsAppProvider } from './SettingsAppContext.js';
import type { SettingsHostBridge } from './hostBridge.js';
import { AppShell } from './sections/AppShell.js';
import { AppSections } from './sections/AppSections.js';

export interface AppProps {
  /** Injected in tests; the real app takes the page globals. */
  readonly bridge?: SettingsHostBridge;
  /** So a test can mount one tab without clicking through the nav. */
  readonly initialSection?: 'general' | 'git' | 'quality' | 'ticketing';
  readonly children?: ReactNode;
}

export function App({ bridge, initialSection, children }: AppProps = {}) {
  useEffect(() => {
    document.documentElement.setAttribute('data-karst-ready', 'true');
  }, []);

  return (
    <AnnouncerProvider>
      <SettingsAppProvider bridge={bridge} initialSection={initialSection}>
        <AppShell>{children ?? <AppSections />}</AppShell>
        <LiveRegion />
      </SettingsAppProvider>
    </AnnouncerProvider>
  );
}
