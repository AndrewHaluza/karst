/**
 * Inject pre-built webview message handlers into webviews.
 *
 * The webview-side message-posting code (.ts files) is bundled into JavaScript
 * at build time and inlined into the HTML, so TypeScript's compiler checks all
 * postMessage calls against the message contract types. A field typo or rename
 * in the webview is caught during tsc --noEmit, not silently dropped at runtime.
 *
 * Markers: KARST_WEBVIEW_MESSAGES_DASHBOARD, KARST_WEBVIEW_MESSAGES_SETTINGS.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const WEBVIEW_MESSAGES_DASHBOARD_MARKER = '/*KARST_WEBVIEW_MESSAGES_DASHBOARD*/';
export const WEBVIEW_MESSAGES_SETTINGS_MARKER = '/*KARST_WEBVIEW_MESSAGES_SETTINGS*/';

const cacheDir = join(dirname(dirname(fileURLToPath(import.meta.url))), '..', '.cache');

let dashboardJs: string | null = null;
let settingsJs: string | null = null;

function loadDashboardJs(): string {
  if (dashboardJs === null) {
    try {
      dashboardJs = readFileSync(join(cacheDir, 'webview-messages-dashboard.js'), 'utf8');
    } catch {
      dashboardJs = '';
    }
  }
  return dashboardJs;
}

function loadSettingsJs(): string {
  if (settingsJs === null) {
    try {
      settingsJs = readFileSync(join(cacheDir, 'webview-messages-settings.js'), 'utf8');
    } catch {
      settingsJs = '';
    }
  }
  return settingsJs;
}

export function injectWebviewMessages(html: string, view: 'dashboard' | 'settings'): string {
  if (view === 'dashboard') {
    return html.replace(WEBVIEW_MESSAGES_DASHBOARD_MARKER, loadDashboardJs());
  } else if (view === 'settings') {
    return html.replace(WEBVIEW_MESSAGES_SETTINGS_MARKER, loadSettingsJs());
  }
  return html;
}
