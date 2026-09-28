import type { Store } from '../store/db.js';
import { findTicketById } from '../store/tickets.js';
import { createSubtask } from '../workflow/stages/subtask.js';

/**
 * The `karst subtask create` write verb (design NDL-70 §7).
 *
 * A running ticket's agent is the one that discovers unfinished work, so this
 * verb runs from INSIDE a session: the parent is the session's own ticket,
 * resolved by `main.ts` through `--ticket` + `--manifest` exactly like `stage`
 * and `env`, and passed here as a row id. Argv carries only the new ask.
 *
 * Writing goes through the shared `createSubtask` writer (NDL-71), so every
 * §3 rule — parent exists/not archived/same project, parent not `ship`/`done`,
 * depth cap, repo subset, inherited fields — is enforced in one place, not
 * re-implemented at the CLI. The store is the writable `node:sqlite` one, so
 * `cli/assertMigrated` has already refused a stale registry before we get here.
 */

export interface ParsedSubtaskCreate {
  title: string;
  /** The new ask. The one field not copied from the parent. */
  description?: string;
  /** Whether the sub-task holds the parent before it leaves `impl`/`fix`. */
  blocking: boolean;
  /** Optional subset of the parent's repos; omitted means all of them. */
  repos?: string[];
}

/**
 * Parse `['subtask', 'create', ..flags]`. Fails fast on anything else so a
 * malformed invocation names the offending token rather than silently creating
 * a sub-task with the wrong shape.
 */
export function parseSubtaskCreateArgs(argv: string[]): ParsedSubtaskCreate {
  const [cmd, sub, ...rest] = argv;
  if (cmd !== 'subtask') {
    throw new Error(`expected 'subtask' command, got '${cmd ?? ''}'`);
  }
  if (sub !== 'create') {
    throw new Error(`unknown subtask subcommand '${sub ?? ''}' (want 'create')`);
  }

  let title: string | undefined;
  let description: string | undefined;
  let blocking = false;
  let repos: string[] | undefined;

  for (let i = 0; i < rest.length; i++) {
    const token = rest[i]!;
    if (token === '--title') {
      title = rest[++i];
      if (title === undefined) throw new Error("karst subtask create: --title needs a value");
    } else if (token === '--description') {
      description = rest[++i];
      if (description === undefined) {
        throw new Error('karst subtask create: --description needs a value');
      }
    } else if (token === '--blocking') {
      blocking = true;
    } else if (token === '--repos') {
      const raw = rest[++i];
      if (raw === undefined) throw new Error('karst subtask create: --repos needs a value');
      repos = raw
        .split(',')
        .map((name) => name.trim())
        .filter((name) => name !== '');
      if (repos.length === 0) {
        throw new Error('karst subtask create: --repos needs a comma-separated list');
      }
    } else {
      throw new Error(
        `unknown flag '${token}' (want --title, --description, --blocking or --repos)`,
      );
    }
  }

  if (title === undefined || title.trim() === '') {
    throw new Error(
      "missing --title (usage: subtask create --title <title> [--description <desc>] [--blocking] [--repos a,b])",
    );
  }

  return { title: title.trim(), description, blocking, repos };
}

/**
 * Create the sub-task under `parentId` and return a JSON result naming it.
 * Throws with the writer's own actionable message on any §3 violation.
 */
export function runSubtaskCommand(
  store: Store,
  parentId: number,
  argv: string[],
  debug?: (message: string) => void,
): string {
  const parsed = parseSubtaskCreateArgs(argv);
  const parent = findTicketById(store, parentId);
  if (!parent) throw new Error(`no ticket found for id '${parentId}'`);

  const child = createSubtask(
    store,
    parentId,
    {
      title: parsed.title,
      description: parsed.description,
      blocking: parsed.blocking,
      repos: parsed.repos,
    },
    {},
    debug,
  );

  return JSON.stringify({
    ok: true,
    id: child.id,
    key: child.key,
    title: child.title,
    parent: parent.key ?? `#${parentId}`,
    blocking: child.blocksParent,
    repos: child.selectedRepos,
    stage: child.stageCurrent,
  });
}
