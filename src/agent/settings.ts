import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** The endpoint URL the hooks POST to, for a given bound port. */
export function hookUrl(port: number): string {
  return `http://127.0.0.1:${port}/hooks`;
}

/** Events registered as plain `type:http` hooks (all except SessionStart). */
const HTTP_EVENTS = [
  'Stop',
  'Notification',
  'SessionEnd',
  'UserPromptSubmit',
  'PostToolUse',
] as const;

/**
 * Build the `--settings` JSON that registers the hook channel (§5.4, M0/T0.2).
 *
 * Two hook kinds, both landing on the same endpoint:
 *  - `SessionStart` — a `type:command` curl bridge, because SessionStart does
 *    NOT support `type:http` (T0.2 finding 1). It pipes the hook's stdin payload
 *    verbatim to the endpoint.
 *  - everything else — `type:http` directly at the bound port.
 *
 * No `async` flag: HTTP hooks are inherently non-blocking; the endpoint just
 * returns a fast 2xx (T0.2 finding 2).
 */
export function buildHookSettings(port: number): string {
  // A session reads --settings once, at launch, and never again: whatever port is
  // baked in here is the only one it will ever POST to. Port 0 ("endpoint not
  // bound yet") would write http://127.0.0.1:0/hooks and every hook of that
  // session's life would ECONNREFUSE. Refuse to launch instead.
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(`karst: refusing to write hook settings for unbound port ${port}`);
  }
  const url = hookUrl(port);
  const httpHook = { type: 'http', url, timeout: 10 };
  const bridgeHook = {
    type: 'command',
    command: `curl -s -m 5 -X POST -H 'Content-Type: application/json' --data-binary @- '${url}' >/dev/null 2>&1`,
  };

  const hooks: Record<string, unknown> = {
    SessionStart: [{ matcher: '', hooks: [bridgeHook] }],
  };
  for (const event of HTTP_EVENTS) {
    hooks[event] = [{ matcher: '', hooks: [httpHook] }];
  }

  return JSON.stringify({ hooks });
}

/**
 * Write the hook settings JSON into `dir` and return its path. Consumed by the
 * session launcher (T3.3) as the `--settings` argument (the C2 wiring).
 */
export function writeHookSettings(port: number, dir: string): string {
  const path = join(dir, 'karst-hooks.settings.json');
  writeFileSync(path, buildHookSettings(port));
  return path;
}
