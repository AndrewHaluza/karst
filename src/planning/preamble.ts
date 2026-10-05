import type { Manifest } from '../manifest/types.js';

/**
 * The seed of a planning session: what the stack is, that the session is
 * read-only, and how it files its outcome. Pure — the launcher in
 * `extension/ops/planning.ts` passes it as the agent's initial prompt.
 */

export type PlanningManifest = Pick<Manifest, 'baselineBranch' | 'repositories'>;

export interface PreambleInput {
  sessionId: number;
  title: string;
  manifest: PlanningManifest;
}

function enabledRepos(manifest: PlanningManifest): [string, Manifest['repositories'][string]][] {
  return Object.entries(manifest.repositories).filter(([, def]) => def.enabled !== false);
}

/** Every enabled repository's path, once each — a monorepo's repositories share one. */
export function planningAddDirs(manifest: PlanningManifest): string[] {
  return [...new Set(enabledRepos(manifest).map(([, def]) => def.repoPath))];
}

export function planningPreamble(input: PreambleInput): string {
  const { sessionId, title, manifest } = input;
  const repos = enabledRepos(manifest).map(
    ([name, def]) => `- ${name}: ${def.repoPath} (base ${def.baselineBranch ?? manifest.baselineBranch})`,
  );
  return [
    `You are in a karst PLANNING session: "${title}".`,
    'This session is read-only. Investigate, ask the user clarifying questions, and agree on the work.',
    'Do not edit files, create branches, or start implementation.',
    '',
    'The stack (repository: path, base branch):',
    ...repos,
    '',
    'When the user agrees on the work, file it as one or more draft tickets:',
    `  karst draft create --session ${sessionId} --title "<title>" --description-file <path> --repos <a,b> \\`,
    '    --summary-file <path> [--after <draft key>]',
    'The summary file holds the decisions reached and the options rejected, with reasons.',
    'It is attached to the ticket for the implementing agent. Use --after to order dependent drafts.',
    'Run `karst guide` for the full CLI reference.',
  ].join('\n');
}
