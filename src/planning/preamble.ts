import type { Manifest } from '../manifest/types.js';
import { karstCliRefs } from '../agent/cliEnv.js';

/** The env var a planning terminal exports; `draft create` cross-checks it. */
export const KARST_PLANNING_SESSION_ENV = 'KARST_PLANNING_SESSION';

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
  const refs = karstCliRefs();
  const repos = enabledRepos(manifest).map(
    ([name, def]) => `- ${name}: ${def.repoPath} (base ${def.baselineBranch ?? manifest.baselineBranch})`,
  );
  return [
    `You are in a karst PLANNING session: "${title}".`,
    'This session is read-only. Investigate, ask the user clarifying questions, and agree on the work.',
    'Do not edit repository files, create branches, or start implementation. Your edit tools are',
    'blocked or need approval; the repositories are listed below — read them by absolute path.',
    '',
    'The stack (repository: path, base branch):',
    ...repos,
    '',
    'When the user agrees on the work, file it as one or more draft tickets:',
    `  node ${refs.cli} --db ${refs.db} --manifest ${refs.manifest} draft create --session ${sessionId} \\`,
    '    --title "<title>" --description-file <path> --summary-file <path> --repos <a,b>',
    'Write the description and summary files in your current directory (a karst scratch directory,',
    'never a repository) and file them in ONE shell command, e.g. `cat > d.md <<\'EOF\' ... EOF && node ...`,',
    'so the user approves filing once.',
    'The summary holds the decisions reached and the options rejected, with reasons;',
    'it becomes the ticket brief the implementing agent reads. File one draft per piece of work,',
    'and state any ordering between them in each description.',
    `Run \`node ${refs.cli} guide\` for the full CLI reference.`,
  ].join('\n');
}
