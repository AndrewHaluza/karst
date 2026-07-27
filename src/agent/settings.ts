import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

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
export function buildHookSettings(endpointUrl: string): string {
  const parsed = new URL(endpointUrl);
  if (
    parsed.protocol !== 'http:' ||
    parsed.hostname !== '127.0.0.1' ||
    parsed.port === '' ||
    parsed.port === '0'
  ) {
    throw new Error(`karst: refusing non-loopback hook endpoint ${endpointUrl}`);
  }
  const httpHook = { type: 'http', url: endpointUrl, timeout: 10 };
  const bridgeHook = {
    type: 'command',
    command: `curl -s -m 5 -X POST -H 'Content-Type: application/json' --data-binary @- '${endpointUrl}' >/dev/null 2>&1`,
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
 *
 * The filename carries the port plus a hash whenever the endpoint has a query.
 * The port isolates windows; the hash isolates per-launch lifecycle generations
 * within one window. Files are immutable for a given full endpoint URL, so a
 * second session cannot rewrite settings before the first agent reads them.
 */
export function writeHookSettings(endpointUrl: string, dir: string): string {
  const endpoint = new URL(endpointUrl);
  const port = endpoint.port;
  const generation =
    endpoint.search === ''
      ? ''
      : `.${createHash('sha256').update(endpointUrl).digest('hex').slice(0, 16)}`;
  const path = join(
    dir,
    `karst-hooks.${port}${generation}.settings.json`,
  );
  writeFileSync(path, buildHookSettings(endpointUrl));
  return path;
}
