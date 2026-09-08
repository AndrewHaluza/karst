import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { BridgeProvider } from './hookFailureLog.js';
import { resolveNodeExecutable } from './nodeExecutable.js';

/** The endpoint URL the hooks POST to, for a given bound port. */
export function hookUrl(port: number): string {
  return `http://127.0.0.1:${port}/hooks`;
}

/**
 * Events bridged through the shared node script — low-frequency lifecycle
 * events whose failures must be logged and whose endpoint must rebind after
 * a VS Code reload. The node bridge costs ~21 ms per invocation (PROMPT-16
 * measured); bridging only these ~2 events/turn keeps the cost invisible
 * next to a model turn measured in seconds. PostToolUse is deliberately
 * excluded: it fires per tool call, and bridging it would cost ~6 seconds
 * per session for the least valuable signal (a liveness ping).
 */
const BRIDGED_EVENTS = [
  'Stop',
  'Notification',
  'SessionEnd',
  'UserPromptSubmit',
] as const;

/**
 * Build the `--settings` JSON that registers the hook channel (§5.4, M0/T0.2).
 *
 * Three hook kinds, all landing on the same endpoint:
 *  - Lifecycle events (`Stop`, `Notification`, `SessionEnd`, `UserPromptSubmit`)
 *    and `SessionStart` — routed through the shared node bridge, which
 *    re-reads `currentEndpointPath(configDir, provider)` when the launch-time
 *    URL dies, logs failures to `hook-failures.jsonl`, and carries the launch
 *    generation onto every candidate. SessionStart uses the bridge (not curl)
 *    so one channel serves all six events.
 *  - `PostToolUse` — `type:http` directly at the bound port (high-frequency,
 *    non-blocking, failures unobservable but also inconsequential).
 *
 * `configDir` and `provider` are required when any event uses the bridge
 * (the command needs them to resolve `current-endpoint` and the failure log).
 * When both are omitted, only `type:http` events are emitted — a backward-
 * compatible path for callers that do not need the bridge.
 *
 * No `async` flag on `type:http` hooks: HTTP hooks are inherently non-
 * blocking; the endpoint just returns a fast 2xx (T0.2 finding 2).
 */
export function buildHookSettings(
  endpointUrl: string,
  configDir?: string,
  provider?: BridgeProvider,
): string {
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

  const hooks: Record<string, unknown> = {};

  if (configDir && provider) {
    // Try to resolve a standalone node for the bridge. When node is absent
    // (e.g. VS Code launched from Finder with a minimal PATH), fall back to
    // curl/http — degraded but not fatal. The bridge is a graceful upgrade,
    // not a hard requirement.
    let nodeExec: string | undefined;
    try {
      nodeExec = resolveNodeExecutable();
    } catch {
      // node not found — fall through to the curl/http fallback below.
    }

    if (nodeExec) {
      const bridgeDir = join(configDir, provider);
      const diagnosticsPath = join(bridgeDir, 'hook-failures.jsonl');
      const bridgePath = join(bridgeDir, 'bridge.cjs');
      const command = [
        JSON.stringify(nodeExec),
        JSON.stringify(bridgePath),
        JSON.stringify(endpointUrl),
        JSON.stringify(diagnosticsPath),
        JSON.stringify(provider),
      ].join(' ');
      const bridgeHook = {
        type: 'command',
        command,
        timeout: 5,
      };

      for (const event of BRIDGED_EVENTS) {
        hooks[event] = [{ matcher: '', hooks: [bridgeHook] }];
      }
      // SessionStart always uses the bridge (it does not support type:http).
      hooks.SessionStart = [{ matcher: '', hooks: [bridgeHook] }];
    }
  }

  // Fill any events not yet assigned (no bridge, or node absent) with
  // curl for SessionStart and type:http for lifecycle events.
  if (!hooks.SessionStart) {
    hooks.SessionStart = [{
      matcher: '',
      hooks: [{
        type: 'command',
        command: `curl -s -m 5 -X POST -H 'Content-Type: application/json' --data-binary @- '${endpointUrl}' >/dev/null 2>&1`,
      }],
    }];
  }
  for (const event of BRIDGED_EVENTS) {
    if (!hooks[event]) {
      hooks[event] = [{ matcher: '', hooks: [httpHook] }];
    }
  }

  // PostToolUse is always type:http — high-frequency, non-blocking, failures
  // inconsequential (PROMPT-16 measured cost: bridging = ~6 s/session).
  hooks.PostToolUse = [{ matcher: '', hooks: [httpHook] }];

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
export function writeHookSettings(
  endpointUrl: string,
  dir: string,
  provider?: BridgeProvider,
): string {
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
  writeFileSync(path, buildHookSettings(endpointUrl, dir, provider));
  return path;
}
