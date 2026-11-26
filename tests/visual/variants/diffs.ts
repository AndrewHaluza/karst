/** The diffs variants (ui:VISUAL-VARIANTS). */
import { diffsRenderFixtures } from '../../../src/ui/diffs/renderFixtures.js';
import { getCorpus } from '../corpora.js';
import {
  ALL_THEMES,
  LOADING,
  fixtureCorpus,
  variant,
  type Variant,
  type ViewCorpus,
} from '../variantCore.js';

export const diffsVariants = (): Variant[] => {
  const d = fixtureCorpus.bind(null, 'diffs', diffsRenderFixtures as () => readonly { scenario: string; state: unknown }[]);
  const populated = d('populated');
  return [
    variant('diffs', 'populated', () => getCorpus('diffs'), { baseline: 'diffs', themes: ALL_THEMES }),
    // T1298: one worktree with one commit and no pending changes — the singular count texts.
    variant('diffs', 'one-commit', d('one-commit'), { skipLayout: true }),
    variant('diffs', 'empty', d('empty')),
    variant('diffs', 'clean', d('clean')),
    variant('diffs', 'loading', LOADING),
    variant('diffs', 'error', d('error')),
    variant('diffs', 'refresh-failed', () => ({
      messages: [...populated().messages, { type: 'error', message: 'git exited with code 128' }],
    })),
    // DF-11: 1,500 files, 200 rows rendered per group until "Show all files".
    variant('diffs', 'many-files', d('many')),
    variant('diffs', 'long-content', d('hostile')),
    // DF-21: the narrow (400-699) and tight (<=399) tiers, where the header actions wrap and the indents stop.
    variant('diffs', 'diffs-narrow', () => getCorpus('diffs'), { width: 500 }),
    variant('diffs', 'diffs-tight', () => getCorpus('diffs'), { width: 360 }),
  ];
};
