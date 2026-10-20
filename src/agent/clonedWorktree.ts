import { readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const FILE = 'cloned-worktree.json';

/** Records which host worktree a sandbox cloned (arch:AC-32), in the host-owned bridge dir. */
export async function recordClonedWorktree(bridgeDir: string, worktreePath: string): Promise<void> {
  await writeFile(join(bridgeDir, FILE), JSON.stringify({ path: worktreePath }));
}

/**
 * The recorded path, but only when it is one of `known` (the ticket's own worktrees): the bridge dir is
 * visible to the agent, so a tampered record can at worst pick another worktree of the same ticket.
 */
export function readClonedWorktree<T extends { readonly path: string }>(bridgeDir: string | undefined, known: readonly T[]): T | undefined {
  if (bridgeDir === undefined) return undefined;
  try {
    const { path } = JSON.parse(readFileSync(join(bridgeDir, FILE), 'utf8')) as { path?: unknown };
    return known.find((w) => w.path === path);
  } catch {
    return undefined;
  }
}
