/** The resources variants (ui:VISUAL-VARIANTS). */
import { fixtureMessages, resourcesRenderFixtures, type ResourcesScenario } from '../../../src/ui/resources/renderFixtures.js';
import { getCorpus } from '../corpora.js';
import {
  ALL_THEMES,
  LOADING,
  fixtureCorpus,
  variant,
  type Variant,
  type ViewCorpus,
} from '../variantCore.js';

export const resourcesVariants = (): Variant[] => {
  const r = fixtureCorpus.bind(null, 'resources', resourcesRenderFixtures as () => readonly { scenario: string; state: unknown }[]);
  /**
   * The Servers-tab fixtures carry three host messages (`state`, `servers`,
   * `show-tab`); `fixtureCorpus` sends only `state`, which renders the Resources
   * tab. T1317 RS-10: the Servers tab had no baseline at all.
   */
  const s = (scenario: ResourcesScenario): (() => ViewCorpus) => () => {
    const hit = resourcesRenderFixtures().find((f) => f.scenario === scenario);
    if (!hit) throw new Error(`resources: no '${scenario}' render fixture`);
    return { messages: fixtureMessages(hit) };
  };
  return [
    variant('resources', 'populated', () => getCorpus('resources'), { baseline: 'resources', themes: ALL_THEMES }),
    variant('resources', 'empty', r('idle')),
    variant('resources', 'loading', LOADING),
    variant('resources', 'error', r('degraded')),
    variant('resources', 'long-content', r('hostile')),
    variant('resources', 'unsupported', r('unsupported')),
    variant('resources', 'waste', r('waste')),
    variant('resources', 'unattributed', r('unattributed')),
    // T1317 RS-10: the Servers tab, which had no baseline at all. Mixed is the full page in every
    // theme, plus grayscale for the status marks (@ui:UI-R28); a failed start shows its reason in
    // all three themes (RS-2). `dark-grayscale` and `dark-reduced-motion` re-make the two stale
    // resources baselines an older sweep left behind.
    variant('resources', 'servers-mixed', s('servers-mixed'), { themes: [...ALL_THEMES, 'dark-grayscale'] }),
    variant('resources', 'servers-none', s('servers-none')),
    variant('resources', 'servers-done', s('servers-done')),
    variant('resources', 'servers-unavailable', s('servers-unavailable')),
    variant('resources', 'servers-hostile', s('servers-hostile')),
    variant('resources', 'servers-failed', s('servers-failed'), { themes: ALL_THEMES }),
    variant('resources', 'servers-crashed', s('servers-crashed')),
    variant('resources', 'servers-starting', s('servers-starting'), { themes: ['dark', 'dark-reduced-motion'] }),
  ];
};
