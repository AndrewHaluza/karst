import type { Manifest } from '../../manifest/types.js';
import type { RegenerateSpec } from './regenerate.js';

/** The `regenerate` run option for a repo, or `{}` when it declares none (behavior unchanged). */
export function regenerateOption(manifest: Manifest | undefined, repo: string): { regenerate?: RegenerateSpec } {
  const commands = manifest?.repositories[repo]?.ship?.regenerate ?? [];
  return commands.length > 0 ? { regenerate: { repo, commands } } : {};
}
