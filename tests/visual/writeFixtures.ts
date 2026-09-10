/**
 * Entry point for the fixture writer, called by serve.mjs at startup.
 * Exits non-zero if fixture generation fails.
 */
import { writeFixtures } from './buildFixture.js';

try {
  writeFixtures();
  console.log('Fixtures written successfully.');
} catch (err) {
  console.error('Failed to write fixtures:', err);
  process.exit(1);
}
