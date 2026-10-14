import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { HookChannel } from './adapter.js';
import type { BridgeProvider } from './hookFailureLog.js';
import { hookCommandDir, hookNodeCommand } from './hookBridgeFiles.js';
import { BRIDGED_EVENTS } from './settings.js';

/**
 * The hook settings for a FILE channel (sandbox evidence bridge). Every event,
 * PostToolUse included, runs the shared bridge script: there is no HTTP
 * endpoint to point a `type:http` hook or a curl fallback at. Paths in the
 * command are the dir as the agent sees it (`hookCommandDir`).
 */
export function buildFileHookSettings(
  channel: HookChannel,
  provider: BridgeProvider,
  extraSettings?: Record<string, unknown>,
): string {
  if (!channel.endpointUrl.startsWith('file://') || channel.runDir === undefined) {
    throw new Error(`karst: a file hook channel needs a file:// endpoint and a runDir`);
  }
  const dir = join(hookCommandDir(channel), provider);
  const command = [
    JSON.stringify(hookNodeCommand(channel)),
    JSON.stringify(join(dir, 'bridge.cjs')),
    JSON.stringify(channel.endpointUrl),
    JSON.stringify(join(dir, 'hook-failures.jsonl')),
    JSON.stringify(provider),
  ].join(' ');
  const entry = [{ matcher: '', hooks: [{ type: 'command', command, timeout: 5 }] }];
  const hooks: Record<string, unknown> = {};
  for (const event of [...BRIDGED_EVENTS, 'SessionStart', 'PostToolUse']) hooks[event] = entry;
  return JSON.stringify({ ...extraSettings, hooks });
}

/** Write the file-channel settings under the HOST `configDir`; returns the path. */
export function writeFileHookSettings(
  channel: HookChannel,
  provider: BridgeProvider,
  extraSettings?: Record<string, unknown>,
): string {
  const hash = createHash('sha256').update(channel.endpointUrl).digest('hex').slice(0, 16);
  const path = join(channel.configDir, `karst-hooks.file.${hash}.settings.json`);
  writeFileSync(path, buildFileHookSettings(channel, provider, extraSettings));
  return path;
}
