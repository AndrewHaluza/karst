/**
 * Project `layout-setup`: clears the shard directory before any layout test, so
 * a filtered run after a full run evaluates only the filtered routes.
 *
 * In the CI merge run (KARST_LAYOUT_MERGE=1, see layoutShards.ts) the shard
 * files are the downloaded output of the layout CI shards: setup keeps them.
 */
import { test } from '@playwright/test';
import { isMergeRun, resetShards } from './layoutShards.js';

test('clear layout shards', () => {
  if (!isMergeRun()) resetShards();
});
