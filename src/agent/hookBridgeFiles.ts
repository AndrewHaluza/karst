import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { HookChannel } from './adapter.js';
import { HOOK_BRIDGE, MARKER_EMIT } from './hookBridge.js';
import { resolveNodeExecutable } from './nodeExecutable.js';

/**
 * The directory a hook COMMAND names: the bridge dir as the agent sees it.
 * Scripts are always WRITTEN under `configDir` (host side); a sandboxed agent
 * may see that same dir at another path (`runDir`, e.g. `/karst-bridge/<id>`).
 */
export function hookCommandDir(channel: HookChannel): string {
  return channel.runDir ?? channel.configDir;
}

/**
 * The node a hook command invokes. The host's resolved node is valid whenever
 * the agent sees the host filesystem (no `runDir`, or `runDir === configDir`,
 * e.g. sbx). A remapped `runDir` means a container: use its own `node`.
 */
export function hookNodeCommand(channel: HookChannel): string {
  if (channel.runDir !== undefined && channel.runDir !== channel.configDir) return 'node';
  return resolveNodeExecutable();
}

function writeIfChanged(path: string, body: string): void {
  const current = existsSync(path) ? readFileSync(path, 'utf8') : null;
  if (current === body) return;
  const temporaryPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporaryPath, body);
  renameSync(temporaryPath, path);
}

/**
 * Write `bridge.cjs` and `emit-marker.cjs` into `dir` (atomic temp + rename,
 * skipped when identical) and return the bridge script's path.
 */
export function writeBridgeScripts(dir: string): string {
  mkdirSync(dir, { recursive: true });
  const bridgePath = join(dir, 'bridge.cjs');
  writeIfChanged(bridgePath, HOOK_BRIDGE);
  writeIfChanged(join(dir, 'emit-marker.cjs'), MARKER_EMIT);
  return bridgePath;
}

/**
 * The FILE transport for the generated opencode/opencode2 plugins (ESM). Only
 * rendered into a plugin whose endpoint is `file://`, so an HTTP plugin stays
 * byte-identical. `karstFileEvent(payload)` appends one hook line to the events
 * file (ticket = its parent dir name) and fails open on any error.
 */
export function pluginFileTransport(endpointUrl: string): string {
  if (!endpointUrl.startsWith('file://')) return '';
  return String.raw`
import { appendFileSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
function karstFileEvent(payload) {
  try {
    const eventsPath = fileURLToPath(${JSON.stringify(endpointUrl)});
    const ticketDir = basename(dirname(eventsPath));
    if (!/^\d+$/.test(ticketDir)) return;
    appendFileSync(eventsPath, JSON.stringify({ v: 1, kind: 'hook', ticket: Number(ticketDir), payload }) + '\n');
  } catch {}
}
`;
}

/** Validate a FILE channel: a `file://` endpoint with a `runDir`. */
export function isFileChannel(endpointUrl: string, runDir: string | undefined): boolean {
  if (!endpointUrl.startsWith('file://')) return false;
  if (runDir === undefined) throw new Error(`karst: a file hook endpoint needs a runDir`);
  return true;
}
