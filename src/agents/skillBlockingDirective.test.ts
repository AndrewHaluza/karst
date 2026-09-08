import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listTrackedFiles } from '../agent/agentsTree.js';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));

/**
 * An approach body runs inside a karst-driven stage. A stage whose agent is
 * waiting on the user is not complete, and the done marker is refused while it
 * waits (`renderDoneMarkerInstruction`, AGENT_GUIDE rule 3). An agent-advanced
 * stage such as `impl` has no gate that can fail it, so a body that tells the
 * agent to stop and wait for a human parks the ticket forever.
 *
 * The gates are the approval: no packaged skill body may contain a
 * stop-and-wait-for-user directive.
 *
 * The guard scans GIT-TRACKED files, not the on-disk tree: an approach
 * package installed into `.agents/skills/` by a user is excluded from git
 * (`karstExcludes.ts` / `.git/info/exclude`) and is not a body this
 * repository packages. A disk-walking guard turns another author's skill
 * into this repo's red suite — exactly backwards.
 */
const BLOCKING_DIRECTIVES = [
  /STOP and wait/i,
  /REQUIRES user interaction/i,
  /request user approval/i,
  /DO NOT proceed automatically/i,
];

describe('packaged skill bodies never block on the user', () => {
  const files = listTrackedFiles(REPO_ROOT, '.agents/skills').filter(
    (file) => file.endsWith('.md') && existsSync(file),
  );

  it('finds skill files to check', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const file of files) {
    const rel = relative(REPO_ROOT, file);
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
