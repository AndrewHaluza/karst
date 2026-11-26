/** The usage variants (ui:VISUAL-VARIANTS). */
import { usageRenderFixtures } from '../../../src/ui/usage/renderFixtures.js';
import { showcaseCorpus } from '../dbCorpus/showcase.js';
import {
  ALL_THEMES,
  LOADING,
  fixtureCorpus,
  variant,
  type Variant,
  type ViewCorpus,
} from '../variantCore.js';

export const usageVariants = (): Variant[] => {
  const u = fixtureCorpus.bind(null, 'usage', usageRenderFixtures as () => readonly { scenario: string; state: unknown }[]);
  // T1365: the showcase page is the DB-built usage state (see the exporter), sanitized; the width tiers share it.
  const populated = (): ViewCorpus => showcaseCorpus('usage');
  return [
    variant('usage', 'populated', populated, { baseline: 'usage', themes: ALL_THEMES }),
    // T1302 tiers (@ui:RD-TIERS): a tier variant differs only in width, so it shares the populated layout run.
    variant('usage', 'populated-narrow', populated, { width: 500 }),
    variant('usage', 'populated-tight', populated, { width: 360 }),
    variant('usage', 'empty', u('empty')),
    variant('usage', 'loading', LOADING),
    variant('usage', 'error', u('error')),
    variant('usage', 'long-content', u('hostile')),
    variant('usage', 'paged', u('paged-middle')),
    variant('usage', 'sorted', u('all-sorts')),
    // T1302 US-35: the real long key at wide (1280) and mid (800); the two share one layout run.
    variant('usage', 'long-key', u('long-key'), { width: 1280 }),
    variant('usage', 'long-key-mid', u('long-key'), { width: 800 }),
    // T1302 US-2: a host failure states the error and one way forward instead of a blank page.
    variant('usage', 'host-failure', u('host-failure')),
    // T1302 US-10/US-19: the near state at every theme, plus the grayscale audit; exhausted in both.
    variant('usage', 'quota-near', u('quota-near'), { themes: [...ALL_THEMES, 'dark-grayscale'] }),
    variant('usage', 'quota-exhausted', u('quota-exhausted'), { themes: ['dark', 'dark-grayscale'] }),
    variant('usage', 'quota-expired', u('quota-expired')),
    variant('usage', 'quota-stale', u('quota-stale')),
    variant('usage', 'quota-empty', u('quota-empty')),
    variant('usage', 'quota-tight', u('quota-near'), { width: 360 }),
  ];
};
