/** Spawn the detached host OAuth proxy (same detach pattern as the runtime supervisor). */
import { spawn } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import type { ProxyPaths } from './client.js';

export interface SpawnProxyInput {
  readonly script: string;
  readonly paths: ProxyPaths;
  readonly logFile: string;
  /** `node` from PATH by default: the extension host `process.execPath` is Electron, not node. */
  readonly nodeBinary?: string;
  readonly onError?: (message: string) => void;
}

export function spawnDetachedProxy(input: SpawnProxyInput): void {
  const logFd = openSync(input.logFile, 'a', 0o600);
  try {
    const child = spawn(input.nodeBinary ?? 'node', [input.script], {
      detached: true,
      stdio: ['ignore', logFd, logFd],
      env: { ...process.env, KARST_OAUTH_PORT_FILE: input.paths.portFile, KARST_OAUTH_CONTROL_DIR: input.paths.controlDir },
    });
    child.on('error', (e: NodeJS.ErrnoException) => input.onError?.(`[oauth-proxy] spawn failed: ${e.code ?? e.name}`));
    child.unref();
  } finally {
    closeSync(logFd);
  }
}
