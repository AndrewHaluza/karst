import type { Manifest } from '../../manifest/types.js';
import type { RegenerateSpec } from './regenerate.js';

/** The `regenerate` run option for a repo, or `{}` when it declares none (behavior unchanged). */
export function regenerateOption(manifest: Manifest | undefined, repo: string): { regenerate?: RegenerateSpec } {
  const ship = manifest?.repositories[repo]?.ship;
  const commands = ship?.regenerate ?? [];
  return commands.length > 0 ? { regenerate: { repo, commands, exclude: ship?.exclude ?? [] } } : {};
}
