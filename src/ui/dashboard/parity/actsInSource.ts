import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { RUNTIME_ASSETS_ROOT } from '../../../runtimeAssetsRoot.js';

const html = readFileSync(join(RUNTIME_ASSETS_ROOT, 'ui', 'dashboard', 'webview.html'), 'utf8');

/** Every `data-act="…"` literal in the React app's components: a migrated panel's acts leave webview.html. */
function actsInReactApp(dir = join(RUNTIME_ASSETS_ROOT, 'ui', 'dashboard', 'app')): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return actsInReactApp(path);
    if (!/\.tsx$/.test(entry.name) || /\.test\.tsx$/.test(entry.name)) return [];
    return [...readFileSync(path, 'utf8').matchAll(/data-act="([a-z-]+)"/g)].map((m) => m[1]!);
  });
}

/** SEND_BY_ACT's keys plus every `act === '…'` branch and the CONSOLE_ACT constant, read from the source, plus the React app's acts. */
export function actsInSource(): string[] {
  const map = /const SEND_BY_ACT = \{([\s\S]*?)\n {2}\};/.exec(html)?.[1] ?? '';
  const keys = [...map.matchAll(/^ {4}'([a-z-]+)':/gm)].map((m) => m[1]!);
  const branches = [...html.matchAll(/\bact === '([a-z-]+)'/g)].map((m) => m[1]!);
  const consoleAct = /const CONSOLE_ACT = '([a-z-]+)'/.exec(html)?.[1];
  return [...new Set([...keys, ...branches, ...(consoleAct ? [consoleAct] : []), ...actsInReactApp()])].sort();
}
