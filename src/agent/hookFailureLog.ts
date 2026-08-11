import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Where the Codex hook bridge appends its own failure records.
 *
 * The bridge is a standalone `.cjs` script spawned by the agent CLI, so the only
 * thing it and the extension host share is this path. It lives here, in a module
 * that imports nothing, because BOTH sides need it and the reporting side is
 * forbidden (`diagnostics/nonInterference.test.ts`) from importing the launch
 * adapter that writes the script.
 */
export function hookFailureLogPath(configDir: string): string {
  return join(configDir, 'codex', 'hook-failures.jsonl');
}

/**
 * The bridge stops appending once the file reaches this size — a hook that fails
 * on every tool call must not grow without bound. Mirrored in the bridge source
 * (`CODEX_HOOK_BRIDGE`) because that script cannot import anything.
 */
export const HOOK_FAILURE_LOG_MAX_BYTES = 64 * 1024;

/**
 * Outcomes the bridge writes. `request-error` is the expected IDE-lifecycle race
 * (the endpoint went away) and exits 0; `input-too-large` is a normal event the
 * bridge declined (tool outputs ride hook inputs) and ALSO exits 0. Every other
 * outcome exits 1 and is what the agent renders as `PostToolUse hook (failed) —
 * hook exited with code 1`.
 *
 * `http-error` and `request-error` carry a bounded detail suffix written by the
 * bridge so the report can name the failure instead of just the exit code:
 * `http-error:404` (the endpoint answered non-2xx) and `request-error:ECONNREFUSED`
 * (the connection failed). The base outcome is still `http-error`/`request-error`;
 * the suffix is diagnostic context.
 */
export const HOOK_BRIDGE_OUTCOMES = [
  'uncaught-exception',
  'unhandled-rejection',
  'input-too-large',
  'invalid-json',
  'invalid-input',
  'invalid-endpoint',
  'http-error',
  'request-error',
] as const;

export type HookBridgeOutcome = (typeof HOOK_BRIDGE_OUTCOMES)[number];

/**
 * The bounded charset a bridge detail suffix may use. A status is digits; a
 * Node error code is `[A-Z0-9_]`. Anything else (prose, whitespace, a path)
 * must not reach a report key — `bridgeOutcomeDetail` returns null and the
 * reader counts the record as `unknown`.
 */
const OUTCOME_DETAIL_RE = /^[0-9A-Za-z_-]{1,24}$/;

/**
 * Parse an outcome the bridge wrote with a detail suffix (e.g.
 * `http-error:404`, `request-error:ECONNREFUSED`). Returns the base outcome and
 * the validated detail, or null when the value is a base outcome without a
 * suffix or a detail outside the bounded charset. The base is still recognized
 * for counting; only the detail is dropped.
 */
export function bridgeOutcomeDetail(
  raw: string,
): { base: HookBridgeOutcome; detail: string } | null {
  const colon = raw.indexOf(':');
  if (colon === -1) return null;
  const base = raw.slice(0, colon);
  if (!(HOOK_BRIDGE_OUTCOMES as readonly string[]).includes(base)) return null;
  const detail = raw.slice(colon + 1);
  if (!OUTCOME_DETAIL_RE.test(detail)) return null;
  return { base: base as HookBridgeOutcome, detail };
}

/**
 * Stable file the bridge reads to discover the current hook endpoint URL.
 * The extension writes this on every activation so revived Codex sessions —
 * whose bridge was configured with a stale port before the reload — POST to
 * the live endpoint instead of connection-refusing into `request-error`.
 */
export function currentEndpointPath(configDir: string): string {
  return join(configDir, 'codex', 'current-endpoint');
}

/**
 * Write the current endpoint URL to the stable config file. Called once per
 * activation after the hook endpoint binds. Best-effort: a write failure must
 * never block extension startup — old sessions fall back to `argv[2]`.
 */
export function writeCurrentEndpoint(
  configDir: string,
  endpointUrl: string,
): void {
  try {
    mkdirSync(dirname(currentEndpointPath(configDir)), { recursive: true });
    writeFileSync(currentEndpointPath(configDir), endpointUrl, { mode: 0o600 });
  } catch {
    // Best-effort -- old bridge scripts fall back to process.argv[2].
  }
}

/**
 * Read the current endpoint URL from the stable config file. Returns
 * `undefined` when the file does not exist or cannot be read (the bridge
 * falls back to its command-line argument in that case).
 */
export function readCurrentEndpoint(configDir: string): string | undefined {
  try {
    const text = readFileSync(currentEndpointPath(configDir), 'utf8').trim();
    return text.length > 0 ? text : undefined;
  } catch {
    return undefined;
  }
}
