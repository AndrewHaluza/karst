import { join } from 'node:path';
import type { Manifest } from '../manifest/types.js';
import { KARST_CLI_ENV, envRef } from '../agent/cliEnv.js';
import { MCP_TOOLS_PREFERRED } from '../agent/promptText.js';

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
 * The INSTRUCTIONS layer of a planning session — the standing rules the agent
 * adopts through its own system/developer channel (see `agent/instructions.ts`):
 * the planning role, the no-edit rule, the stack it may read, and the
 * `draft propose` contract. It is written to a file and delivered by each core's
 * declared channel; it never rides the kickoff as prose.
 *
 * The KICKOFF is separate and empty by default (a planning session opens no
 * ticket and has no first user message to replay) — see `planningKickoff`.
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

/** The standing instructions delivered through the core's own channel. */
export function planningInstructions(input: PreambleInput): string {
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
    'it becomes the ticket brief the implementing agent reads. Propose one draft per piece of work.',
    'When one draft waits on another, set "dependsOn" to the host ids already assigned to the',
    'drafts it needs (the #N each propose prints and `draft list` shows) — do NOT describe the',
    'ordering in prose. Propose the prerequisite first, read its #N, then list it in the dependent',
    'draft\'s "dependsOn"; if you only learn an id later, revise the dependent with both "id" and',
    '"dependsOn". The host rejects an unknown id, a draft of another session, or an ordering cycle.',
    '',
    'Each propose prints the draft\'s id, e.g. {"ok":true,"id":3}. Cite drafts to the user as #N.',
    'To REVISE a draft you already filed (new findings, changed repos), add that integer as "id" to',
    'the JSON object and propose again: the host replaces the draft in place while it is still',
    `pending. \`node ${cli} draft list\` re-reads the ids and statuses of this session's drafts.`,
    MCP_TOOLS_PREFERRED,
    `Run \`node ${cli} guide\` for the full CLI reference.`,
  ].join('\n');
}

/**
 * The kickoff that seeds the launch's first user message. A planning session
 * has none today (the user's first message arrives through the TUI), so the
 * launcher passes the title here only when it wants to open with it. Empty is
 * valid: the instructions file already carries the standing rules.
 */
export function planningKickoff(firstMessage?: string): string {
  return firstMessage?.trim() ?? '';
}
