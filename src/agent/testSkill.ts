/**
 * Render the test-family skill as a complete document: YAML frontmatter
 * (name + description) + generated stamp + body. Every adapter writes this
 * output to its native skill directory — the frontmatter is what Claude,
 * Codex, Opencode, and Antigravity use for description-driven skill
 * discovery.
 *
 * The prefix carries `--db` and `--manifest` so the skill body never asks
 * the agent to compose those paths itself (§ skill surface, ticket 13).
 */

import { GENERATED_STAMP } from './generatedArtifact.js';

export const TEST_SKILL_NAME = 'karst-test';
export const TEST_SKILL_DESCRIPTION =
  'Use the karst test driver to create tickets, inject verdicts, and inspect workflow state.';

export function renderTestSkill(cliPrefix: string): string {
  return [
    '---',
    `name: ${TEST_SKILL_NAME}`,
    `description: ${TEST_SKILL_DESCRIPTION}`,
    '---',
    `${GENERATED_STAMP}`,
    '',
    '# Karst test driver',
    '',
    'The `karst test` CLI is a **development tool** that programmatically drives',
    'and inspects the full ticket workflow. It deliberately bypasses gate verdicts —',
    'a `test advance --verdict passed` can move a stage a real gate never ran, and',
    '`test reset` wipes a registry.',
    '',
    '## When to use',
    '',
    'Use this skill when you need to **create tickets, inject verdicts, simulate',
    'hooks, open/merge PRs, or read full state** from scripts or test harnesses.',
    'Never use it as a way for a working agent to report progress: the `stage`',
    'marker is the only verb that records an agent\'s own done marker.',
    '',
    '## Command prefix',
    '',
    'All test commands share this prefix. Append the subcommand and its arguments:',
    '',
    `\`${cliPrefix}\``,
    '',
    '## Subcommands',
    '',
    '- `create-ticket --title <title> [--key <key>] [--type <type>]',
    '  [--approach <approach>] [--description <desc>] [--project <slug>]` —',
    '  create a ticket, idempotent by key. Scope with `--project`.',
    '- `set-stage --ticket <key> --stage <stage>` — force a ticket to a stage.',
    '- `advance --ticket <key> --verdict <passed|failed>` — inject a verdict.',
    '- `run-gate --ticket <key> --gate <gate> --verdict <passed|failed>',
    '  [--log <text>]` — inject a gate run.',
    '- `simulate-hook --ticket <key> --event <event> [--data <json>]` — inject',
    '  a hook event.',
    '- `open-pr --ticket <key> --repo <repo> --branch <branch> --pr <number>`',
    '  — inject a PR record.',
    '- `merge-pr --ticket <key> --pr <number>` — merge an injected PR.',
    '- `get-state --ticket <key>` — read full ticket state as JSON.',
    '- `get-stage --ticket <key>` — read the current stage.',
    '- `get-logs [--ticket <key>] [--tail <n>]` — read stage gate logs.',
    '- `get-hooks --ticket <key>` — read hook event history.',
    '- `assert --ticket <key> --expect <json>` — assert ticket state matches.',
    '- `pause --ticket <key>` — pause a ticket.',
    '- `unpause --ticket <key>` — unpause a ticket.',
    '- `reset` — wipe the entire registry (destructive, no confirmation).',
    '',
    '## Rules',
    '',
    '1. This is a **development tool**, not a way for a working agent to report',
    '   progress. The `stage` marker is the only verb that records an agent\'s',
    '   own done marker.',
    '2. `test advance --verdict passed` can move a stage a real gate never ran.',
    '   Use it only in test harnesses, never in production workflows.',
    '3. `test reset` wipes the entire registry. There is no undo.',
    '4. Every subcommand that targets a ticket requires `--ticket <key>`.',
  ].join('\n');
}
