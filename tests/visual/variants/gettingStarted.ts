/** The getting-started variants (ui:VISUAL-VARIANTS). */
import { gettingStartedRenderFixtures } from '../../../src/ui/gettingStarted/renderFixtures.js';
import { getCorpus } from '../corpora.js';
import {
  ALL_THEMES,
  LOADING,
  fixtureCorpus,
  variant,
  type Variant,
  type ViewCorpus,
} from '../variantCore.js';

export const gettingStartedVariants = (): Variant[] => {
  const g = fixtureCorpus.bind(null, 'gettingStarted', gettingStartedRenderFixtures as () => readonly { scenario: string; state: unknown }[]);
  return [
    variant('gettingStarted', 'populated', () => getCorpus('gettingStarted'), { baseline: 'gettingStarted', themes: ALL_THEMES }),
    variant('gettingStarted', 'empty', g('empty')),
    variant('gettingStarted', 'loading', LOADING),
    variant('gettingStarted', 'error', () => ({ messages: [{ type: 'state-error', message: 'spawn git ENOENT' }] })),
    variant('gettingStarted', 'fresh', g('fresh')),
    variant('gettingStarted', 'returning', g('returning')),
    variant('gettingStarted', 'agent-missing', g('agent-missing')),
    variant('gettingStarted', 'long-content', g('hostile')),
    variant('gettingStarted', 'complete', g('complete')),
  ];
};
