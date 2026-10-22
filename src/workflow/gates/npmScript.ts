import type { GitRunner } from '../../integrations/git.js';

const RUNNERS: ReadonlySet<string> = new Set(['npm', 'pnpm', 'yarn']);

/**
 * The package.json script a command gate runs, when it is `npm|pnpm|yarn run
 * [flags] <name>`; null for anything else, and for `--if-present` (that flag
 * says a missing script is fine, so there is nothing to check).
 */
export function deriveNpmScript(command: string, args: readonly string[]): string | null {
  if (!RUNNERS.has(command) || args[0] !== 'run') return null;
  const rest = args.slice(1);
  for (const arg of rest) {
    if (arg === '--') return null;
    if (arg === '--if-present') return null;
    if (!arg.startsWith('-')) return arg;
  }
  return null;
}

/** True when `<baseRef>:./package.json` (read from `cwd`) defines `script`. A failed lookup reads as "no". */
export async function baseDefinesScript(
  git: GitRunner,
  cwd: string,
  baseRef: string,
  script: string,
): Promise<boolean> {
  try {
    const result = await git(['show', `${baseRef}:./package.json`], cwd);
    if (result.exitCode !== 0) return false;
    const parsed = JSON.parse(result.stdout) as { scripts?: Record<string, string> };
    return parsed.scripts?.[script] !== undefined;
  } catch {
    return false;
  }
}
