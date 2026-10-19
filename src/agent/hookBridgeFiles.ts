import { randomBytes } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync, type Stats } from 'node:fs';
import { join } from 'node:path';
import type { HookChannel } from './adapter.js';
import { HOOK_BRIDGE, ACK_EMIT, MARKER_EMIT } from './hookBridge.js';
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
 * The node a hook command invokes. Any FILE channel (`runDir` set) runs inside
 * a sandbox (docker container or sbx microVM) where the host's node path does
 * not exist: use the sandbox's own `node`. Host launches use the host's node.
 */
export function hookNodeCommand(channel: HookChannel): string {
  if (channel.runDir !== undefined) return 'node';
  return resolveNodeExecutable();
}

/**
 * Write `body` to `path`, idempotently and atomically. Shared by the hook
 * bridge scripts and the Claude statusline quota wrapper.
 *
 * The dir may be sandbox-writable: never follow a symlink. Only a regular file
 * is read for the skip check; the temp file is created exclusively ('wx') under
 * an unpredictable name, then renamed over whatever entry is there.
 */
export function writeFileIfChanged(path: string, body: string): void {
  const entry = lstatOrUndefined(path);
  if (entry?.isFile() && readFileSync(path, 'utf8') === body) return;
  const temporaryPath = `${path}.${randomBytes(8).toString('hex')}.tmp`;
  writeFileSync(temporaryPath, body, { flag: 'wx' });
  renameSync(temporaryPath, path);
}

function lstatOrUndefined(path: string): Stats | undefined {
  try {
    return lstatSync(path);
  } catch {
    return undefined;
  }
}

/**
 * Write `bridge.cjs` and `emit-marker.cjs` into `dir` (atomic temp + rename,
 * skipped when identical) and return the bridge script's path.
 */
export function writeBridgeScripts(dir: string): string {
  mkdirSync(dir, { recursive: true });
  const bridgePath = join(dir, 'bridge.cjs');
  writeFileIfChanged(bridgePath, HOOK_BRIDGE);
  writeFileIfChanged(join(dir, 'emit-marker.cjs'), MARKER_EMIT);
  writeFileIfChanged(join(dir, 'emit-ack.cjs'), ACK_EMIT);
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
