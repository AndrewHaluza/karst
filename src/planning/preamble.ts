import { join } from 'node:path';
import type { Manifest } from '../manifest/types.js';
import { KARST_CLI_ENV, envRef } from '../agent/cliEnv.js';

/**
 * The env var a planning terminal exports. Used ONLY to re-adopt the terminal
 * after a window reload — it is not an identity or auth mechanism.
 */
export const KARST_PLANNING_SESSION_ENV = 'KARST_PLANNING_SESSION';

/** The env var naming the session's outbox, where `draft propose` writes. */
export const PLANNING_OUTBOX_ENV = 'KARST_OUTBOX';

/** A session's outbox: inside its scratch dir (the agent's cwd). */
export function planningOutboxDir(scratch: string): string {
  return join(scratch, 'outbox');
}

/**
 * The seed of a planning session: what the stack is, that it must not edit
 * (enforcement differs per core — see agent-cores.md), and how it files its outcome. Pure — the launcher in
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
  const { title, manifest } = input;
  const cli = envRef(KARST_CLI_ENV);
  const enabled = enabledRepos(manifest);
  const repos = enabled.map(
    ([name, def]) => `- ${name}: ${def.repoPath} (base ${def.baselineBranch ?? manifest.baselineBranch})`,
  );
  return [
    `You are in a karst PLANNING session: "${title}".`,
    'Investigate, ask the user clarifying questions, and agree on the work.',
    'Do not edit repository files, create branches, or start implementation. Depending on the agent,',
    'edit tools are blocked or need your approval; the repositories are listed below — read them by absolute path.',
    '',
    'The stack (repository: path, base branch):',
    ...repos,
    '',
    'When the user agrees on the work, propose it as one or more draft tickets. Each proposal is',
    'ONE shell command that pipes one JSON object to karst on stdin, e.g.:',
    `  printf '%s' '{"title":"…","description":"…","summary":"…","repos":["…"]}' | node ${cli} draft propose`,
    `or, for long text, a quoted heredoc: node ${cli} draft propose <<'EOF' … EOF`,
    `"repos" lists repository names from the stack above (${enabled.map(([n]) => n).join(', ')}); [] when unsure.`,
    'A proposal is not a ticket: the user reviews the full content and confirms or discards it.',
    'The summary holds the decisions reached and the options rejected, with reasons;',
    'it becomes the ticket brief the implementing agent reads. Propose one draft per piece of work,',
    'and state any ordering between them in each description.',
    `Run \`node ${cli} guide\` for the full CLI reference.`,
  ].join('\n');
}
