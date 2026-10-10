/**
 * Project `layout-setup`: clears the shard directory before any layout test, so
 * a filtered run after a full run evaluates only the filtered routes.
 */
import { test } from '@playwright/test';
import { resetShards } from './layoutShards.js';

test('clear layout shards', () => {
  resetShards();
});
