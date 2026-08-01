import { join } from 'node:path';

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
 * (the endpoint went away) and exits 0; every other outcome exits 1 and is what
 * the agent renders as `PostToolUse hook (failed) — hook exited with code 1`.
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
