import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const SKILLS_ROOT = join(__dirname, '..', '..', '.agents', 'skills');

/**
 * An approach body runs inside a karst-driven stage. A stage whose agent is
 * waiting on the user is not complete, and the done marker is refused while it
 * waits (`renderDoneMarkerInstruction`, AGENT_GUIDE rule 3). An agent-advanced
 * stage such as `impl` has no gate that can fail it, so a body that tells the
 * agent to stop and wait for a human parks the ticket forever.
 *
 * The gates are the approval: no packaged skill body may contain a
 * stop-and-wait-for-user directive.
 */
const BLOCKING_DIRECTIVES = [
  /STOP and wait/i,
  /REQUIRES user interaction/i,
  /request user approval/i,
  /DO NOT proceed automatically/i,
];

function findSkillFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .map((entry) =>
      join(entry.parentPath ?? (entry as unknown as { path: string }).path, entry.name),
    );
}

describe('packaged skill bodies never block on the user', () => {
  const files = findSkillFiles(SKILLS_ROOT);

  it('finds skill files to check', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const file of files) {
    const rel = file.slice(SKILLS_ROOT.length + 1);
    it(`${rel} contains no stop-and-wait-for-user directive`, () => {
      const lines = readFileSync(file, 'utf-8').split('\n');
      const offenders = lines
        .map((line, i) => ({ line, n: i + 1 }))
        .filter(({ line }) => BLOCKING_DIRECTIVES.some((re) => re.test(line)))
        .map(({ line, n }) => `${rel}:${n}: ${line.trim()}`);
      expect(offenders, 'the gates are the approval — a driven stage cannot block on a human').toEqual([]);
    });
  }
});
