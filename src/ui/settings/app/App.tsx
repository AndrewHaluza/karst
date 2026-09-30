/**
 * Root component for the settings React app (NDL-126 §1, phase 1 shell).
 *
 * Owns the one-per-webview announcement surface (UI-R27 / NDL-126 §9.2): the
 * `AnnouncerProvider` is mounted once here and `LiveRegion` renders exactly one
 * polite status region for the whole view.
 *
 * Phase 1 ships the pipeline and this shell only. The app is wired into
 * `WEBVIEW_CHAINS.settings` through `injectSettingsApp`, but that injector is a
 * no-op while `webview.html` has no `/*KARST_SETTINGS_APP*\/` marker — it
 * returns the HTML unchanged, so the vanilla script stays the live
 * implementation until the phase 4 switch-over (NDL-126 §7 rollback).
 *
 * The `data-karst-ready` flag is set from an effect, i.e. after React's first
 * commit (NDL-126 §4). `createRoot().render()` has no completion callback in
 * React 19, so the flag cannot be set from the entry; `renderWebviewReady` waits
 * on it to avoid sweeping an empty `#root`.
 */
import { useEffect } from 'react';
import { AnnouncerProvider, LiveRegion } from './primitives/LiveRegion.js';
import { AppSections } from './sections/AppSections.js';

export function App() {
  useEffect(() => {
    document.documentElement.setAttribute('data-karst-ready', 'true');
  }, []);

  return (
    <AnnouncerProvider>
      <AppSections />
      <LiveRegion />
    </AnnouncerProvider>
  );
}
