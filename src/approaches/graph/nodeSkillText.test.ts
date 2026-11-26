/**
 * Text pin for the graph-node skill (T1369).
 *
 * The host honours a replan only when the node clone holds a change outside the
 * declared write claims (`@arch:GRAPH-PRESERVE`). The skill must therefore tell
 * a node to MAKE and COMMIT the out-of-claim change before it reports `replan`;
 * a path-only report is recorded as `blocked` and the same node is relaunched.
 * This test reads the SOURCE skill (not the `dist/` copy) so the packaged
 * prompt cannot drift back to the old, ineffective instruction.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SKILL = join(
  ROOT,
  '.agents/skills/karst-graph-engineering/skills/graph-node/SKILL.md',
);

describe('graph-node skill text (T1369)', () => {
  const text = readFileSync(SKILL, 'utf8');
  // The skill wraps at ~78 columns; compare on collapsed whitespace so a
  // reflow does not break the pin.
  const flat = text.replace(/\s+/g, ' ');

  it('tells the node to make and commit the out-of-claim change, then report replan', () => {
    expect(flat).toContain('make the change');
    expect(flat).toContain('commit it with the rest of the work');
    expect(flat).toContain('report `replan --reason "needs <path>"`');
  });

  it('no longer tells the node to report a path without changing it', () => {
    expect(text).not.toContain('commit your work and report `replan --reason "<path>"`');
  });

  it('no longer forbids out-of-claim changes', () => {
    expect(text).not.toContain('Do not modify anything outside the declared resource claims');
    expect(text).not.toContain('a change outside the declared claim is rejected');
  });
});
