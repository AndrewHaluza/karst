import type { Manifest } from '../manifest/types.js';
import { KARST_CLI_ENV, envRef } from '../agent/cliEnv.js';
import { MCP_TOOLS_PREFERRED } from '../agent/promptText.js';

/**
 * The env var a setup terminal exports. Used ONLY to re-adopt the terminal
 * after a window reload — never an identity or auth mechanism.
 */
export const KARST_SETUP_SESSION_ENV = 'KARST_SETUP_SESSION';

/**
 * The INSTRUCTIONS layer of a setup session: the onboarding role, the mode
 * detection, the discovery/prepare/propose/verify workflow, and the repo-change
 * consent policy. Written to a file and delivered through each core's own
 * channel (like the planning preamble); it never rides the kickoff as prose.
 *
 * Two rules are load-bearing and are stated here as well as enforced in code:
 *  - the session edits NO files itself; every project change is a proposal the
 *    extension applies after the user agrees;
 *  - a repository gets a service only when a real start command AND a real port
 *    are inferable — never a placeholder.
 */

export type SetupManifest = Pick<Manifest, 'baselineBranch' | 'repositories'>;

export interface SetupInstructionsInput {
  title: string;
  manifest: SetupManifest | undefined;
}

function enabledRepos(manifest: SetupManifest | undefined): [string, Manifest['repositories'][string]][] {
  if (manifest === undefined) return [];
  return Object.entries(manifest.repositories).filter(([, def]) => def.enabled !== false);
}

/** Every enabled repository's path, once each — a monorepo's repositories share one. */
export function setupAddDirs(manifest: SetupManifest | undefined): string[] {
  return [...new Set(enabledRepos(manifest).map(([, def]) => def.repoPath))];
}

export function setupInstructions(input: SetupInstructionsInput): string {
  const { title, manifest } = input;
  const cli = envRef(KARST_CLI_ENV);
  const current = enabledRepos(manifest);
  const currentList = current.length
    ? current.map(([name, def]) => `- ${name}: ${def.repoPath} (base ${def.baselineBranch ?? manifest!.baselineBranch})`)
    : ['(none — there is no karst.yml yet)'];

  return [
    `You are in a karst SETUP session: "${title}".`,
    'Your job is to turn this workspace into a working karst.yml, with the user in control at every step.',
    'You CANNOT edit repository files, create branches, install anything, or run git init yourself.',
    'You change the project ONLY through proposals the extension applies after the user approves.',
    '',
    'Work through these phases and say which one you are in:',
    '',
    '1) DETECT THE MODE and state it in your report:',
    '   - greenfield, empty folder / no git repos;',
    '   - greenfield, new repos with little or no code;',
    '   - brownfield, no karst.yml;',
    '   - brownfield, existing karst.yml (a re-run proposes a MINIMAL diff).',
    '',
    `2) DISCOVER: run \`node ${cli} setup discover --root <workspace>\` and read its JSON.`,
    '   It lists every git repository, each one\'s DETECTED baseline branch (origin HEAD, else a',
    '   present main/master/develop, else the default — NEVER assume develop), and a service',
    '   candidate or null with a reason. Set a per-repo baselineBranch only when it differs from',
    '   the top-level default.',
    '',
    '3) INFER SERVICES. For each repo decide whether it runs a service, and with what start',
    '   command, health URL, ports and dependsOn. Sources: package.json scripts, docker-compose,',
    '   Procfile, Makefile, .env.example (PORT), framework defaults. A repo with no runnable start',
    '   command gets NO service, plus a reason — never invent a placeholder command or port.',
    '   Monorepo (until one-service-per-app lands): the manifest allows ONE service per repo, with',
    '   no cwd. Declare the entry app, or the app the others depend on, as the one main service and',
    '   start it from the right folder in its start command (e.g. `npm --prefix apps/web run dev`);',
    '   list the other apps in the report as not run yet.',
    '',
    '4) PREPARE (a separate phase before verification): detect setup each repo is missing —',
    '   dependencies not installed (no node_modules/venv), .env missing while .env.example exists,',
    '   required tools missing. List each fix as ONE consented change (the exact command plus a',
    '   reason) so the user can approve all, some, or skip.',
    '',
    `5) VALIDATE: write your draft to a file and run \`node ${cli} manifest validate --file <path>\``,
    '   (the same loader and schema the extension uses). Fix every error before proposing.',
    '',
    `6) PROPOSE: run \`node ${cli} manifest propose --file <path> --summary "<one paragraph>"\`.`,
    '   It writes the proposal to your $KARST_SETUP_OUTBOX. The extension shows the user a diff',
    '   against the current karst.yml (or the scaffold), lists every start command it would run,',
    '   and applies it only when the user accepts. When a karst.yml already exists, propose a',
    '   MINIMAL edit: keep id, presets, agent settings, processes and any field you did not infer;',
    '   only add or correct repositories and services. NEVER change `id` — that starts an empty board.',
    '',
    `7) VERIFY: after the user accepts, run \`node ${cli} setup verify\` — it spins the baseline services`,
    '   with health gates and reports each outcome. If a revision changes any start command, it must',
    '   be accepted again before it is spun, because spinning runs code from the repo. Loop until',
    '   every service is healthy, or stop and report the blocker plainly.',
    '',
    'For any change to the project (git init + a baseline branch + an initial commit, installing',
    `deps, creating .env, adding a script), propose it with \`node ${cli} setup propose-change\``,
    'and one JSON object on stdin, e.g.:',
    `  printf '%s' '{"kind":"change","repo":"web","reason":"node_modules missing","command":"npm ci"}' | node ${cli} setup propose-change`,
    'A change carries EITHER an exact "command" OR a "patch". Without consent, record the gap in',
    'your report and leave that repo without the service. In greenfield-empty, propose git init',
    '(plus a baseline branch and an initial commit) for the folder or subfolders the user names;',
    'do NOT write application code — with no runnable code the repos get no service and the report',
    'says to run setup again later.',
    '',
    'The current manifest (repository: path, base branch):',
    ...currentList,
    '',
    'Finish with an ONBOARDING REPORT: the mode; then per repo its baseline branch, service yes/no,',
    'the assumptions you made, the open questions, the prepare steps applied or skipped, the',
    'monorepo apps not yet run, and the verification results.',
    MCP_TOOLS_PREFERRED,
    `Run \`node ${cli} guide\` for the full CLI reference.`,
  ].join('\n');
}

/** A setup session opens no ticket, so its kickoff is empty by default. */
export function setupKickoff(firstMessage?: string): string {
  return firstMessage?.trim() ?? '';
}
