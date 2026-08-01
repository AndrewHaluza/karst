import { rmSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';

/**
 * The only path shapes an adapter may claim — and therefore the only ones
 * session close will delete. Deliberately narrower than `KARST_EXCLUDE_RULES`
 * (which also covers `/.karst/`, the directory holding the worktrees
 * themselves): every deletable path must be excluded, never the reverse.
 * `karstExcludes.test.ts` pins that direction.
 */
export const OWNED_PREFIXES = [
  `${sep}.agents${sep}skills${sep}karst-`,
  `${sep}.codex${sep}karst${sep}`,
  `${sep}.karst-plugin${sep}`,
  `${sep}.agents${sep}plugins${sep}`,
] as const;

export function cleanupOwnedPaths(
  worktreePath: string,
  ownedPaths: readonly string[],
): void {
  const root = resolve(worktreePath);
  for (const candidate of ownedPaths) {
    const target = resolve(root, candidate);
    const rel = relative(root, target);
    const inside =
      rel !== '' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
    const normalized = `${sep}${rel.split(sep).join(sep)}`;
    const reserved = OWNED_PREFIXES.some((prefix) =>
      normalized.startsWith(prefix),
    );
    if (!inside || !reserved) {
      throw new Error(`karst: unsafe adapter-owned path "${candidate}"`);
    }
    rmSync(target, { recursive: true, force: true });
  }
}
