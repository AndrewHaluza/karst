import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** One review gate: a name, the npm script it needs, and how to invoke it. */
export interface GateSpec {
  /** The name the verdict and the log use. */
  name: string;
  /** The package.json script this gate runs — the thing that must exist. */
  script: string;
  /** Args passed to `npm`. */
  args: readonly string[];
}

/**
 * The MVP review gates. Each names the script it depends on, because a gate is
 * only answerable by a repo that defines it: `npm run lint` in a repo with no
 * lint script exits 1 with "Missing script", which says something about the
 * repo's configuration and nothing about the ticket's code.
 */
export const REVIEW_GATES: readonly GateSpec[] = [
  { name: 'lint', script: 'lint', args: ['run', 'lint'] },
  { name: 'typecheck', script: 'typecheck', args: ['run', 'typecheck'] },
  { name: 'test', script: 'test', args: ['test'] },
];

/**
 * The uat gate: the repo's own suite. Shares REVIEW_GATES' 'test' entry by
 * design — uat and review ask the same repo the same question at two different
 * moments, and neither may invent a script the repo never defined.
 */
export const UAT_GATE: GateSpec = { name: 'test', script: 'test', args: ['test'] };

/**
 * The `scripts` a repo defines, or `{}` when it defines none — no package.json,
 * unreadable, malformed, or no scripts block. Never throws: an unreadable
 * package.json means karst cannot ask this repo anything, which is an answer,
 * not a crash in the middle of a gate.
 */
export function readPackageScripts(cwd: string): Record<string, string> {
  try {
    const parsed = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    return parsed.scripts ?? {};
  } catch {
    return {};
  }
}
