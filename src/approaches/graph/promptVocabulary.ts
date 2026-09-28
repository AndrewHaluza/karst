import type { CompileContext } from './compile.js';

/** Planner completion is a durable CLI submission, not terminal lifecycle. */
export const PLANNER_SUBMIT_INSTRUCTION =
  'After writing every artifact and `graph.json`, run `node "$KARST_GRAPH_CLI" graph submit`. Wait for it to report `{"ok":true}`, then exit; karst observes the committed submission and does not depend on the terminal closing.';

/**
 * The exact vocabulary a plan for THIS run may name.
 *
 * The planner skill forbids inventing repository, profile and command ids, but
 * the ids it may use were never handed to it — it had to infer them from the
 * ticket context, where a repository appears under its manifest spelling and a
 * command does not appear at all. This block states the legal sets, in the
 * canonical form a document must carry, so a plan written in good faith
 * compiles.
 */
export function plannerVocabulary(context: CompileContext, artifactRoot = ''): string {
  const list = (values: Iterable<string>): string[] => [...values].sort();
  const fmt = (values: string[]): string => values.map((v) => `\`${v}\``).join(', ');
  const repositories = list(context.repositories.keys());
  const profiles = list(context.profiles.keys());
  const commands = list(context.commands.keys());
  return [
    '## Legal values for this run',
    'Use ONLY these ids; anything else fails to compile.',
    `- repositories: ${
      repositories.length
        ? `${fmt(repositories)} (the canonical, case-folded manifest names — claim them exactly as spelled here)`
        : 'none — this run cannot claim repositories'
    }`,
    `- profiles: ${profiles.length ? fmt(profiles) : 'none'}`,
    `- commands: ${
      commands.length ? fmt(commands) : 'none — this run cannot use `command` nodes'
    }`,
    ...(artifactRoot
      ? [
          `- artifact root: \`${artifactRoot}\` — every \`artifacts[].path\` resolves`,
          '  under it, so write the files there, not into a repository worktree. The',
          '  root directory is itself named `artifacts`: do not prefix declared paths',
          '  with `artifacts/`, or they resolve one level too deep and compile to',
          '  `planner-artifact-missing`.',
        ]
      : []),
  ].join('\n');
}

/**
 * `plannerVocabulary` for a run, best-effort.
 *
 * Building a compile context walks the manifest, the worktrees and the command
 * allowlist and touches the filesystem. That work exists to compile a document,
 * where a failure has a diagnostic path; it must not be able to fail a planner
 * LAUNCH, which only wants prompt text. A throw degrades the prompt to no
 * vocabulary block instead.
 */
export function plannerVocabularyFor(
  contextOf: () => CompileContext,
  artifactRoot = '',
  onDebug?: (message: string) => void,
): string {
  try {
    return plannerVocabulary(contextOf(), artifactRoot);
  } catch (err) {
    onDebug?.(`[driver] planner vocabulary unavailable: ${String(err)}`);
    return '';
  }
}
