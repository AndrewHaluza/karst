import { describe, expect, it } from 'vitest';
import { viewsMissingVariantUpdate } from './variantTouch.js';

describe('viewsMissingVariantUpdate', () => {
  it('warns for a view source change with no registry or baseline change', () => {
    expect(viewsMissingVariantUpdate(['src/ui/usage/webview.html'])).toEqual(['usage']);
  });

  it('is silent when the registry changed', () => {
    expect(viewsMissingVariantUpdate(['src/ui/usage/webview.html', 'tests/visual/variants.ts'])).toEqual([]);
  });

  it('is silent when a baseline changed', () => {
    expect(viewsMissingVariantUpdate(['src/ui/usage/webview.html', 'tests/visual/__baselines__/dark/usage.png'])).toEqual([]);
  });

  it('ignores test files and non-view paths', () => {
    expect(viewsMissingVariantUpdate(['src/ui/usage/webview.test.ts', 'src/ui/session.ts'])).toEqual([]);
  });
});
