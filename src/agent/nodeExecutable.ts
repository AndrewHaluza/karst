import { accessSync, constants, existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Resolve a standalone Node.js executable on PATH. Required by bridge scripts
 * (`.cjs`) that must run under Node, not Electron. Exported from a leaf module
 * so both `codex.ts` and `settings.ts` can import without circular deps.
 */
export function resolveNodeExecutable(
  pathValue = process.env.PATH ?? '',
  platform: NodeJS.Platform = process.platform,
): string {
  const separator = platform === 'win32' ? ';' : ':';
  const executable = platform === 'win32' ? 'node.exe' : 'node';
  for (const directory of pathValue.split(separator)) {
    if (!directory) continue;
    const candidate = join(directory, executable);
    if (!existsSync(candidate)) continue;
    if (platform !== 'win32') {
      try {
        accessSync(candidate, constants.X_OK);
      } catch {
        continue;
      }
    }
    return candidate;
  }
  throw new Error(
    'karst: hook bridge requires a standalone Node.js executable on PATH',
  );
}
