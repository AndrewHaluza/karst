/**
 * Review warning (ui:README-ORDER step 4): a change under src/ui/<view>/** that
 * touches neither the variant registry nor that view's baselines. Pure so the
 * review step can feed it `git diff --name-only <base>...HEAD`.
 */
import { WEBVIEW_NAMES, type WebviewName } from '../../src/model/webviewChains.js';

const REGISTRY = 'tests/visual/variants.ts';
const BASELINES = 'tests/visual/__baselines__/';

export function viewsMissingVariantUpdate(changedFiles: readonly string[]): WebviewName[] {
  if (changedFiles.includes(REGISTRY)) return [];
  const baselineTouched = changedFiles.some((f) => f.startsWith(BASELINES));
  if (baselineTouched) return [];
  return WEBVIEW_NAMES.filter((view) => changedFiles.some((f) => f.startsWith(`src/ui/${view}/`) && !/\.test\.[tj]sx?$/.test(f)));
}
