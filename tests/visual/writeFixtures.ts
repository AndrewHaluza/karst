/**
 * Entry point for the fixture writer, called by serve.mjs at startup.
 * Writes the pages of the views in KARST_VISUAL_FIXTURE_VIEWS (all when unset; @ui:FIXTURE-SCOPE).
 * Exits non-zero if fixture generation fails.
 */
import { writeFixtures } from './buildFixture.js';
import { ALL_VIEWS } from './corpora.js';
import { fixtureViewsFromEnv } from './fixtureScope.js';

try {
  const { views, warning } = fixtureViewsFromEnv(process.env);
  if (warning !== null) console.error(warning);
  console.log(`Fixture views: ${views === ALL_VIEWS ? 'all' : views.join(', ')}`);
  writeFixtures(undefined, views);
  console.log('Fixtures written successfully.');
} catch (err) {
  console.error('Failed to write fixtures:', err);
  process.exit(1);
}
